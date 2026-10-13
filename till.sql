-- ZAKA FASHION / LIVE PHONE SCANNER + CASHIER TILL
-- Run AFTER supabase.sql. Does not change or delete existing products.
-- Scanner and cashier are authenticated Zaka Fashion staff. No anonymous access.

create table if not exists public.zf_till_sessions (
  id uuid primary key default gen_random_uuid(),
  cashier_id uuid not null references auth.users(id),
  scanner_id uuid references auth.users(id),
  pairing_secret text not null unique default replace(gen_random_uuid()::text, '-', ''),
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create index if not exists zf_till_sessions_cashier_idx on public.zf_till_sessions(cashier_id, created_at desc);

create table if not exists public.zf_till_scans (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.zf_till_sessions(id) on delete cascade,
  barcode text not null check (char_length(barcode) between 3 and 100),
  scanned_by uuid not null default auth.uid() references auth.users(id),
  scanned_at timestamptz not null default now()
);
create index if not exists zf_till_scans_session_idx on public.zf_till_scans(session_id, id);

create table if not exists public.zf_till_sales (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.zf_till_sessions(id),
  cashier_id uuid not null references auth.users(id),
  payment_method text not null default 'yoco_external',
  payment_reference text not null default '',
  amount numeric(12,2) not null check(amount >= 0),
  idempotency_key uuid not null unique,
  created_at timestamptz not null default now()
);
create table if not exists public.zf_till_sale_items (
  id bigint generated always as identity primary key,
  sale_id uuid not null references public.zf_till_sales(id) on delete cascade,
  product_id uuid not null references public.zf_products(id),
  name text not null,
  barcode text not null,
  colour text not null default '',
  size text not null default '',
  quantity integer not null check(quantity > 0),
  unit_price numeric(12,2) not null,
  line_total numeric(12,2) not null
);

alter table public.zf_till_sessions enable row level security;
alter table public.zf_till_scans enable row level security;
alter table public.zf_till_sales enable row level security;
alter table public.zf_till_sale_items enable row level security;

-- Only the cashier owning a till or its paired scanner can view a session.
drop policy if exists zf_till_sessions_read on public.zf_till_sessions;
create policy zf_till_sessions_read on public.zf_till_sessions for select to authenticated
using (public.zf_is_staff() and (cashier_id = (select auth.uid()) or scanner_id = (select auth.uid())));
drop policy if exists zf_till_sessions_create on public.zf_till_sessions;
create policy zf_till_sessions_create on public.zf_till_sessions for insert to authenticated
with check (public.zf_is_staff() and cashier_id = (select auth.uid()) and scanner_id is null and status = 'open');
-- Never grant direct update/delete: joining and closing run through verified RPCs.

drop policy if exists zf_till_scans_read on public.zf_till_scans;
create policy zf_till_scans_read on public.zf_till_scans for select to authenticated
using (public.zf_is_staff() and exists (
  select 1 from public.zf_till_sessions s where s.id = session_id
  and (s.cashier_id = (select auth.uid()) or s.scanner_id = (select auth.uid()))
));
drop policy if exists zf_till_scans_insert on public.zf_till_scans;
create policy zf_till_scans_insert on public.zf_till_scans for insert to authenticated
with check (public.zf_is_staff() and scanned_by = (select auth.uid()) and exists (
  select 1 from public.zf_till_sessions s where s.id = session_id
  and s.scanner_id = (select auth.uid()) and s.status = 'open'
  and s.created_at > now() - interval '12 hours'
));

drop policy if exists zf_till_sales_read on public.zf_till_sales;
create policy zf_till_sales_read on public.zf_till_sales for select to authenticated
using (public.zf_is_staff() and (cashier_id = (select auth.uid()) or public.zf_can_edit()));
drop policy if exists zf_till_sale_items_read on public.zf_till_sale_items;
create policy zf_till_sale_items_read on public.zf_till_sale_items for select to authenticated
using (public.zf_is_staff() and exists (
 select 1 from public.zf_till_sales s where s.id = sale_id
 and (s.cashier_id = (select auth.uid()) or public.zf_can_edit())
));

revoke all on public.zf_till_sessions from public, anon, authenticated;
revoke all on public.zf_till_scans from public, anon, authenticated;
revoke all on public.zf_till_sales from public, anon, authenticated;
revoke all on public.zf_till_sale_items from public, anon, authenticated;
grant select, insert on public.zf_till_sessions to authenticated;
grant select, insert on public.zf_till_scans to authenticated;
grant usage, select on sequence public.zf_till_scans_id_seq to authenticated;
grant select on public.zf_till_sales to authenticated;
grant select on public.zf_till_sale_items to authenticated;

-- Pair a phone by the long random secret displayed as QR on the cashier screen.
create or replace function public.zf_join_till(p_secret text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_id uuid;
begin
  if v_user is null or not public.zf_is_staff() then
    raise exception 'Only authorised Zaka Fashion staff can pair a scanner.';
  end if;
  if length(coalesce(p_secret,'')) != 32 then
    raise exception 'Invalid pairing link.';
  end if;
  update public.zf_till_sessions s set scanner_id = v_user
  where s.pairing_secret = p_secret and s.status = 'open'
    and s.created_at > now() - interval '12 hours'
    and (s.scanner_id is null or s.scanner_id = v_user)
  returning s.id into v_id;
  if v_id is null then
    raise exception 'This till is already paired, closed or the link has expired. Open a fresh till.';
  end if;
  return v_id;
end;
$$;

create or replace function public.zf_close_till(p_session_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.zf_is_staff() then
    raise exception 'Staff sign-in required.';
  end if;
  update public.zf_till_sessions set status = 'closed', closed_at = now()
  where id = p_session_id and cashier_id = auth.uid() and status = 'open';
  return found;
end;
$$;

-- Sale recording is atomic: locks products, checks stock, calculates server-side prices,
-- decrements quantities and writes a receipt. Repeating an idempotency key cannot resell.
-- It DOES NOT charge a bank card or verify a Yoco payment.
create or replace function public.zf_complete_till_sale(
  p_session_id uuid,
  p_items jsonb,
  p_idempotency_key uuid,
  p_payment_reference text default ''
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_sale uuid;
  v_item record;
  v_product public.zf_products%rowtype;
  v_total numeric(12,2) := 0;
  v_count integer;
begin
  if v_user is null or not public.zf_is_staff() then
    raise exception 'Staff sign-in required.';
  end if;
  if not exists (select 1 from public.zf_till_sessions
     where id = p_session_id and cashier_id = v_user and status = 'open') then
    raise exception 'Your till session is no longer open.';
  end if;
  if p_idempotency_key is null then raise exception 'A checkout reference is required.'; end if;
  select s.id into v_sale from public.zf_till_sales s
   where s.idempotency_key = p_idempotency_key and s.cashier_id = v_user;
  if v_sale is not null then return v_sale; end if;
  if jsonb_typeof(p_items) is distinct from 'array'
    or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 150 then
    raise exception 'Sale must contain between 1 and 150 items.';
  end if;
  insert into public.zf_till_sales(session_id, cashier_id, idempotency_key, payment_reference, amount)
   values (p_session_id, v_user, p_idempotency_key, left(trim(coalesce(p_payment_reference,'')),120), 0)
   returning id into v_sale;
  -- Lock product rows in deterministic ID order to reduce deadlock risk.
  for v_item in
    select (value->>'id')::uuid as product_id, sum((value->>'quantity')::int) as qty
    from jsonb_array_elements(p_items) value
    group by 1 order by 1
  loop
    if v_item.qty is null or v_item.qty < 1 or v_item.qty > 1000 then
      raise exception 'Invalid quantity.';
    end if;
    select * into v_product from public.zf_products
      where id = v_item.product_id and status = 'active' for update;
    if not found then raise exception 'A selected product is not available.'; end if;
    if v_product.quantity < v_item.qty then
      raise exception 'Insufficient stock for %: % available.', v_product.name, v_product.quantity;
    end if;
    update public.zf_products set quantity = quantity - v_item.qty where id = v_product.id;
    insert into public.zf_till_sale_items(sale_id,product_id,name,barcode,colour,size,quantity,unit_price,line_total)
      values(v_sale,v_product.id,v_product.name,v_product.barcode,v_product.colour,v_product.size,
             v_item.qty,v_product.price,v_item.qty*v_product.price);
    v_total := v_total + (v_item.qty*v_product.price);
  end loop;
  update public.zf_till_sales set amount = v_total where id = v_sale;
  return v_sale;
end;
$$;

revoke all on function public.zf_join_till(text) from public, anon;
revoke all on function public.zf_close_till(uuid) from public, anon;
revoke all on function public.zf_complete_till_sale(uuid,jsonb,uuid,text) from public, anon;
grant execute on function public.zf_join_till(text) to authenticated;
grant execute on function public.zf_close_till(uuid) to authenticated;
grant execute on function public.zf_complete_till_sale(uuid,jsonb,uuid,text) to authenticated;

-- Enable Realtime events. The cashier also polls as a fallback when WebSockets are blocked.
do $$ begin
 if exists (select 1 from pg_publication where pubname='supabase_realtime')
   and not exists (select 1 from pg_publication_tables
     where pubname='supabase_realtime' and schemaname='public' and tablename='zf_till_scans') then
     alter publication supabase_realtime add table public.zf_till_scans;
 end if;
end $$;

-- ZAKA FASHION · Barcode & Product Catalogue
-- Run once in Supabase SQL Editor in project oyxgjjzvfjzgzlwqwegv.
-- Does not modify unrelated project tables.

create table if not exists public.zf_staff (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default 'Staff member',
  role text not null default 'staff' check (role in ('admin', 'manager', 'staff')),
  created_at timestamptz not null default now()
);

create or replace function public.zf_is_staff()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.zf_staff where user_id = (select auth.uid()));
$$;

create or replace function public.zf_can_edit()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.zf_staff
    where user_id = (select auth.uid()) and role in ('admin','manager')
  );
$$;

create or replace function public.zf_is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.zf_staff
    where user_id = (select auth.uid()) and role = 'admin'
  );
$$;

revoke all on function public.zf_is_staff() from public, anon;
revoke all on function public.zf_can_edit() from public, anon;
revoke all on function public.zf_is_admin() from public, anon;
grant execute on function public.zf_is_staff() to authenticated;
grant execute on function public.zf_can_edit() to authenticated;
grant execute on function public.zf_is_admin() to authenticated;

create table if not exists public.zf_products (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 2 and 160),
  brand text not null default 'Zaka Fashion',
  category text not null default 'Clothing',
  colour text not null default '',
  size text not null default '',
  description text not null default '',
  price numeric(12,2) not null check (price >= 0),
  cost_price numeric(12,2) check (cost_price is null or cost_price >= 0),
  quantity integer not null default 0 check (quantity between 0 and 1000000),
  low_stock_at integer not null default 5 check (low_stock_at between 0 and 1000000),
  sku text not null unique,
  barcode text not null unique,
  status text not null default 'active' check (status in ('active','archived')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Barcode and SKU are allocated by Postgres, not by the browser; both remain stable on edits.
create or replace function public.zf_products_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.barcode := 'ZF' || upper(left(replace(pg_catalog.gen_random_uuid()::text, '-', ''), 14));
    new.sku := new.barcode;
    new.created_by := (select auth.uid());
  else
    new.barcode := old.barcode;
    new.sku := old.sku;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists zf_products_guard_trg on public.zf_products;
create trigger zf_products_guard_trg before insert or update on public.zf_products
for each row execute function public.zf_products_guard();

create index if not exists zf_products_name_idx on public.zf_products (name);
create index if not exists zf_products_status_idx on public.zf_products (status);
create index if not exists zf_products_created_idx on public.zf_products (created_at desc);

alter table public.zf_staff enable row level security;
alter table public.zf_products enable row level security;

-- Staff can see their own entry; admins can see/manage all staff.
drop policy if exists "zf_staff_read" on public.zf_staff;
create policy "zf_staff_read" on public.zf_staff
for select to authenticated using (user_id = (select auth.uid()) or public.zf_is_admin());

drop policy if exists "zf_staff_insert" on public.zf_staff;
create policy "zf_staff_insert" on public.zf_staff
for insert to authenticated with check (public.zf_is_admin());

drop policy if exists "zf_staff_update" on public.zf_staff;
create policy "zf_staff_update" on public.zf_staff
for update to authenticated using (public.zf_is_admin()) with check (public.zf_is_admin());

drop policy if exists "zf_staff_delete" on public.zf_staff;
create policy "zf_staff_delete" on public.zf_staff
for delete to authenticated using (public.zf_is_admin());

-- All authorized Zaka Fashion staff can browse products; managers/admins edit.
drop policy if exists "zf_products_read" on public.zf_products;
create policy "zf_products_read" on public.zf_products
for select to authenticated using (public.zf_is_staff());

drop policy if exists "zf_products_insert" on public.zf_products;
create policy "zf_products_insert" on public.zf_products
for insert to authenticated with check (public.zf_can_edit());

drop policy if exists "zf_products_update" on public.zf_products;
create policy "zf_products_update" on public.zf_products
for update to authenticated using (public.zf_can_edit()) with check (public.zf_can_edit());

drop policy if exists "zf_products_delete" on public.zf_products;
create policy "zf_products_delete" on public.zf_products
for delete to authenticated using (public.zf_is_admin());

revoke all on public.zf_products from anon, public;
revoke all on public.zf_staff from anon, public;
grant select, insert, update, delete on public.zf_products to authenticated;
grant select, insert, update, delete on public.zf_staff to authenticated;

-- BOOTSTRAP YOUR FIRST ADMIN, AFTER CREATING THEIR USER IN AUTH > USERS:
-- Replace the email below and REMOVE the leading -- from the INSERT statement.
-- insert into public.zf_staff (user_id, full_name, role)
-- select id, 'Zaka Fashion Administrator', 'admin'
-- from auth.users where lower(email) = lower('admin@example.com')
-- on conflict (user_id) do update set full_name = excluded.full_name, role = 'admin';
-- IMPORTANT: Keep bootstrap SQL in SQL Editor; never put an admin bootstrap in the website.

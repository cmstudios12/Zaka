# Zaka Fashion — Barcode & Inventory Studio

**Version:** 1.1 (barcode studio + live cashier companion)

Files:
- `index.html` — single-file responsive application with HTML, CSS and JavaScript; project connection is already configured.
- `supabase.sql` — database schema, staff authorization, database-generated barcode/SKU and row-level security.

## 1. Install the database

1. Open [Supabase SQL Editor](https://supabase.com/dashboard/project/oyxgjjzvfjzgzlwqwegv/sql/new) in the provided project.
2. Paste and run the complete contents of `supabase.sql`.
3. Check that **Table Editor** now contains `zf_products` and `zf_staff`.
4. This script deliberately uses `zf_` names, so it does not drop or edit other tables.

## 2. Create the first administrator

1. In the Supabase Dashboard open **Authentication → Users → Add User**.
2. Create a user using the desired administrator email and a strong unique password. Confirm the email in the dashboard or complete verification if needed.
3. Run this in SQL Editor, changing **admin@example.com** to the exact administrator email:

```sql
insert into public.zf_staff (user_id, full_name, role)
select id, 'Zaka Fashion Administrator', 'admin'
from auth.users
where lower(email) = lower('admin@example.com')
on conflict (user_id) do update
set full_name = excluded.full_name, role = 'admin';
```

4. To check the user was assigned, run:

```sql
select s.full_name, s.role, u.email
from public.zf_staff s
join auth.users u on u.id = s.user_id;
```

If the first `INSERT` reports success but adds zero rows, double-check that the Auth user exists and the email exactly matches.

### Additional staff

Create each user in Authentication first; then run the same SQL statement with the user's email, a display name, and `role = 'manager'` or `role = 'staff'`.

- **admin** and **manager**: can register, edit and archive products.
- **staff**: can view products, export CSV files and print labels, but cannot change products.
- **admin**: can manage staff records, currently through the Supabase dashboard / SQL Editor.

Do not allow public users to self-register as store staff. Authorization is checked server-side with Supabase RLS.

## 3. Open the website

The `index.html` file already contains your Supabase project URL and **publishable key**, and uses Supabase Authentication. Host it on an HTTPS site (e.g. GitHub Pages, Netlify or your own domain). With an active internet connection, it loads Supabase JS, Lucide icons and JsBarcode from their respective CDNs. Login with the newly created administrator credentials.

You may open the file locally for a quick check, but hosting it over HTTPS is recommended for normal store use.

## 4. Add products and print labels

1. Open **Products & stock → Add product**.
2. Enter a clothing name, category, colour, size, selling price and manually recorded stock.
3. Save. Supabase generates a unique stable Code 128 barcode and matching SKU.
4. Create separate product entries for each distinct size/colour combination. Multiple identical units of the same variant share one barcode; use **Units in stock** to specify their quantity.
5. Click the barcode icon beside a product to queue a label, then open **Barcode labels**.
6. Choose A4 sheets or 50 × 30 mm thermal labels; print a test and adjust the printer's settings as needed.

## 5. Prepare the Yoco POS catalogue

See [Yoco official bulk upload instructions](https://support.yoco.help/en/articles/396957-how-to-create-your-product-catalogue-bulk-upload).

1. In Yoco, go to **Manage → Products → Upload in bulk → Download CSV template**.
2. In this app, open **Yoco & exports**, upload that blank `.csv` file, and click **Prepare using Yoco template**.
3. Review the generated file. Make sure variant groups, prices, product names and barcode fields meet Yoco's current requirements.
4. Import it using the Yoco App. Test a product by scanning its label with a compatible Yoco barcode scanner before printing your entire catalogue.

**Existing Yoco products:** Do not blindly import the generated file if the products already exist in Yoco; blank Product IDs may create duplicates. Instead, export your existing Yoco catalogue and fill its Barcode column against existing Product IDs, then re-import that updated Yoco export. The app does not yet automatically merge with existing Yoco exports.

## Scope & limitations of this first version

- This app provides product records, **manual** stock quantities, low-stock indicators, Code 128 labels and CSV preparation.
- The original `index.html` is the catalogue and label manager; the new `till.html` is a separate cashier basket and sale-recording companion. Yoco remains responsible for payment acceptance and its own sales reporting.
- There is **no real-time Yoco API synchronization** of products, payments or inventory. Sales recorded through `till.html` decrease Zaka Fashion stock, but sales made only through Yoco do not affect this database.
- The barcodes are internal store identifiers, not registered GS1/EAN/UPC retail numbers.
- The generated Yoco CSV must be reviewed and validated in Yoco; official templates, variants and business catalogue settings can differ.
- Print dimensions depend on browser print settings, printer and label roll. Test one label first.
- The UI workflows have been tested locally with mocked database responses; live Supabase, Yoco imports and physical barcode-scanner compatibility still need an on-site pilot.

**Security:** Your `sb_publishable_...` key may be in a browser frontend because data access is restricted through Supabase RLS. Do not add any `sb_secret_...`, service-role key or other private credentials to `index.html`.

---

## 6. Live phone scanner + cashier till (new)

The download also contains:

- `till.sql` — add-on database tables, staff-only pairing and scanning permissions, realtime subscription, transactional sale recording.
- `till.html` + `till.js` — cashier checkout screen for a desktop or tablet.
- `scanner.html` + `scanner.js` — fast smartphone camera scanner, Code 128 support.
- `till.css` — shared responsive styling for the two screens.

### Install the add-on

1. **First** ensure the original `supabase.sql` is already installed, and you have at least one authorised user in `zf_staff`.
2. Open [Supabase SQL Editor](https://supabase.com/dashboard/project/oyxgjjzvfjzgzlwqwegv/sql/new) and run the **complete `till.sql`**. It creates four new prefixed tables and functions. Existing products and barcodes are not altered.
3. Upload **all** the website files to the **same HTTPS folder** on your host; do not upload only one HTML file. The phone camera usually cannot work from `file://` or insecure HTTP.
4. Open `https://YOUR-SITE/till.html` on the cashier's computer and sign in using a Zaka Fashion staff account.
5. The till displays a **pairing QR**. Scan this QR using the phone's **regular camera app** to open `scanner.html?pair=…`, then sign in on the phone with an authorised `zf_staff` user (can be the same account when testing).
6. Tap **Start camera** in `scanner.html` and grant camera permission. Point it at a **Code 128 label already printed from the admin dashboard**. The product name, size/colour, price and quantity are shown on the phone, and the product automatically appears on the cashier basket.
7. To test connection before trying camera hardware, enter a real barcode such as `ZF…` (copy from Products & stock) in **Manual barcode entry** on the phone and tap Send. There is no demo barcode hardcoded in the system.
8. Scanning the same visible code repeatedly is temporarily limited to avoid accidental duplicate additions. Tap **Add one more of this item** to add another unit instantly.
9. If you want to test **without changing stock**, stop here! The scan and basket process does not alter inventory.
10. For an actual completed sale: take payment using **Yoco outside this app**; once Yoco confirms successful payment, tap **Record paid sale** on the cashier screen. The database validates stock, records the sale and decrements local product quantities atomically. Do not mark an unpaid basket as paid.

### Important limitations

- **Phone-to-Zaka-till** is realtime through Supabase (with periodic polling fallback). **Phone-to-Yoco-POS** is NOT implemented; the phone cannot automatically insert a product into Yoco's native till interface with this code. Yoco API/compatibility would need separate confirmation and authorised integration.
- The mobile scanner reads Code 128, Code 39 and some common retail barcode formats. Scan performance depends on camera, lighting, print contrast, focus and internet latency. It is not guaranteed to be as fast as a dedicated hardware scanner.
- Both devices must be online and logged in with authorised Zaka Fashion staff accounts. Pairing uses a time-limited, random 128-bit link. Only one paired scanner at a time per cashier session; use **New till session** to pair a different phone.
- Do not share the pairing QR or link publicly. It grants session pairing **only to authenticated staff**.
- The database transaction reduces **Zaka Fashion local stock only**. Yoco maintains its own stock. If both systems track inventory, you must reconcile the two.
- The `Record paid sale` button **does not** collect money or verify payment with Yoco. `payment_reference` is optional free text for staff to enter a known Yoco receipt reference.
- Admin/manager can add products in `index.html`; staff can use the cashier and mobile scanner (if in `zf_staff`).
- Secure the host and verify your Supabase Auth and RLS configuration before real commercial use. This is a functional pilot, not a certified financial POS product.

### Quick troubleshooting

- *Camera not opening*: host all files at **HTTPS** (localhost is an exception), grant browser camera permission, and try Chrome on Android or Safari on iOS.
- *Can't connect*: run `till.sql`, verify both users are in `zf_staff`, start a fresh till session, scan its current QR, and ensure both devices are online.
- *Product not found*: copy the exact barcode from `index.html`, make sure the product is **active**, and verify the scanner and admin use the same Supabase project.
- *Scan arrives but doesn't add*: check stock quantity. The basket prevents adding more units than your local available count.
- *No realtime updates*: wait 1–2 seconds for the polling fallback. Database publication setup is included in `till.sql`.
- *Unknown Yoco support*: barcode scans work in our Zaka Fashion cashier screen, not inside Yoco's actual POS app.

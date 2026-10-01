# Groovy Fragrances Kiosk

A mobile-first billing and stock app for the Groovy Fragrances kiosks. It handles billing with barcode scanning, loose attar sold by ml or tola, GST invoices, split payments, stock, expenses, and reports that show each salesperson's sales.

**How it fits together**

```
Staff phones (installed app)  ──►  Google Apps Script (backend)  ──►  Google Sheet (all your data)
   hosted free on GitHub Pages        checks login, prices, stock        one tab per table
```

- **All data lives in your Google Sheet.** GitHub only hosts the app's screens, not the data.
- **Every request needs a login.** Roles and prices are always checked on the server, so a phone cannot change them.
- **Four roles:**
    - **Owner**: everything.
    - **Manager**: stock, returns of any size, expenses, reports.
    - **Salesperson**: billing, with a discount limit, and returns up to a rupee limit you set.
    - **Stock Mover**: sees products and stock at the branches you tick, and moves stock between branches. No billing, and no sales, customers, expenses or reports.
    - Owner, managers and salespeople can all sell, and every bill records who sold it.

---

## Before you start

- **One Google account that owns everything.** It will own the Sheet and the script, and the day-close emails are sent from it.
    - Use a shop account (for example a new Gmail made for the shop), not a staff member's personal account.
    - Setup makes this account's email the first Owner login, and "Forgot password" codes are sent to it.
- **A GitHub account.** It's free.
- **Cost:** nothing. Google Sheets, Apps Script and GitHub Pages (with a public repository) are all free.

## 1. Create the database and backend (Google)

1. Open [sheets.new](https://sheets.new) and name the sheet **Groovy Kiosk Data**.
2. Go to **Extensions → Apps Script**. This opens a script project linked to the sheet.
3. Add the backend code. There are two ways:
    - **Copy and paste (simplest).** For each `.gs` file in `backend/`:
        - Click **＋ → Script**.
        - Give it the same name without `.gs`.
        - Paste in the file's contents.
        - Delete the default `Code.gs`.
        - Then go to **Project Settings ⚙ → Show "appsscript.json"**, open `appsscript.json` and replace its contents with `backend/appsscript.json`.
    - **Using clasp** (a command-line uploader; optional, handy for later updates):
        1. Turn on the **Google Apps Script API** at [script.google.com/home/usersettings](https://script.google.com/home/usersettings), signed in as the shop account. Without it, clasp fails. After switching it on, allow a few minutes before deploying.
        2. Install clasp and log in once per computer. In the browser, choose the **shop Google account**:
            ```bash
            npm install -g @google/clasp
            clasp login
            ```
        3. In the `backend/` folder, copy `.clasp.json.example` to `.clasp.json` (`copy` on Windows, `cp` on Mac/Linux). Replace `PASTE_YOUR_SCRIPT_ID_HERE` with the **Script ID** from Apps Script → ⚙ **Project Settings → IDs**. This file stays on your computer and is never uploaded to GitHub.
        4. From `backend/`, run `clasp push`. If it asks _"Manifest file has been updated. Do you want to push and overwrite?"_, answer **y**.
4. Go back to the sheet and reload the page. A **Groovy Kiosk** menu appears.
5. Click **Groovy Kiosk → 1. Setup / repair sheets**.
    - Google will ask for permission. Choose **Advanced → Go to project → Allow**.
    - Setup creates all the tabs.
    - It also shows an **Owner email and password**. The email is the Google account you're signed in with. Write these down.
    - After your first login, change the password straight away in **More → My account → Change password**.
6. Optional: click **Groovy Kiosk → Run self-tests**. You should see "All 35 tests passed".
7. Deploy the backend as a web app:
    - In Apps Script, click **Deploy → New deployment**.
    - Type: **Web app**.
    - Execute as: **Me**.
    - Who has access: **Anyone**.
    - Click **Deploy** and copy the **Web app URL** (it ends in `/exec`). You can see it again any time with **Groovy Kiosk → Show web app URL**.

> "Anyone" only means the URL can be reached. Nothing can be read or changed without a staff login.

## 2. Publish the phone app (GitHub Pages, free)

1. Create a **public** repository on GitHub, for example `groovy-kiosk`, and push **the contents of the `groovy-kiosk` folder** to it, so that `.github/`, `backend/` and `frontend/` sit at the top of the repository. If you push the parent folder instead, the deploy workflow won’t run.

    If you haven't used git before, run these from inside the `groovy-kiosk` folder:

    ```bash
    git init -b main
    git add .
    git commit -m "Groovy Kiosk"
    git remote add origin https://github.com/<your-github-username>/groovy-kiosk.git
    git push -u origin main
    ```

    - The repository is public, so anyone can read the code. That's safe: it holds no passwords or shop data, which stay in your Google Sheet.
    - `backend/.clasp.json` and backup folders (`bk/`) are excluded by `.gitignore`. Keep it that way.

2. In the repository, go to **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Go to **Settings → Secrets and variables → Actions → Variables → New repository variable**:
    - Name: `VITE_API_URL`
    - Value: the web app URL from step 1.7
4. Go to **Actions → Deploy app to GitHub Pages → Run workflow**. It takes about 1 minute.
    - The first run, started automatically by your push in step 1, fails because the variable wasn't set yet. That's expected; the run you start here is the one that counts.
5. Your app is live at `https://<your-github-username>.github.io/groovy-kiosk/`.

## 3. Install on each phone

- **Android (Chrome):** open the app URL, then **⋮ → Add to Home screen / Install app**.
- **iPhone (Safari):** open the app URL, then **Share → Add to Home Screen**.
- When you first tap the 📷 button, allow **camera access**.
- **Bluetooth barcode scanner:** pair it with the phone in keyboard (HID) mode. It works on the Sell and Stock In screens without tapping anything first.

## Returns and exchanges

Open the bill from **Sales**, then:

- **Return items** — pick what is coming back, how much of it, and whether each piece goes back on the
  shelf (untick that for a leaked bottle). Choose how the money goes back and give a reason. The app
  writes a **credit note**, puts the stock back and records the refund, all against the original bill.
- **Exchange** — for the commonest case: the customer brings something back and wants something else.
  Pick what is coming back, tap **Choose replacement**, and the app takes you to the usual Sell screen
  with the credit in hand. Scan or search the replacement as always. At **Checkout** the credit is
  taken off the new bill and you only collect the difference — or hand back the difference if the
  replacement costs less. Both documents are written together, so nothing can half-happen.

A few rules worth knowing:

- Both work only at the **branch that made the bill**, and only inside the **return window**
  (3 days by default). Past that, only the owner can accept it.
- A **salesperson** can accept a return up to the limit in Settings → Billing, counted across the whole
  bill. For an exchange that limit applies only to **cash they hand back** — an even swap, or one where
  the customer pays more, has no limit, because no money leaves the drawer.
- An exchange shows on the day close as its own line, **Exchange**, with matching in and out. Your cash
  figure is untouched by it, so the drawer still adds up.
- A bill part paid by an exchange **cannot be voided**. Use Return items on it instead.
- GST-wise this is the normal treatment: a credit note for what came back and a fresh invoice for what
  went out, in separate number series. Both appear in the GST report.

## Printing bills

The app prints an **80 mm receipt** or an **A4 tax invoice** using the phone's or laptop's normal print dialog.

- **Android with a Bluetooth or USB thermal printer:**
    - Chrome can only reach printers that have an Android _print service_. Install the printer maker's print-service app, or a general one such as **RawBT**.
    - In the print dialog, choose paper **80 mm**, margins **None**, and turn off headers and footers.
- **Laptop:** choose the printer and set the paper size to 80 mm (receipt) or A4 (invoice). Set margins to **None** and untick **Headers and footers**.
- **iPhone:** prints only to AirPrint printers. Otherwise use **WhatsApp** or **Share** to send the bill.

## 4. First day checklist

1. Log in as the owner, then open **More → Settings**:
    - **Shop** tab: enter the GSTIN, address and bill footer.
    - **Billing** tab: check the **salesperson discount limit**, the **most a salesperson may refund on one bill** (₹2,000 to begin with; 0 means only managers can accept returns), the **return window** and **1 tola = 12 ml**.
    - **Categories** tab: confirm the HSN codes and GST rates with your accountant.
    - You can add your own categories (e.g. _Bakhoor_) and hide ones you don't sell. A category can be deleted only if no product uses it.
2. Go to **More → Staff** and add managers and salespeople, each with their own email and password.
3. Add products. Either:
    - **Stock → Import**: download the template, fill it in Excel or Google Sheets, then upload it as CSV (**delete the template's sample rows first**). One row per size; rows with the same brand + product become sizes of one product.
        - **Required:** `product`, `category`, `sell_price`, and `size_label` for packed items.
        - **Optional:** `sku` (your item code, unique), `brand`, `gender` (men/women/unisex), `sale_type` (packed, or loose for attar sold per ml), `size_ml` (only for sorting sizes), `barcode` (must be unique), `mrp`, `cost`, `opening_stock` (goes to the branch you're working at), `reorder_level` (low-stock alert), `hsn` and `gst_rate` (default from the category), `image` (picture link), `sku`.
        - **Uploading again is safe.** A row that matches an existing size (same barcode, or same brand + product + size) **updates** its prices and details instead of adding a copy; blank cells keep the current value. Opening stock is only used for **new** sizes, so use **Stock In** for more stock.
        - Rows with a problem are skipped and listed (e.g. a barcode that belongs to a different product); the other rows still import.
        - **SKU** (your item code) works like the barcode: a row with a known SKU updates that size even if the name in the file is different — the name in the app is kept. SKUs must be unique; you can see and edit them on **Add/Edit product**, where the **#** button generates the next one in your website's `SKU-####` series. Use the same SKU on the website for that product.
        - **Website export:** you can upload the product export from your website (Clevup) exactly as downloaded. The app recognises it and uses SKU, barcode, name, size, sale price, MRP, purchase price, GST, brand, gender, HSN, the first image and quantity (as opening stock for new items only). New products go to **Packed Attar** if the name or website categories mention "attar", otherwise to **Eau De Parfum**; change it later if needed. Rows whose sale price excludes tax are skipped and listed.
    - **Stock → Add product**: scan the box barcode. For items without a barcode (loose attar, decants, bottles), tap the magic-wand button next to the barcode box to generate one.
4. **Stock → Stock In**: scan the boxes you receive. Scanning the same box again adds 1. On **Add product**, scanning only fills the Barcode box — to add stock always use **Stock In**.
5. Make a test sale, then **void** it from **Sales → bill → Void bill**. Voiding is only possible on the same day.

**Daily use**

- **Sell:** scan or tap items, then **View bill → Checkout**. Enter the customer's mobile number (optional), choose Cash, UPI or Card (tap **Split payment** to combine them), then tap **Complete**. Share the bill on WhatsApp or print it.
- **End of day:** go to **More → Reports → Day close**. It shows the cash you should have in the drawer and a breakdown by salesperson.

## Branches (more than one shop)

One app and one Google Sheet run every branch.

- **Shared by all branches:** the product list, barcodes, prices and customers.
- **Per branch:** stock, bills (each branch has its own bill number series), held bills, expenses and reports.

**Set up**

1. Go to **More → Settings → Branches**.
2. Rename "Main branch" (for example to _Kondhwa_).
3. Tap **Add branch** for each other shop:
    - **Name**, e.g. _Kalyani Nagar_.
    - **Bill code**, e.g. `KN`. Bills become `GFKN/26-27/00001` and returns `GFKNC/26-27/0001`. The main shop keeps `GF/26-27/00001`. The invoice prefix plus the code can be at most 4 characters, because GST limits bill numbers to 16 characters. A code can't change once the branch has bills.
    - **Address and phone**, printed on that branch's bills.
    - **Day-close emails** for that branch, e.g. its manager.
4. Go to **More → Staff** and set each person's **Home branch** and **Works at**. "Works at" is all branches by default; untick it to limit someone to certain shops.

**Daily use**

- **Choosing a branch:** the first time someone logs in on a phone, the app asks _"Where are you working today?"_. To switch later, tap the **📍 branch name** under the screen title. Each branch keeps its own bill in progress.
- **Selling:** sales, Stock In and adjustments always use the branch you're working at.
- **Transfers:** to move stock, go to **Stock → Transfer**. Scan the items and choose the branch to send them to. The stock moves immediately, and there's a record under **Stock → Transfers**.
- **Returns and voids:** only at the branch that made the bill.
- **The owner** can also pick **All branches** to see combined figures with a per-branch breakdown on Home and Day close. Selling isn't possible in that view.

If you have only one branch, none of this shows. The app works exactly like a single shop.

## Day-close emails

- **Email button (anyone):** go to **Reports → Day close → Email**.
    - A salesperson's email contains only their own sales. A manager's or the owner's covers the whole branch.
    - Tick **Send me a copy** to get a copy yourself.
    - Each person can send up to 5 of these a day.
- **Nightly email (owner, optional):** go to **More → Settings → Email**.
    - Turn **Nightly email On**, choose the hour, and choose whether to skip days with no sales.
    - Save, then tap **Send today's day close now** to test.
    - Turn it **Off** there at any time.
- **Recipients:** the addresses in **Send day-close emails to** (the owner list, which receives every branch). If that box is empty, the emails go to every Owner account. With several branches, each branch sends its own email to that branch's list plus the owner list.
- **Sender:** emails come from the Google account that owns the Sheet. A personal Gmail account can send about 100 emails a day, which is plenty.
- The Sheet menu also has **Groovy Kiosk → Email today's day close now**.

## Invoice PDFs in Google Drive

Every bill is also kept as an A4 PDF in your Google Drive:

```
<folder that holds the Sheet, e.g. Groovy Kiosk>/
  Sales_Invoices/
    FY 2026-27/                 ← April to March, like your bill numbers
      09/                       ← month
        GST/
          GF-26-27-00001.pdf    ← sale invoice (named by invoice number)
          GF-CN-26-27-0001.pdf  ← credit note for a return
          GF-26-27-00007-VOID.pdf  ← a voided bill keeps its PDF, renamed
        Non-GST/
          GF-26-27-00024.pdf
```

- **GST / Non-GST:** a bill goes to **GST** when it is printed as a **TAX INVOICE** — that is, "Show GST on bill" was on **and** your GSTIN is set in Settings. Everything else goes to **Non-GST**. Your accountant can then take just the GST folder. A credit note is filed with its original bill.

- **Automatic:** every 15 minutes Google saves PDFs for new bills and credit notes. Checkout is never slowed down, and anything that fails is retried on the next run.
- **By hand:** open **Sales → a bill → Save PDF to Drive** (about 2–3 seconds). If the bill already has a PDF it shows **"PDF saved in Google Drive"**; the owner gets an **Open** link.
- **On/off:** **More → Settings → Billing → Save invoice PDFs to Google Drive automatically**. Saving by hand always works.
- The PDFs are made by the Google script from the saved bill, not by the phone, so the app stays light.
- **Keep the folder private.** The files belong to the shop account; share them with customers through WhatsApp or Share in the app instead.
- **After this update:** run **Groovy Kiosk → 1. Setup / repair sheets** once. It adds the `pdf_url` columns and starts the 15-minute timer. If Google asks for permission, click **Allow**.

## 5. Updating later

- **Backend** (`.gs` files):
    1. Paste in the new code, or from `backend/` run `clasp push` (answer **y** if asked to overwrite the manifest).
    2. Make the live app use it: go to **Deploy → Manage deployments → ✏️ Edit**, set **Version: New version**, and click **Deploy**.
       With clasp instead: run `clasp deployments`, copy the ID of the web-app deployment (the one that is **not** `@HEAD`), then run `clasp redeploy <that ID> -d "v3 – what changed"`.
    3. Open the Sheet and run **Groovy Kiosk → 1. Setup / repair sheets**. It adds any new tabs or columns the update needs; until you do, the app shows "The app was updated — run Setup".
    4. If Google asks for new permissions (for example after the nightly-email update), open the Apps Script editor, run any function (e.g. `emailDayCloseNow`) once and click **Allow**.

    Always use **Edit** so the URL stays the same. A new deployment gets a new URL, and the app would stop reaching the backend.

- **App** (`frontend/`): push to `main`. GitHub rebuilds it, and phones pick up the update the next time the app is opened. The rebuild runs by itself only when something in `frontend/` changes.
- **Pushing everyone onto the new version:** **Groovy Kiosk → Log everyone out (after an update)**. Everyone signs in again on their next tap, which in practice means a fresh load of the app. Nothing else is touched — no bills, stock, products or settings. The app does update itself on the next open either way, and the backend is live for everyone the moment you deploy it, so this is a nudge rather than a requirement.
- **If the web app URL ever changes** (for example you made a _new_ deployment instead of editing): update the `VITE_API_URL` variable, then go to **Actions → Deploy app to GitHub Pages → Run workflow**.

## Good practice

- **Updating never clears your data.** New code (Apps Script or GitHub) doesn't touch the Sheet. **Setup / repair sheets** only adds missing tabs, columns and settings, and it never removes a column that has anything in it. Before big updates, use **File → Make a copy**, or **Version history** to roll back.
- **Keep your own notes in a separate tab**, not in extra columns at the end of the app's tabs. Future versions may need that space for new columns. If your column is in the way, Setup stops with a clear message instead of overwriting it.
- **Don't type into the Google Sheet by hand.** Use Stock In or Adjust in the app so stock history stays correct. Looking at or exporting the sheet is fine.
- **Backups:** Google Sheets keeps version history automatically. You can also use **File → Make a copy** once a month.
- **Staff leaving:** deactivate them in Staff. Their past sales stay in the reports.
- **Removing a product:** hide it with the eye icon on Edit product. Its bills and reports stay intact. The owner can **Delete** a product only if it was never sold, stocked in, adjusted or transferred, for example a duplicate added by mistake.
- **Load demo data only into a test copy of the sheet:** **Groovy Kiosk → 2. Load demo data**. It refuses to run if products already exist.
- **Going live after testing:** first back up with **File → Make a copy**, then run **Groovy Kiosk → 3. Reset test data (keep setup)…** and type `RESET`.
    - It clears bills, payments, returns, held bills, expenses, customers, stock history, stock-ins and transfers. It sets all stock to 0 and restarts bill numbers at 00001.
    - It keeps products and prices, categories, brands, staff, branches and shop settings.
    - Everyone is logged out. Log in again on each phone, then enter your real stock with **Stock In**.
    - This can’t be undone, which is why you make the copy first.
- **Starting over completely:** **Groovy Kiosk → 4. Reset EVERYTHING incl. products…** and type `ERASE ALL`. It does everything above **and** deletes every product, size, brand and category — prices, SKUs and barcodes included. Staff, branches and shop settings are kept, and the standard categories come back empty so you can add products straight away. Back up first; there is no undo.
- **Do a pilot day before going live.** Use a copy with demo data and try everything once:
    - the camera and the Bluetooth scanner;
    - the printer;
    - sharing a bill on WhatsApp;
    - the day-close email.
- **Archive once a year, or when the app gets slow.**
    - A Google Sheet holds at most 10 million cells, and the app reads whole tabs on every request, so old bills slow it down.
    - Make a copy of the Sheet (**File → Make a copy**) as that year's archive. Then ask your developer to trim old bills from the live Sheet.
    - Don't delete rows by hand. The tabs are linked (bill → items → payments → returns), and a half-deleted bill breaks reports and returns.

## Troubleshooting

| Problem                                                   | Fix                                                                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| "Couldn't reach the server"                               | Check the phone's internet. Check that `VITE_API_URL` is the `/exec` URL and that the deployment's access is **Anyone**. |
| App shows old screens                                     | Close the app fully and reopen it. The update installs automatically.                                                    |
| Camera doesn't open                                       | Allow camera access for the site or app in phone settings. On iPhone, use Safari to install the app.                     |
| "Sheet … missing"                                         | Run **Groovy Kiosk → 1. Setup / repair sheets** again. It is safe to repeat.                                               |
| Forgot the owner password                                     | Use **Forgot password?** on the login screen. A 6-digit code is emailed to you.                                          |
| "The app was updated — run Setup…"                        | Open the Sheet and run **Groovy Kiosk → 1. Setup / repair sheets**.                                                        |
| "You are not assigned to any active branch"               | Owner: go to **Staff** and set the person's **Works at**, or turn the branch back on in **Settings → Branches**.         |
| "Server busy, please try again"                           | Two phones saved at the same moment. Tap again.                                                                          |
| The first action after a quiet period takes a few seconds | Normal. Google is starting the script up.                                                                                |
| Printer doesn't appear on Android                         | Install the printer's print service (see **Printing bills**).                                                            |

---

## For developers

```
backend/   Apps Script (.gs): api.gs (doPost + role ACL), auth, catalog, inventory, sales, reports…
  dev/     mock-gas.js (in-memory Apps Script + Sheets), e2e.js (362 checks), server.js (local API)
frontend/  Vite + React PWA: src/pages (screens), src/lib (api, GST cart maths, printing), src/hooks (scanners)
```

Run everything locally, without Google, using a demo shop:

```bash
cd frontend && npm install
npm run dev:mock        # terminal 1: API on :8787 with demo data (admin@demo.local / admin123)
npm run dev             # terminal 2: app on http://localhost:5173 (also open it on your phone via your PC's IP)
node ../backend/dev/e2e.js   # backend end-to-end tests
```

**Replacing the logo:**

1. Save the original logo as `frontend/public/logo-source.png`.
2. Run `npm run icons` in `frontend/`. This regenerates the phone icons.
3. Push.

Key rules the backend enforces:

- Prices, GST and totals are always recalculated on the server.
- Each sale carries a `client_ref`, so a retry on a weak network can never create two bills.
- Stock checks and invoice numbers (`GF/26-27/00001`, restarting every April) are handled under a lock.
- All dates use IST.

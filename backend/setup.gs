/**
 * One-time setup, run from the spreadsheet menu "Groovy Kiosk" (or the Apps Script editor).
 * setupSheets() is safe to run again: it only creates what is missing.
 */

function onOpen() {
    SpreadsheetApp.getUi()
        .createMenu("Groovy Kiosk")
        .addItem("1. Setup / repair sheets", "setupSheets")
        .addItem("2. Load demo data (test copy only)", "seedDemo")
        .addItem("3. Reset test data (keep setup)…", "resetTestData")
        .addItem("4. Reset EVERYTHING incl. products…", "resetAll")
        .addSeparator()
        .addItem("Back up now…", "backupNow")
        .addItem("Back up last month", "backupLastMonth")
        .addItem("Reset a staff password…", "resetStaffPassword")
        .addItem("Log everyone out (after an update)", "logoutEveryone")
        .addItem("Email today's day close now", "emailDayCloseNow")
        .addItem("Run self-tests", "runTests")
        .addItem("Show web app URL", "showWebAppUrl")
        .addToUi();
}

/* ---------- reset test data (going live after testing) ---------- */

// tabs holding day-to-day data; the setup (products, staff, branches, settings) is kept
const RESET_TABS_ = [
    "Sales", "Sale_Items", "Payments", "Returns", "Return_Items", "Held_Bills",
    "Expenses", "Customers", "Stock_Movements", "Stock_In_Batches", "Transfers", "Branch_Stock",
    "Activity_Logs", "Sessions",
];

// the catalogue — kept by "reset test data" (it is the work you want to survive going live) and
// cleared only by "reset everything", which starts the shop from nothing
const CATALOG_TABS_ = ["Variants", "Products", "Brands", "Categories"];

function resetTestData() {
    const ui = SpreadsheetApp.getUi();
    const r = ui.prompt(
        "Reset test data",
        "This permanently deletes all bills, payments, returns, held bills, expenses, customers, stock history, " +
            "stock-ins and transfers, sets all stock to 0 and restarts bill numbers at 00001. Everyone is logged out.\n\n" +
            "The invoice PDFs go to Drive's bin as well: bill numbers start again at 00001, so keeping them would " +
            "leave two different invoices with the same name.\n\n" +
            "Kept: products & prices, photos, categories, brands, staff, branches and shop settings. " +
            "Back_up is not touched.\n\n" +
            backupStatusLine_() +
            "Type RESET to continue:",
        ui.ButtonSet.OK_CANCEL,
    );
    if (r.getSelectedButton() !== ui.Button.OK || r.getResponseText().trim() !== "RESET") {
        alert_("Nothing was changed.");
        return;
    }
    const res = resetTestData_();
    const lines = Object.keys(res.cleared)
        .filter((t) => res.cleared[t])
        .map((t) => "  " + t + ": " + res.cleared[t]);
    alert_(
        "Test data cleared.\n\n" + (lines.length ? "Rows removed:\n" + lines.join("\n") + "\n\n" : "") +
            "Bill numbers restart at 00001. Stock is now 0 — enter real stock with Stock In.\n" +
            "Everyone has been logged out; log in again on each phone.",
    );
}

/**
 * The line in a reset's confirmation box that says what you still have to fall back on.
 * It states the position rather than blocking: wiping a test copy with nothing worth keeping is a
 * perfectly good reason to carry on without a backup.
 */
function backupStatusLine_() {
    let newest = "";
    try {
        newest = lastBackupLabel_();
    } catch (e) {
        console.error("backupStatusLine_", e);
    }
    return newest
        ? "Last finished backup: " + newest + "\n\n"
        : "⚠ There is no finished backup yet. Cancel and run Groovy Kiosk → Back up now first if you want one.\n\n";
}

/** The standard categories, written only when there are none. Returns how many were added. */
function seedDefaultCategories_() {
    if (rows_("Categories").length) return 0;
    const now = nowStr_();
    appendRows_(
        "Categories",
        DEFAULT_CATEGORIES.map((c, i) => ({ id: i + 1, name: c[0], default_hsn: c[1], default_gst: c[2], sort: i + 1, active: 1, created_at: now })),
    );
    return DEFAULT_CATEGORIES.length;
}

/**
 * End every login. Both halves are needed: the Sessions rows, and the cached copies of them —
 * a cached login keeps working for hours after its row is gone.
 * Touches nothing else, so it is safe to run in the middle of a working day.
 */
function logoutEveryone_() {
    const cache = CacheService.getScriptCache();
    const t = readTable_("Sessions");
    const tokens = t.rows.map((s) => "s_" + s.token);
    for (let i = 0; i < tokens.length; i += 100) cache.removeAll(tokens.slice(i, i + 100));
    const last = t.sh.getLastRow();
    if (last >= 2) t.sh.getRange(2, 1, last - 1, t.keys.length).clearContent();
    delete REQ_CACHE_["Sessions"];
    return tokens.length;
}

function logoutEveryone() {
    const ui = SpreadsheetApp.getUi();
    const r = ui.alert(
        "Log everyone out",
        "Everyone signs in again on their next tap — anyone in the middle of a bill will have to log in first.\n\n" +
            "Nothing else changes: no bills, stock, products or settings are touched.\n\n" +
            "The app itself updates on its own the next time it is opened; this just makes sure that happens.\n\nContinue?",
        ui.ButtonSet.YES_NO,
    );
    if (r !== ui.Button.YES) {
        alert_("Nothing was changed.");
        return;
    }
    const n = withLock_(() => logoutEveryone_());
    alert_(n ? n + (n === 1 ? " login ended." : " logins ended.") + "\n\nAsk everyone to open the app and log in again." : "Nobody was logged in.");
}

/**
 * Hand someone a new password without any email. This is the way back in when the owner forgets
 * their own — nobody else can reset an owner — and the quickest way to sort out a member of staff.
 * Only someone who can edit this spreadsheet can run it, which is the root of trust for the app.
 * Returns the new password so the caller can show it once; it is never written to the log.
 */
function resetStaffPassword_(email) {
    return withLock_(() => {
        const wanted = str_(email).toLowerCase();
        const u = rows_("Users").find((x) => String(x.email).toLowerCase() === wanted);
        if (!u) fail_("No staff member has the email " + email);
        const pwd = "groovy@" + Math.floor(1000 + Math.random() * 9000);
        u.salt = newSalt_();
        u.pwd_hash = hashPwd_(pwd, u.salt);
        u.otp = ""; // a code that was already on its way must not still work
        u.otp_exp = "";
        u.updated_at = nowStr_();
        updateRows_("Users", [u]);
        endUserSessions_(u.id); // anyone signed in as them is signed out, as an app password change does
        log_({ user: { id: 0, name: "Sheet owner" } }, "UPDATE", "Users", u.id, "Password reset for " + u.name);
        return { name: u.name, role: u.role, active: u.active, password: pwd };
    });
}

function resetStaffPassword() {
    const ui = SpreadsheetApp.getUi();
    const ask = ui.prompt("Reset a staff password", "Email of the person who needs a new password:", ui.ButtonSet.OK_CANCEL);
    if (ask.getSelectedButton() !== ui.Button.OK) return;
    const email = ask.getResponseText().trim();
    if (!email) return alert_("Nothing was changed.");
    let who;
    try {
        who = rows_("Users").find((x) => String(x.email).toLowerCase() === email.toLowerCase());
    } catch (e) {
        return alert_(e.message || String(e));
    }
    if (!who) return alert_("No staff member has the email " + email + ".\n\nCheck the Users sheet for the exact address.");
    const sure = ui.alert(
        "Reset password",
        "Give " + who.name + " (" + who.role + ") a new password?\n\nTheir current password stops working at once and they are signed out everywhere.",
        ui.ButtonSet.YES_NO,
    );
    if (sure !== ui.Button.YES) return alert_("Nothing was changed.");
    try {
        const r = resetStaffPassword_(email);
        alert_(
            "New password for " + r.name + ":\n\n    " + r.password + "\n\nHand this over now — it is not shown again and is not saved anywhere readable.\n" +
                "Ask them to change it after logging in." + (r.active ? "" : "\n\nNote: this account is deactivated, so they also need reactivating in Staff before they can log in."),
        );
    } catch (e) {
        alert_(e.message || String(e));
    }
}

function resetTestData_() {
    const res = withLock_(() => {
        const ended = logoutEveryone_();

        const cleared = {};
        RESET_TABS_.forEach((name) => {
            const t = readTable_(name);
            cleared[name] = t.rows.length;
            const last = t.sh.getLastRow();
            if (last >= 2) t.sh.getRange(2, 1, last - 1, t.keys.length).clearContent(); // owner's extra columns untouched
            delete REQ_CACHE_[name];
        });
        cleared.Sessions = ended; // the tab was already emptied by the logout above

        const variants = rows_("Variants").filter((v) => v.stock_qty);
        variants.forEach((v) => (v.stock_qty = 0));
        writeColumn_("Variants", variants, "stock_qty");

        // bill / credit-note counters restart; generated-barcode counter kept (labels may be printed)
        const counters = rows_("Settings").filter((s) => /^(inv|cn)_seq_/.test(s.key));
        const sh = readTable_("Settings").sh;
        counters.sort((a, b) => b._r - a._r).forEach((s) => sh.deleteRow(s._r));
        delete REQ_CACHE_["Settings"];
        delete REQ_CACHE_.__settings;

        bumpCatalogVersion_();
        log_({ user: { id: 0, name: "Sheet owner" } }, "RESET", "All", "", "Test data cleared (setup kept)");
        return { cleared, counters: counters.length, stock_reset: variants.length };
    });
    // outside the lock, and here rather than in the menu command, so that "Reset EVERYTHING" —
    // which runs this first — clears the PDFs too
    res.pdf_years = clearInvoicePdfs_();
    return res;
}

/**
 * The invoice PDFs of bills that have just been deleted.
 *
 * Bill numbers restart at 00001 with every reset, so leaving the old PDFs would put two different
 * invoices of the same name in the same folder. They go to Drive's bin, where they can be recovered
 * for 30 days — and a backup taken beforehand keeps them for good. Back_up is never touched.
 */
function clearInvoicePdfs_() {
    try {
        return trashInvoiceFiles_();
    } catch (e) {
        console.error("clearInvoicePdfs_", e);
        return 0;
    }
}

/* ---------- reset everything, catalogue included (starting the shop from nothing) ---------- */

function resetAll() {
    const ui = SpreadsheetApp.getUi();
    const r = ui.prompt(
        "Reset EVERYTHING",
        "This does everything “Reset test data” does, and also permanently deletes every product, size, " +
            "brand and category — prices, SKUs and barcodes included.\n\n" +
            "Moved to Drive's bin: the invoice PDFs, and " + countProductImages_() + " product photos.\n" +
            "Back_up is not touched, so a backup taken beforehand still has everything.\n\n" +
            "Kept: staff and their passwords, branches, and shop settings. The standard categories come back empty.\n\n" +
            backupStatusLine_() +
            "Type ERASE ALL to continue:",
        ui.ButtonSet.OK_CANCEL,
    );
    if (r.getSelectedButton() !== ui.Button.OK || r.getResponseText().trim().toUpperCase() !== "ERASE ALL") {
        alert_("Nothing was changed.");
        return;
    }
    const res = resetAll_();
    res.photos = trashProductImages_(function () { return true; }); // the products are gone; their photos go too
    const lines = Object.keys(res.cleared)
        .filter((t) => res.cleared[t])
        .map((t) => "  " + t + ": " + res.cleared[t]);
    alert_(
        "Everything cleared.\n\n" + (lines.length ? "Rows removed:\n" + lines.join("\n") + "\n\n" : "") +
            "Moved to Drive's bin: the invoice PDFs and " + res.photos + " product " + (res.photos === 1 ? "photo" : "photos") +
            ".\nBack_up was not touched — your backups are safe.\n\n" +
            "The catalogue is empty — add products, or import them from a CSV.\n" +
            "Bill numbers restart at 00001. Everyone has been logged out; log in again on each phone.",
    );
}

function resetAll_() {
    // the two halves lock separately: resetTestData_ takes the script lock and releases it, and
    // asking for it again while still inside it would deadlock
    const res = resetTestData_();
    const catalogue = withLock_(() => {
        CATALOG_TABS_.forEach((name) => {
            const t = readTable_(name);
            res.cleared[name] = t.rows.length;
            const last = t.sh.getLastRow();
            if (last >= 2) t.sh.getRange(2, 1, last - 1, t.keys.length).clearContent(); // owner's extra columns untouched
            delete REQ_CACHE_[name];
        });
        // never leave the app with nowhere to file a product
        const cats = seedDefaultCategories_();
        bumpCatalogVersion_(); // the bump inside resetTestData_ happened before the catalogue went
        log_({ user: { id: 0, name: "Sheet owner" } }, "RESET", "All", "", "Everything cleared (staff, branches, settings kept)");
        return cats;
    });
    return Object.assign(res, { categories_restored: catalogue });
}

function alert_(msg) {
    try {
        SpreadsheetApp.getUi().alert(msg);
    } catch (e) {
        console.log(msg); // run from the editor
    }
}

function setupSheets() {
    resetReqCache_();
    const ss = ss_();
    const created = [];
    const kept = []; // tabs where the owner added their own columns (left untouched)
    Object.keys(SCHEMA).forEach((name) => {
        const keys = Object.keys(SCHEMA[name]);
        let sh = ss.getSheetByName(name);
        if (!sh) {
            sh = ss.insertSheet(name);
            created.push(name);
        }
        if (sh.getMaxColumns() < keys.length) sh.insertColumnsAfter(sh.getMaxColumns(), keys.length - sh.getMaxColumns());
        const lastCol = sh.getLastColumn();
        const header = lastCol ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
        if (!header.length || header.every((h) => !h)) {
            sh.getRange(1, 1, 1, keys.length).setValues([keys]);
        } else {
            // columns added in later versions are appended at the end — fill in their headers
            const added = [];
            keys.forEach((k, i) => {
                if (header[i] === k) return;
                if (!header[i] && header.slice(i).every((h) => !h)) {
                    sh.getRange(1, i + 1).setValue(k);
                    added.push(k);
                    return;
                }
                throw new Error("Sheet '" + name + "' column " + (i + 1) + " should be '" + k + "' but is '" + (header[i] || "") + "'. Fix the header row and run setup again.");
            });
            if (added.length) created.push(name + " (+" + added.join(", ") + ")");
        }
        sh.getRange(1, 1, 1, keys.length).setFontWeight("bold").setBackground("#654321").setFontColor("#FFFFFF");
        sh.setFrozenRows(1);
        // tidy away unused columns — but never delete a column that has anything in it
        const extra = sh.getMaxColumns() - keys.length;
        if (extra > 0) {
            const vals = sh.getRange(1, keys.length + 1, Math.max(1, sh.getLastRow()), extra).getValues();
            if (vals.every((row) => row.every((c) => c === "" || c === null))) sh.deleteColumns(keys.length + 1, extra);
            else kept.push(name);
        }
        if (sh.getMaxRows() < 500) sh.insertRowsAfter(sh.getMaxRows(), 500 - sh.getMaxRows());
        formatTextCols_(sh, name, 2, sh.getMaxRows() - 1);
    });

    // remove the blank default sheet
    ["Sheet1", "Sheet 1"].forEach((n) => {
        const sh = ss.getSheetByName(n);
        if (sh && sh.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sh);
    });

    resetReqCache_();
    const have = indexBy_(rows_("Settings"), "key");
    const now = nowStr_();
    const missing = Object.keys(DEFAULT_SETTINGS)
        .filter((k) => !have[k])
        .map((k) => ({ key: k, value: DEFAULT_SETTINGS[k], updated_by: 0, updated_at: now }));
    appendRows_("Settings", missing);

    seedDefaultCategories_();
    migrateRoleNames_(); // staff rows written before the role was renamed
    try {
        ensureBackupTrigger_(); // the monthly backup; Setup is where Google asks for permission
    } catch (e) {
        console.error("ensureBackupTrigger_", e);
    }
    // spare empty rows in every table, and the nightly job that keeps them topped up (maintenance.gs)
    resetReqCache_();
    topUpSpareRows_();
    try {
        ensureMaintenanceTrigger_();
    } catch (e) {
        console.error("ensureMaintenanceTrigger_", e);
    }
    try {
        imageFolder_(false); // a photo folder still carrying the app's old name is renamed here
    } catch (e) {
        console.error("imageFolder_", e);
    }

    // invoice folders used to be remembered by Drive id; they are found by name now, so these
    // leftovers would only mislead whoever reads Project Settings next
    const sp = PropertiesService.getScriptProperties();
    Object.keys(sp.getProperties())
        .filter((k) => k === "pdf_root_id" || k.indexOf("pdf_dir_") === 0)
        .forEach((k) => sp.deleteProperty(k));

    // branches: the existing shop becomes branch 1 (blank code keeps the GF/26-27/00001 bill series)
    if (!rows_("Branches").length) {
        const s = settingsMap_();
        appendRows_("Branches", [
            { id: 1, name: "Main branch", code: "", address: s.address, phone: s.phone, report_emails: "", active: 1, created_at: now },
        ]);
        created.push("Branch 1 “Main branch” (rename it in Settings → Branches)");
    }
    // stock counted before branches existed moves to branch 1
    if (!rows_("Branch_Stock").length) {
        const moved = rows_("Variants")
            .filter((v) => v.stock_qty)
            .map((v) => ({ variant_id: v.id, branch_id: 1, qty: v.stock_qty }));
        appendRows_("Branch_Stock", moved);
    }

    let adminMsg = "";
    if (!rows_("Users").length) {
        let email = "";
        try {
            email = Session.getEffectiveUser().getEmail();
        } catch (e) {}
        email = (email || "owner@groovyfragrances.in").toLowerCase();
        const pwd = "groovy@" + Math.floor(1000 + Math.random() * 9000);
        const salt = newSalt_();
        appendRows_("Users", [
            { id: 1, name: "Owner", email, phone: "", role: "owner", pwd_hash: hashPwd_(pwd, salt), salt, active: 1, otp: "", otp_exp: "", created_at: now, updated_at: now },
        ]);
        adminMsg = "\n\nOwner login created:\nEmail: " + email + "\nPassword: " + pwd + "\n\nWrite this down and change the password after first login.";
    }
    SpreadsheetApp.flush();
    const msg =
        "Setup complete." +
        (created.length ? "\nCreated sheets: " + created.join(", ") : "\nAll sheets already existed.") +
        (kept.length ? "\nKept your extra columns in: " + kept.join(", ") + " (no data was removed)." : "") +
        adminMsg +
        pdfTimerMsg_() +
        nightlyTimerMsg_();
    alert_(msg);
    return msg;
}

function showWebAppUrl() {
    let url = "";
    try {
        url = ScriptApp.getService().getUrl();
    } catch (e) {}
    alert_(url ? "Web app URL (use as VITE_API_URL):\n" + url : "Not deployed yet. In Apps Script: Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).");
}

/* ---------- demo data ---------- */

function seedDemo() {
    resetReqCache_();
    if (rows_("Products").length) {
        alert_("Products already exist — demo data is only for an empty test copy of the sheet.");
        return;
    }
    const admin = rows_("Users").find((u) => roleName_(u.role) === "owner");
    if (!admin) throw new Error("Run setup first");
    // demo shop with two branches: opening stock at Kondhwa, part of it transferred to Kalyani Nagar
    const ctx = { user: admin, token: "", branch_id: 1 };
    const b1 = findBy_("Branches", "id", 1);
    apiSaveBranch_({ id: 1, name: "Kondhwa", code: "", address: b1.address, phone: b1.phone }, ctx);
    const kn = apiSaveBranch_({ name: "Kalyani Nagar", code: "KN", address: "Shop 3, Kalyani Nagar, Pune 411006", phone: "" }, ctx).data.id;
    const cats = indexBy_(rows_("Categories"), "name");
    const catId = (n) => {
        if (!cats[n]) throw new Error("Missing category " + n);
        return cats[n].id;
    };

    // [brand, product, category, gender, sale_type, [[size, size_ml, mrp, price, cost, stock]], image]
    const demo = [
        ["Lattafa", "Asad Eau De Parfum", "Eau De Parfum", "men", "packed", [["100ml", 100, 3500, 1950, 1450, 6]]],
        ["Afnan", "Theoreme Pour Homme Eau De Parfum", "Eau De Parfum", "men", "packed", [["90ml", 90, 5000, 2049, 1600, 4]]],
        ["Rasasi", "Royal Blue Eau De Parfum", "Eau De Parfum", "men", "packed", [["75ml", 75, 2199, 1249, 900, 5]]],
        ["Ahmed Perfume", "Laathani Eau De Parfum", "Perfume Decants", "unisex", "packed", [["5ml decant", 5, 600, 499, 300, 10]]],
        ["Jaguar", "Classic Eau De Toilette", "Eau De Toilette", "men", "packed", [["100ml", 100, 4500, 1849, 1400, 3]]],
        ["Ramsons", "Scent of Love Eau de Parfum", "Eau De Parfum", "women", "packed", [["100ml", 100, 899, 749, 520, 6]],
            "https://cdn2.clevup.in/255755/1665945525706_RAMSONSSCENTOFLOVEEaudeParfumPerfume100mlForWomen3.jpeg?width=400&format=webp"],
        ["Naseem", "Khalifa Attar Premium Perfume Oil", "Packed Attar", "men", "packed", [["15ml", 15, 1250, 699, 480, 12]]],
        ["Naseem", "Hanayen Attar Premium Perfume Oil", "Packed Attar", "women", "packed", [["12ml", 12, 1250, 700, 480, 8]]],
        ["Al Haramain", "Musk Pure Roll-On Attar", "Packed Attar", "unisex", "packed", [["15ml", 15, 1000, 549, 380, 10]]],
        ["Al Alif", "Amber Touch Karwan Roll-On Attar", "Packed Attar", "unisex", "packed", [["10ml", 10, 450, 299, 190, 15]]],
        ["AdilQadri", "Shanaya Luxury Attar", "Packed Attar", "unisex", "packed", [["12ml", 12, 899, 599, 400, 7]]],
        ["Armaf", "Hunter Perfume Body Spray", "Deodorant Spray", "men", "packed", [["200ml", 200, 349, 296, 210, 20]]],
        ["Cristiano Ronaldo", "CR7 Origins Body Spray", "Deodorant Spray", "men", "packed", [["150ml", 150, 890, 599, 420, 8]]],
        ["Killer", "Wave Liquid Deodorant", "Deodorant Spray", "men", "packed", [["150ml", 150, 299, 125, 80, 25]]],
        ["Prathna", "Electric Bakhoor Burner", "Bakhoor & Incense Burner", "", "packed", [["1 pc", 0, 999, 599, 380, 4]]],
        ["Groovy", "Sandal Incense Sticks", "Incense Sticks", "", "packed", [["100 g", 0, 120, 99, 55, 30]]],
        ["Groovy", "White Musk Attar (Loose)", "Loose Attar", "unisex", "loose", [["Loose (per ml)", 0, 30, 25, 12, 500]]],
        ["Groovy", "Oud Royal Attar (Loose)", "Loose Attar", "men", "loose", [["Loose (per ml)", 0, 60, 50, 25, 250]]],
        ["Groovy", "Crystal Attar Bottle", "Fancy Bottles", "", "packed", [["6ml", 6, 60, 50, 20, 40], ["12ml", 12, 90, 80, 30, 30]]],
    ];

    demo.forEach((d) => {
        const variants = d[5].map((v) => ({
            size_label: v[0], size_ml: v[1], mrp: v[2], sell_price: v[3], cost: v[4], opening_stock: v[5],
            reorder_level: d[4] === "loose" ? 100 : 3, barcode: apiGenerateBarcode_({}, ctx).data.barcode,
        }));
        const cat = cats[d[2]];
        apiSaveProduct_(
            { name: d[1], brand_name: d[0], category_id: catId(d[2]), gender: d[3], sale_type: d[4], hsn: cat.default_hsn, gst_rate: cat.default_gst, image: d[6] || "", variants },
            ctx,
        );
    });

    // send ~40% of each item's stock to Kalyani Nagar
    resetReqCache_();
    const moveLines = rows_("Variants")
        .map((v) => ({ variant_id: v.id, qty: v.unit === "ml" ? Math.floor(v.stock_qty * 0.4) : Math.floor(v.stock_qty * 0.4) }))
        .filter((l) => l.qty > 0);
    apiTransferStock_({ to_branch_id: kn, lines: moveLines, note: "Opening stock for new branch" }, ctx);

    // demo staff (password demo1234): home branch, all may switch
    resetReqCache_();
    const staff = [
        ["Imran (Manager)", "manager@demo.local", "manager", 1],
        ["Sameer", "sameer@demo.local", "salesperson", 1],
        ["Ayesha", "ayesha@demo.local", "salesperson", kn],
    ];
    staff.forEach((s) => {
        if (!findBy_("Users", "email", s[1])) apiSaveUser_({ name: s[0], email: s[1], role: s[2], password: "demo1234", branch_id: s[3] }, ctx);
    });

    // ~3 weeks of demo bills spread across staff
    resetReqCache_();
    const sellers = rows_("Users").filter((u) => u.active);
    const phones = ["9876543210", "9822012345", "9765432109", "", "", "9890011223", ""];
    const names = ["Rahul Shah", "Fatima Khan", "Amit Patil", "", "", "Zoya Shaikh", ""];
    let n = 0;
    for (let day = 20; day >= 0; day--) {
        const bills = 1 + ((day * 7) % 3);
        for (let b = 0; b < bills; b++) {
            n++;
            resetReqCache_();
            const seller = sellers[n % sellers.length];
            const branch = roleName_(seller.role) === "owner" || seller.role === "manager" ? (n % 2 ? 1 : kn) : homeBranch_(seller);
            const inStock = rows_("Variants").filter((v) => stockOf_(v.id, branch) >= (v.unit === "ml" ? 12 : 2));
            if (!inStock.length) continue;
            const lines = [];
            const count = 1 + (n % 3);
            for (let k = 0; k < count; k++) {
                const v = inStock[(n * 7 + k * 5) % inStock.length];
                if (lines.some((l) => l.variant_id === v.id)) continue;
                lines.push({ variant_id: v.id, qty: v.unit === "ml" ? 6 : 1, discount: 0 });
            }
            const at = fmtDateTime_(new Date(Date.now() - day * 86400000 - (3 - b) * 3600000));
            try {
                // price first to know the total, then pay with a method mix
                const vm = indexBy_(inStock, "id");
                const grand = Math.round(lines.reduce((a, l) => a + vm[l.variant_id].sell_price * l.qty, 0));
                const method = ["cash", "upi", "upi", "card"][n % 4];
                const pays = n % 5 === 0 && grand > 400 ? [{ method: "cash", amount: 200 }, { method: "upi", amount: grand - 200 }] : [{ method, amount: grand }];
                apiCompleteSale_(
                    {
                        client_ref: "demo-" + n, lines, bill_disc: 0, salesman_id: seller.id,
                        customer: { phone: phones[n % phones.length], name: names[n % names.length] }, payments: pays, _at: at,
                    },
                    { user: seller, token: "", branch_id: branch },
                );
            } catch (e) {
                console.log("demo sale skipped: " + e.message);
            }
        }
    }

    const exp = [
        ["Rent", "Shop rent", 18000, 20],
        ["Electricity", "MSEB bill", 2350, 15],
        ["Tea & Snacks", "Tea for customers", 240, 3],
        ["Packaging", "Gift bags & boxes", 1200, 8],
        ["Transport", "Courier to Mumbai", 450, 1],
    ];
    exp.forEach((e, i) => apiSaveExpense_({ category: e[0], title: e[1], amount: e[2], method: "cash", date: daysAgoStr_(e[3]) }, Object.assign({}, ctx, { branch_id: i % 2 ? kn : 1 })));

    alert_("Demo data loaded: 2 branches (Kondhwa, Kalyani Nagar), " + demo.length + " products, " + n + " bills, 3 staff users (password demo1234).");
}

// (re)installs the nightly day-close email timer as Settings say (on/off, hour). A timer runs the code
// version that made it: saved from the app it is tied to the app's deployment (e.g. "Version 31") and
// would keep running that old code after an update; made here, from the sheet menu, it runs the latest.
function nightlyTimerMsg_() {
    try {
        if (!syncNightlyTrigger_()) return "";
        const h = Math.min(23, Math.max(0, parseInt(setting_("nightly_report_hour"), 10) || 22));
        return "\nNightly email: scheduled for " + hourLabel_(h) + " – " + hourLabel_((h + 1) % 24) + ".";
    } catch (e) {
        console.error("syncNightlyTrigger_", e);
        return "\nNightly email timer could not be set up: " + e;
    }
}

// (re)installs the nightly invoice-PDF timer; Setup is the place where Google asks for permission
function pdfTimerMsg_() {
    try {
        return syncPdfTrigger_() ? "\nInvoice PDFs: saved to Drive every night at 2 am." : "";
    } catch (e) {
        console.error("syncPdfTrigger_", e);
        return "\nInvoice PDF timer could not be set up: " + e;
    }
}

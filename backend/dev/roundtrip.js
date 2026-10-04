/**
 * Export → edit → import, end to end: the app's own export and file-reading code (frontend/src/lib)
 * against the real backend on the in-memory Apps Script mock.
 * Run: node backend/dev/roundtrip.js
 *
 * The point it proves: a product export uploaded untouched changes nothing, a file a spreadsheet has
 * been through still finds every size, and only what was edited is changed.
 * Dev-only: not pushed to Apps Script (.claspignore uploads only *.gs).
 */
const path = require("path");
const { pathToFileURL } = require("url");
const { createEnv } = require("./mock-gas");

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
    if (cond) passed++;
    else {
        failed++;
        console.log("FAIL:", name, extra !== undefined ? JSON.stringify(extra).slice(0, 600) : "");
    }
}
const lib = (f) => import(pathToFileURL(path.join(__dirname, "..", "..", "frontend", "src", "lib", f)).href);

(async () => {
    const { parseCSV, catalogToImportCSV, withoutInfoColumns, importParts, checkImport, excelText, IMPORT_TEMPLATE } = await lib("files.js");
    const { buildCatalog } = await lib("catalog.js");

    const env = createEnv();
    const { ctx, call } = env;
    ctx.setupSheets();
    const pwd = /Password: (\S+)/.exec(env.alerts.pop())[1];
    ctx.seedDemo(); // 19 products, two branches, bills
    const T = call("login", { email: "owner@groovy.test", password: pwd }).data.token;
    const oc = (a, p, b) => call(a, p, T, b === undefined ? 1 : b);
    const cats = oc("getCatalog", {}).data.categories;
    const catId = (n) => cats.find((c) => c.name === n).id;

    // products that are awkward for a spreadsheet, on top of the demo ones
    const add = (p) => { const r = oc("saveProduct", p); if (!r.success) throw new Error(r.message); return r.data.id; };
    add({ name: 'Oud "Royal", Gold', brand: "Al Haramain", category_id: catId("Eau De Parfum"), gender: "men", gst_rate: 18, hsn: "0902",
        variants: [
            { size_label: "50ml", size_ml: 50, barcode: "6291108735411", sku: "0012345", mrp: 2500, sell_price: 1999, cost: 1200.5, opening_stock: 4, reorder_level: 2 },
            { size_label: "100ml", size_ml: 100, barcode: "0123456789012", mrp: 4000, sell_price: 3499, cost: 2100, opening_stock: 2 },
        ] });
    add({ name: "Plain No Codes", category_id: catId("Body Mist"), gst_rate: 18, variants: [{ size_label: "200 ml", mrp: 300, sell_price: 250 }] }); // no brand, barcode or SKU
    add({ name: "Rose Loose Attar", brand: "Groovy", category_id: catId("Loose Attar"), sale_type: "loose", gst_rate: 18, variants: [{ mrp: 40, sell_price: 35, cost: 15, opening_stock: 250, reorder_level: 50 }] });
    const hiddenId = add({ name: "Old Discontinued Spray", brand: "Groovy", category_id: catId("Deodorant Spray"), gst_rate: 18, variants: [{ size_label: "150ml", barcode: "HID150", mrp: 199, sell_price: 149 }] });
    oc("toggleProduct", { id: hiddenId });

    const branches = oc("bootstrap", {}).data.branches;
    const snapshot = () => {
        const d = oc("getCatalog", {}).data;
        return JSON.stringify({ v: d.version, brands: d.brands, categories: d.categories, products: d.products, variants: d.variants });
    };
    const catalogNow = () => buildCatalog(oc("getCatalog", {}).data);
    const send = (rows) => importParts(withoutInfoColumns(rows)).map((part) => oc("importCatalog", { rows: part }));

    // ---- the export itself ----
    const cat0 = catalogNow();
    const csv = catalogToImportCSV(cat0, branches);
    const header = csv.split("\n")[0];
    const sizes = cat0.items.length;
    check("export: one row per size, hidden ones included", csv.split("\n").length - 1 >= sizes && cat0.items.some((i) => !i.active), sizes);
    check("export: the template's columns, in its order, then image and the info columns",
        header.startsWith(IMPORT_TEMPLATE.split("\n")[0] + ",image,info_hidden,info_stock_"), header);
    check("export: a reading-only stock column for each branch", branches.every((b) => header.includes("info_stock_" + b.name)) && branches.length === 2, header);
    check("export: owner's file carries cost", /,1200\.5,/.test(csv));
    check("export: long barcode and leading-zero codes are written as text for Excel",
        csv.includes('"=""6291108735411"""') && csv.includes('"=""0123456789012"""') && csv.includes('"=""0012345"""') && csv.includes('"=""0902"""'), csv.split("\n").find((l) => l.includes("Royal")));
    check("excelText leaves short codes and non-digits alone", excelText("3303") === "3303" && excelText("GF000010") === "GF000010" && excelText("12345678901") === "12345678901" && excelText("") === "" && excelText(undefined) === "");

    const rows = parseCSV(csv);
    const royal = rows.find((r) => r.size_label === "50ml" && /Royal/.test(r.product));
    check("reading the file back: every size, codes whole again", rows.length === sizes && royal.barcode === "6291108735411" && royal.sku === "0012345" && royal.hsn === "0902", royal);
    check("...a name with a comma and quotes survives", royal.product === 'Oud "Royal", Gold', royal.product);
    check("...opening_stock is empty on every row", rows.every((r) => r.opening_stock === ""));
    const hiddenRow = rows.find((r) => r.barcode === "HID150");
    check("...the hidden product is marked, and stock is shown per branch", hiddenRow.info_hidden === "yes" && royal.info_hidden === "" && royal["info_stock_" + branches[0].name.toLowerCase().replace(/\s+/g, "_")] === "4", [hiddenRow.info_hidden, royal]);
    check("...the info columns are taken off before sending", Object.keys(withoutInfoColumns(rows)[0]).every((k) => !/^info_/.test(k)) && withoutInfoColumns(rows).length === rows.length);

    // ---- uploaded untouched: nothing changes ----
    const before = snapshot();
    const chk0 = checkImport(withoutInfoColumns(rows), cat0);
    check("check before saving: every row matches, none new, none damaged, no new category",
        chk0.matched === sizes && chk0.fresh.length === 0 && chk0.damaged.length === 0 && chk0.newCategories.length === 0, chk0);
    const same = send(rows);
    check("untouched file: accepted in one request", same.length === 1 && same[0].success, same[0].message);
    const d0 = same[0].data;
    check("untouched file: 0 added, 0 updated, every row unchanged, 0 skipped", d0.variants === 0 && d0.products === 0 && d0.updated === 0 && d0.unchanged === sizes && d0.errors.length === 0 && d0.stock_ignored === 0, d0);
    check("untouched file: the product list is identical, version included", snapshot() === before);
    check("untouched file: works from All branches too (no stock in the file to place)", call("importCatalog", { rows: withoutInfoColumns(rows) }, T, 0).data.unchanged === sizes);

    // ---- after a spreadsheet: Excel saves the text cells as plain digits, and drops needless decimals ----
    const excelSaved = csv.replace(/"=""(\d+)"""/g, "$1").replace(/,1200\.5,/, ",1200.50,").replace(/\n/g, "\r\n");
    const rowsX = parseCSV("﻿" + excelSaved);
    check("saved by Excel: same rows, codes intact", rowsX.length === sizes && rowsX.find((r) => /Royal/.test(r.product) && r.size_label === "50ml").barcode === "6291108735411");
    const dX = send(rowsX)[0].data;
    check("saved by Excel: still nothing changes", dX.updated === 0 && dX.unchanged === sizes && dX.errors.length === 0 && snapshot() === before, dX);
    check("a bare =digits cell (quotes lost on the way) is read as the digits", parseCSV("barcode,sku\n=6291108735411,=0012345")[0].barcode === "6291108735411");

    // ---- edit three things: exactly those change ----
    const edited = parseCSV(csv);
    const e1 = edited.find((r) => r.barcode === "6291108735411");
    const e2 = edited.find((r) => r.product === "Plain No Codes");
    const e3 = edited.find((r) => r.product === "Rose Loose Attar");
    e1.sell_price = "2100";
    e2.reorder_level = "7";
    e3.category = "Packed Attar";
    const chkE = checkImport(withoutInfoColumns(edited), cat0);
    check("edited file: the check still sees every row as an existing size", chkE.matched === sizes && chkE.fresh.length === 0, chkE);
    const dE = send(edited)[0].data;
    check("edited file: 3 updated, the rest unchanged, nothing added or skipped", dE.updated === 3 && dE.unchanged === sizes - 3 && dE.variants === 0 && dE.errors.length === 0, dE);
    const cat1 = catalogNow();
    const now1 = (b) => cat1.byBarcode.get(b);
    const plain = cat1.items.find((i) => i.name === "Plain No Codes");
    const rose = cat1.items.find((i) => i.name === "Rose Loose Attar");
    check("edited file: the price, the reorder level and the category are the new ones", now1("6291108735411").price === 2100 && plain.reorder === 7 && rose.category === "Packed Attar", [now1("6291108735411").price, plain.reorder, rose.category]);
    check("edited file: stock, cost and the other size are as they were", now1("6291108735411").stock === 4 && now1("6291108735411").cost === 1200.5 && now1("0123456789012").price === 3499 && rose.stock === 250,
        [now1("6291108735411").stock, now1("6291108735411").cost, rose.stock]);
    const csv2 = catalogToImportCSV(cat1, branches);
    check("exporting again gives the edited values, and importing that changes nothing", /,2100,/.test(csv2) && send(parseCSV(csv2))[0].data.unchanged === sizes);

    // ---- the check before saving: what it is there to catch ----
    const renamed = parseCSV(csv2);
    renamed.find((r) => r.product === "Plain No Codes").product = "Plain Renamed";
    const chkR = checkImport(withoutInfoColumns(renamed), cat1);
    check("a renamed row with no barcode or SKU is shown as NEW, by name", chkR.fresh.length === 1 && /Plain Renamed/.test(chkR.fresh[0].label) && chkR.matched === sizes - 1, chkR.fresh);
    const renamedCoded = parseCSV(csv2);
    renamedCoded.find((r) => r.barcode === "HID150").product = "Renamed But Has A Barcode";
    check("a renamed row that has a barcode still matches its size", checkImport(withoutInfoColumns(renamedCoded), cat1).fresh.length === 0);
    const typo = parseCSV(csv2);
    typo[0].category = "Eau De Parfume";
    check("a mistyped category is named as a new category", checkImport(withoutInfoColumns(typo), cat1).newCategories.join() === "Eau De Parfume");
    const damaged = parseCSV(csv2.replace('"=""6291108735411"""', "6.29111E+12"));
    const chkD = checkImport(withoutInfoColumns(damaged), cat1);
    check("a barcode Excel turned into 6.29111E+12 is flagged as damaged", chkD.damaged.length === 1 && /Royal/.test(chkD.damaged[0].label), chkD.damaged);
    check("...and the server would have skipped that row, not saved a wrong barcode", /already has barcode 6291108735411/.test(send(damaged)[0].data.errors[0].message) && catalogNow().byBarcode.has("6291108735411"));
    const tmpl = checkImport(parseCSV(IMPORT_TEMPLATE), cat1);
    check("the template's sample rows are judged row by row (demo has Asad 100ml; the rest are new)", tmpl.matched + tmpl.fresh.length === 3 && tmpl.damaged.length === 0, tmpl);

    // ---- more rows than one request takes ----
    const few = parseCSV(csv2);
    check("up to 2,000 rows: one request, the very same rows as before", importParts(few).length === 1 && importParts(few)[0] === few);
    const big = [];
    for (let i = 0; i < 2500; i++) big.push({ brand: "Bulk", product: "Bulk Item " + i, category: "Accessories", size_label: "1pc", sell_price: i === 2100 ? "" : "99" });
    const parts = importParts(big);
    check("2,500 rows: three parts of at most 1,000, each row knowing its line in the file", parts.map((p) => p.length).join() === "1000,1000,500" && parts[2][0]._row === 2002 && parts[0][0]._row === 2);
    check("...the server refuses them as one request", /at most 2000/.test(oc("importCatalog", { rows: big }).message));
    const bigRes = parts.map((p) => oc("importCatalog", { rows: p }));
    const added = bigRes.reduce((n, r) => n + (r.success ? r.data.variants : 0), 0);
    const errs = bigRes.reduce((a, r) => a.concat(r.success ? r.data.errors : [{ row: -1, message: r.message }]), []);
    check("...and takes them as parts: 2,499 added, the one bad row skipped", bigRes.every((r) => r.success) && added === 2499 && errs.length === 1, { added, errs });
    check("...the skipped row is reported by its line in the file", errs[0].row === 2102 && /Selling price/.test(errs[0].message), errs[0]);
    const catBig = catalogNow();
    const csvBig = catalogToImportCSV(catBig, branches);
    const rowsBig = parseCSV(csvBig);
    const again = send(rowsBig);
    check("the whole list (over 2,000 rows) exports and imports back unchanged, in parts",
        rowsBig.length === sizes + 2499 && again.length === 3 && again.every((r) => r.success && r.data.updated === 0 && r.data.errors.length === 0)
        && again.reduce((n, r) => n + r.data.unchanged, 0) === rowsBig.length, again.map((r) => r.message));

    // ---- a manager's file has cost too; nobody else has the action ----
    const M = call("login", { email: "manager@demo.local", password: "demo1234" }).data.token;
    const S = call("login", { email: "sameer@demo.local", password: "demo1234" }).data.token;
    check("a salesperson's product list has no cost to export, and import is closed to them",
        buildCatalog(call("getCatalog", {}, S, 1).data).items.every((i) => i.cost === undefined) && call("importCatalog", { rows: [{}] }, S, 1).code === "FORBIDDEN");
    check("a manager's export has cost", /,1200\.5,/.test(catalogToImportCSV(buildCatalog(call("getCatalog", {}, M, 1).data), branches)));

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});

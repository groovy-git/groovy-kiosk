/**
 * End-to-end backend scenarios against the in-memory Apps Script mock.
 * Run: node backend/dev/e2e.js
 */
const { createEnv } = require("./mock-gas");

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
    if (cond) passed++;
    else {
        failed++;
        console.log("FAIL:", name, extra !== undefined ? JSON.stringify(extra) : "");
    }
}
function ok(res, name) {
    check(name + " → " + (res.message || ""), res.success, res);
    return res.data;
}
// same values, keys in any order
function sameData(a, b) {
    const canon = (v) =>
        Array.isArray(v) ? v.map(canon)
            : v && typeof v === "object" ? Object.keys(v).sort().reduce((o, k) => ((o[k] = canon(v[k])), o), {})
                : v;
    return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

const env = createEnv();
const { ctx, call } = env;

// ---- setup + self tests ----
ctx.setupSheets();
const setupMsg = env.alerts.pop();
const pwd = /Password: (\S+)/.exec(setupMsg)[1];
check("setup created the owner", !!pwd, setupMsg);
ctx.setupSheets(); // idempotent
check("setup rerun ok", /already existed/.test(env.alerts.pop()));
const testMsg = ctx.runTests();
check("unit tests", /All \d+ tests passed/.test(testMsg), testMsg);

// ---- auth ----
check("no token rejected", call("getCatalog", {}).code === "AUTH_EXPIRED");
check("bad password", !call("login", { email: "owner@groovy.test", password: "nope" }).success);
const login = ok(call("login", { email: "OWNER@groovy.test", password: pwd }), "owner login");
const T = login.token;
check("owner role", login.user.role === "owner");

// ---- users ----
ok(call("saveUser", { name: "Sameer", email: "sameer@x.in", role: "salesperson", password: "secret1" }, T), "add salesperson");
ok(call("saveUser", { name: "Ayesha", email: "ayesha@x.in", role: "salesperson", password: "secret2" }, T), "add salesperson 2");
ok(call("saveUser", { name: "Imran", email: "imran@x.in", role: "manager", password: "secret3" }, T), "add manager");
const S1 = ok(call("login", { email: "sameer@x.in", password: "secret1" }), "salesperson login").token;
const S2 = ok(call("login", { email: "ayesha@x.in", password: "secret2" }), "salesman2 login").token;
const M = ok(call("login", { email: "imran@x.in", password: "secret3" }), "manager login").token;
check("salesperson cannot list users", call("listUsers", {}, S1).code === "FORBIDDEN");
check("salesperson cannot add product", call("saveProduct", {}, S1).code === "FORBIDDEN");

// ---- catalog ----
const boot = ok(call("bootstrap", {}, T), "bootstrap");
const cat = (n) => boot.catalog.categories.find((c) => c.name === n).id;
const bc = ok(call("generateBarcode", {}, T), "gen barcode").barcode;
check("barcode format", /^GF\d{6}$/.test(bc), bc);
const asad = ok(
    call("saveProduct", {
        name: "Asad EDP", brand_name: "Lattafa", category_id: cat("Eau De Parfum"), gender: "men", hsn: "3303", gst_rate: 18,
        variants: [{ size_label: "100ml", size_ml: 100, barcode: "0628113420084", mrp: 3500, sell_price: 1950, cost: 1400, opening_stock: 2 }],
    }, T),
    "add product with leading-zero barcode",
);
check("dup barcode rejected", !call("saveProduct", {
    name: "X", category_id: cat("Eau De Parfum"), variants: [{ size_label: "5ml", sell_price: 10, barcode: "0628113420084" }],
}, T).success);
check("price above MRP rejected", !call("saveProduct", {
    name: "Y", category_id: cat("Eau De Parfum"), variants: [{ size_label: "5ml", mrp: 100, sell_price: 110 }],
}, T).success);
ok(call("saveProduct", {
    name: "White Musk (Loose)", brand_name: "Groovy", category_id: cat("Loose Attar"), sale_type: "loose", hsn: "3303", gst_rate: 18,
    variants: [{ size_label: "", mrp: 30, sell_price: 25, cost: 12, opening_stock: 100, barcode: bc }],
}, T), "add loose attar");
ok(call("saveProduct", {
    name: "Crystal Bottle", brand_name: "Groovy", category_id: cat("Fancy Bottles"), gst_rate: 18,
    variants: [{ size_label: "6ml", mrp: 60, sell_price: 50, cost: 20, opening_stock: 10, barcode: "GF900001" }],
}, T), "add bottle");
let catg = ok(call("getCatalog", {}, T), "catalog");
const vAsad = catg.variants.find((v) => v.barcode === "0628113420084");
const vMusk = catg.variants.find((v) => v.barcode === bc);
const vBottle = catg.variants.find((v) => v.barcode === "GF900001");
check("leading zero kept", !!vAsad, catg.variants.map((v) => v.barcode));
check("loose unit ml", vMusk.unit === "ml" && vMusk.size_label === "Loose (per ml)");
check("salesperson catalog hides cost", call("getCatalog", {}, S1).data.variants.every((v) => v.avg_cost === undefined));

// ---- stock in (repeat scans merge) ----
const si = ok(call("stockIn", {
    supplier_note: "Lattafa distributor", bill_ref: "B-77",
    lines: [{ variant_id: vAsad.id, qty: 1, unit_cost: 1500 }, { variant_id: vAsad.id, qty: 1, unit_cost: 1500 }, { variant_id: vAsad.id, qty: 1, unit_cost: 1500 }],
}, M), "stock in x3 same item");
check("stock in merged to 5", si.stock.find((s) => s.id === vAsad.id).stock_qty === 5, si);
catg = ok(call("getCatalog", {}, T), "catalog after stock in");
check("weighted avg cost", catg.variants.find((v) => v.id === vAsad.id).avg_cost === 1460, catg.variants.find((v) => v.id === vAsad.id));
check("salesperson cannot stock in", call("stockIn", { lines: [{ variant_id: vAsad.id, qty: 1 }] }, S1).code === "FORBIDDEN");

// ---- sale: scanned twice + loose 6ml + bottle, bill discount, split cash+upi ----
const saleReq = {
    client_ref: "abc-1",
    lines: [
        { variant_id: vAsad.id, qty: 1 }, { variant_id: vAsad.id, qty: 1 },
        { variant_id: vMusk.id, qty: 6 }, { variant_id: vBottle.id, qty: 1 },
    ],
    bill_disc: 100,
    customer: { phone: "+91 98765 43210", name: "Rahul" },
    payments: [{ method: "cash", amount: 1000 }, { method: "upi", amount: 3100, reference: "UPI123" }],
    // tampered client price must be ignored
    price_hack: 1,
};
saleReq.lines[0].price = 1;
const sale = ok(call("completeSale", saleReq, S1), "sale by salesperson");
const s = sale.sale;
check("invoice format", /^GF\/\d\d-\d\d\/00001$/.test(s.invoice_no), s.invoice_no);
check("gross = 1950*2 + 25*6 + 50", s.gross === 4100, s);
check("grand = 4000", s.grand_total === 4000, s);
check("salesperson attributed", s.salesman_name === "Sameer");
check("change 100 from cash", s.change === 100, s);
check("merged into 3 lines", sale.items.length === 3 && sale.items[0].qty === 2);
check("payments cash net of change", sale.payments.find((p) => p.method === "cash").amount === 900, sale.payments);
check("tax adds up", Math.abs(s.cgst + s.sgst + s.taxable - s.grand_total + s.round_off) < 0.02, s);
// the reply is built from the rows just written, not read back — it must match a fresh read exactly
const saleRead = ok(call("getSale", { id: s.id }, S1), "bill read back");
check("sale reply equals the bill read back (salesperson)", sameData(sale, saleRead), { reply: sale, read: saleRead });
const again = ok(call("completeSale", saleReq, S1), "retry same client_ref");
check("idempotent retry", again.sale.id === s.id);
catg = ok(call("getCatalog", {}, T), "catalog after sale");
check("stock reduced", catg.variants.find((v) => v.id === vAsad.id).stock_qty === 3);
check("loose ml reduced", catg.variants.find((v) => v.id === vMusk.id).stock_qty === 94);

// ---- salesperson rules ----
const sArgs = (o) => Object.assign({ client_ref: "x" + Math.random(), lines: [{ variant_id: vBottle.id, qty: 1 }], payments: [{ method: "cash", amount: 50 }] }, o);
check("salesperson cannot sell as another", !call("completeSale", sArgs({ salesman_id: 3 }), S1).success);
check("salesperson discount cap", /Discount limit/.test(call("completeSale", sArgs({ bill_disc: 20, payments: [{ method: "cash", amount: 30 }] }), S1).message));
check("short payment rejected", /short/.test(call("completeSale", sArgs({ payments: [{ method: "cash", amount: 40 }] }), S1).message));
check("upi over bill rejected", !call("completeSale", sArgs({ payments: [{ method: "upi", amount: 60 }] }), S1).success);
check("out of stock rejected", /in stock/.test(call("completeSale", sArgs({ lines: [{ variant_id: vAsad.id, qty: 9 }], payments: [{ method: "cash", amount: 99999 }] }), S1).message));
const users = ok(call("listSellers", {}, M), "sellers");
const ayesha = users.find((u) => u.name === "Ayesha");
const mSale = ok(call("completeSale", sArgs({ salesman_id: ayesha.id }), M), "manager bills for Ayesha").sale;
check("manager sold-by other", mSale.salesman_name === "Ayesha" && mSale.created_by !== ayesha.id);

// ---- visibility ----
const s1List = ok(call("listSales", {}, S1), "salesperson list").sales;
check("salesperson sees only own", s1List.length === 1 && s1List[0].salesman_name === "Sameer", s1List);
check("salesperson cannot open other bill", !call("getSale", { id: mSale.id }, S1).success);
check("the owner sees all", ok(call("listSales", {}, T), "owner list").sales.length === 2);

// ---- returns + void ----
const vAsadItem = sale.items.find((i) => i.variant_id === vAsad.id);
check("a salesperson is refused above the refund cap", /Refund limit/.test(call("returnItems", { sale_id: s.id, items: [{ sale_item_id: vAsadItem.id, qty: 2 }], refund_method: "cash", reason: "Wrong size" }, S1).message));
const ret = ok(call("returnItems", { sale_id: s.id, items: [{ sale_item_id: vAsadItem.id, qty: 1, restock: true }], refund_method: "cash", reason: "Wrong size" }, M), "partial return");
check("credit note no", /^GF\/CN\/\d\d-\d\d\/0001$/.test(ret.returns[0].credit_note_no), ret.returns[0]);
check("status part_returned", ret.sale.status === "part_returned");
check("over-return rejected", !call("returnItems", { sale_id: s.id, items: [{ sale_item_id: vAsadItem.id, qty: 2 }], refund_method: "cash", reason: "x" }, M).success);
const voided = ok(call("voidSale", { id: mSale.id, reason: "Customer changed mind" }, M), "void");
check("voided", voided.sale.status === "voided");
check("void twice rejected", !call("voidSale", { id: mSale.id, reason: "x" }, M).success);
catg = ok(call("getCatalog", {}, T), "catalog after return/void");
check("asad restocked", catg.variants.find((v) => v.id === vAsad.id).stock_qty === 4);
check("bottle restored by void", catg.variants.find((v) => v.id === vBottle.id).stock_qty === 9);

// ---- reports ----
const dash = ok(call("dashboard", {}, T), "dashboard");
check("dash today net = 4000 - refund", Math.abs(dash.today.net - (4000 - ret.returns[0].total)) < 0.01, dash.today);
check("leaderboard has Sameer", dash.leaderboard.today.some((r) => r.name === "Sameer"));
// items sold + new customers per salesperson. Sameer's bill: Asad x2 (pcs) + 6ml loose (counts 1) + 1 bottle = 4.
// Rahul was a brand-new customer on it; Ayesha's walk-in bill was voided, so she is in nobody's figures.
const lbS = dash.leaderboard.today.find((r) => r.name === "Sameer");
check("leaderboard items as billed", lbS.items === 4, lbS);
check("new customer credited to the first bill's salesperson", lbS.new_customers === 1, lbS);
check("dashboard today items + new customers", dash.today.items === 4 && dash.today.new_customers === 1, dash.today);
check("voided bill is in nobody's figures", !dash.leaderboard.today.some((r) => r.name === "Ayesha"), dash.leaderboard.today);
const lsSum = ok(call("listSales", {}, T), "owner list summary").summary;
check("list summary counts the same, voided bill excluded", lsSum.items === 4 && lsSum.new_customers === 1, lsSum);
const dc = ok(call("report", { type: "day_close" }, T), "day close");
// items sold (for refilling): net of returns, voided bills excluded, current stock shown
const dcItem = (id) => dc.items.find((i) => i.variant_id === id);
check("day close lists Asad net of return", dcItem(vAsad.id) && dcItem(vAsad.id).qty === 1 && dcItem(vAsad.id).stock_left === 4, dcItem(vAsad.id));
check("day close lists loose ml", dcItem(vMusk.id) && dcItem(vMusk.id).qty === 6 && dcItem(vMusk.id).unit === "ml", dcItem(vMusk.id));
check("voided bill items excluded", dcItem(vBottle.id) && dcItem(vBottle.id).qty === 1, dcItem(vBottle.id));
check("salesperson day close items own only", call("report", { type: "day_close" }, S2).data.items.length === 0);
const payNet = Object.values(dc.methods).reduce((a, m) => a + m.net, 0);
check("day close payments = net", Math.abs(payNet - dc.net) < 0.01, dc);
check("salesperson day close own only", ok(call("report", { type: "day_close" }, S2), "salesman2 day close").bills === 0);
check("salesperson no gst report", call("report", { type: "gst_summary" }, S1).success === false);
const gst = ok(call("report", { type: "gst_summary" }, T), "gst");
check("gst totals", Math.abs(gst.totals.total - 4000) < 0.01, gst.totals);
const pr = ok(call("report", { type: "profit" }, T), "profit");
check("profit computed", pr.revenue_ex_gst > 0 && pr.cost_of_goods > 0, pr);
check("day close items is still the list of products sold", Array.isArray(dc.items) && dc.by_salesman[0].items === 4 && dc.by_salesman[0].new_customers === 1, dc.by_salesman);

// ---- new customers: repeats, walk-ins, hand-added, and a voided first bill ----
const perfRows = () => ok(call("report", { type: "salesman_performance", from: "2020-01-01" }, T), "salesperson perf").rows;
const perfFor = (name) => perfRows().find((r) => r.name === name) || { items: 0, new_customers: 0 };
check("salesman_performance carries both", perfFor("Sameer").items === 4 && perfFor("Sameer").new_customers === 1, perfFor("Sameer"));

// a second bill for the same phone: items add up, the customer is not new again
ok(call("completeSale", sArgs({ client_ref: "nc-repeat", customer: { phone: "9876543210" }, salesman_id: ayesha.id }), M), "second bill for Rahul");
check("a repeat customer is new only once", perfFor("Sameer").new_customers === 1 && perfFor("Ayesha").new_customers === 0, perfRows());
check("the repeat bill's item is counted", perfFor("Ayesha").items === 1, perfFor("Ayesha"));

// walk-in (no phone) and a customer added on the Customers page but never billed: neither is new
const ncBefore = ok(call("dashboard", {}, T), "dash before walk-in").today.new_customers;
ok(call("completeSale", sArgs({ client_ref: "nc-walkin", customer: { name: "No phone" } }), M), "walk-in bill");
ok(call("saveCustomer", { name: "Never Billed", phone: "9800000001" }, T), "customer added by hand");
check("walk-ins and unbilled customers are not new customers", ok(call("dashboard", {}, T), "dash after walk-in").today.new_customers === ncBefore);
// …until someone bills them, and then it is that salesperson's
ok(call("completeSale", sArgs({ client_ref: "nc-hand", customer: { phone: "9800000001" }, salesman_id: ayesha.id }), M), "Ayesha bills the hand-added customer");
check("a hand-added customer counts on their first bill", perfFor("Ayesha").new_customers === 1, perfFor("Ayesha"));

// a voided first bill credits nobody, and the customer's next bill counts instead
const nb1 = ok(call("completeSale", sArgs({ client_ref: "nc-void-1", customer: { phone: "9811111111", name: "Nisha" } }), S1), "Sameer bills a new customer").sale;
ok(call("voidSale", { id: nb1.id, reason: "Rang up by mistake" }, M), "void that first bill");
check("a voided first bill credits nobody", perfFor("Sameer").new_customers === 1, perfFor("Sameer"));
ok(call("completeSale", sArgs({ client_ref: "nc-void-2", customer: { phone: "9811111111" }, salesman_id: ayesha.id }), M), "Ayesha bills her next");
check("after a voided first bill the next one counts", perfFor("Ayesha").new_customers === 2, perfFor("Ayesha"));

// the three screens must agree: Home tiles = sum of the leaderboard = the Sales page summary
const dash2 = ok(call("dashboard", {}, T), "dashboard after the new bills");
const rows2 = perfRows();
const sumOf = (f) => rows2.reduce((a, r) => a + r[f], 0);
check("Home tiles = sum of the per-salesman rows", Math.abs(dash2.today.items - sumOf("items")) < 0.001 && dash2.today.new_customers === sumOf("new_customers"), [dash2.today, rows2]);
const sum2 = ok(call("listSales", {}, T), "list summary again").summary;
check("Sales page summary = Home tiles", sum2.items === dash2.today.items && sum2.new_customers === dash2.today.new_customers, [sum2, dash2.today]);
const sumA = ok(call("listSales", { salesman_id: ayesha.id }, T), "list filtered by salesperson").summary;
check("the summary follows the salesperson filter", sumA.items === perfFor("Ayesha").items && sumA.new_customers === perfFor("Ayesha").new_customers, [sumA, perfFor("Ayesha")]);
const s1Dash = ok(call("dashboard", {}, S1), "salesperson's own dashboard");
check("a salesperson sees only their own figures", s1Dash.today.items === perfFor("Sameer").items && s1Dash.today.new_customers === 1, s1Dash.today);
const dcA = ok(call("report", { type: "day_close" }, S2), "ayesha day close").by_salesman;
check("a salesperson's day close has only their own row", dcA.length === 1 && dcA[0].name === "Ayesha" && dcA[0].new_customers === perfFor("Ayesha").new_customers, dcA);
ok(call("report", { type: "salesman_performance", from: "2020-01-01" }, T), "salesperson perf");
ok(call("report", { type: "product_sales", group: "brand" }, T), "product sales");
ok(call("report", { type: "stock_valuation" }, T), "stock valuation");
ok(call("report", { type: "sales_register" }, T), "register");
ok(call("saveExpense", { title: "Tea", amount: 60, category: "Tea & Snacks", method: "cash" }, M), "expense");
check("day close expected cash", ok(call("report", { type: "day_close" }, T), "day close 2").cash_expenses === 60);

// ---- GST hidden on bill: same totals/tax, still in GST report ----
const gstBefore = ok(call("report", { type: "gst_summary" }, T), "gst before").totals;
const hid = ok(call("completeSale", sArgs({ gst_hidden: true, lines: [{ variant_id: vBottle.id, qty: 1 }], payments: [{ method: "cash", amount: 50 }] }), M), "sale with GST hidden").sale;
check("gst_hidden stored", hid.gst_hidden === 1, hid);
check("gst hidden: total unchanged", hid.grand_total === 50 && hid.taxable === 42.37 && Math.abs(hid.cgst + hid.sgst - 7.63) < 0.001, hid);
const gstAfter = ok(call("report", { type: "gst_summary" }, T), "gst after").totals;
check("gst hidden sale still in GST report", Math.abs(gstAfter.total - gstBefore.total - 50) < 0.01, { gstBefore, gstAfter });
check("default gst shown", mSale.gst_hidden === 0 && s.gst_hidden === 0);

// ---- A) day-close email from the app ----
env.mails.length = 0;
let em = call("emailDayClose", {}, S1);
check("salesperson can email day close", em.success, em);
let mail = env.mails.pop();
check("no list → goes to the owner", mail && mail.to === "owner@groovy.test", mail && mail.to);
check("salesperson mail is own figures", /\(Sameer\)/.test(mail.subject) && /Your sales/.test(mail.htmlBody) && !/Cash in drawer/.test(mail.htmlBody), mail.subject);
check("reply-to is the sender", mail.replyTo === "sameer@x.in");
ok(call("emailDayClose", { copy_me: true }, M), "manager emails whole shop with copy");
mail = env.mails.pop();
check("manager mail is whole shop", /Whole shop/.test(mail.htmlBody) && /Cash in drawer/.test(mail.htmlBody) && mail.cc === "imran@x.in", mail.cc);
check("mail lists items sold with stock left", /Items sold/.test(mail.htmlBody) && /Asad EDP/.test(mail.htmlBody) && /Stock left/.test(mail.htmlBody) && /Items sold:/.test(mail.body), mail.body);
// per salesperson: under the name, worded so it can't be mistaken for the per-product 'Items sold' table
check("mail shows items billed and new customers per salesperson", /items billed · \d+ new customer/.test(mail.htmlBody) && /bills, \d+ items, \d+ new customers?,/.test(mail.body), mail.htmlBody.slice(0, 200));
check("bad report email rejected", !call("saveSettings", { settings: { report_emails: "owner@x.in, not-an-email" } }, T).success);
check("salesperson cannot see report emails", call("getSettings", {}, S1).data.report_emails === undefined);
for (let i = 0; i < 4; i++) call("emailDayClose", {}, S1);
check("manual emails limited per day", /already sent 5/.test(call("emailDayClose", {}, S1).message));

// ---- B) nightly email on/off ----
ok(call("saveSettings", { settings: { report_emails: "Owner@X.in; accountant@x.in", nightly_report: "yes", nightly_report_hour: "22" } }, T), "turn nightly on");
const nightlyTriggers = () => env.triggers.filter((x) => x.fn === "sendNightlyReport");
check("one trigger at 22:00 IST", nightlyTriggers().length === 1 && nightlyTriggers()[0].hour === 22 && nightlyTriggers()[0].tz === "Asia/Kolkata", nightlyTriggers());
check("emails normalised", call("getSettings", {}, T).data.report_emails === "owner@x.in, accountant@x.in");
ok(call("saveSettings", { settings: { nightly_report_hour: "21" } }, T), "change hour");
check("still one trigger, new hour", nightlyTriggers().length === 1 && nightlyTriggers()[0].hour === 21);
env.mails.length = 0;
check("nightly sends when on", /: sent$/.test(ctx.sendNightlyReport()) && env.mails.length === 1 && env.mails[0].to === "owner@x.in,accountant@x.in");
const offRes = call("saveSettings", { settings: { nightly_report: "no" } }, T);
check("turn nightly off", offRes.success && /OFF/.test(offRes.message), offRes.message);
check("trigger removed when off", nightlyTriggers().length === 0);
check("nightly does nothing when off", ctx.sendNightlyReport() === "disabled" && env.mails.length === 1);
check("unrelated save keeps trigger state", ok(call("saveSettings", { settings: { tagline: "Smell Of Perfection" } }, T), "unrelated save") !== undefined && nightlyTriggers().length === 0);

// ---- held bills, customers, logs ----
const held = ok(call("holdBill", { label: "Rahul", cart: { lines: [{ variant_id: vAsad.id, qty: 1 }] } }, S1), "hold");
check("held listed", ok(call("listHeld", {}, S1), "list held").length === 1);
ok(call("deleteHeld", { id: held.id }, S1), "delete held");
check("customer created", ok(call("findCustomer", { phone: "9876543210" }, S2), "find cust").name === "Rahul");
check("logs owner only", call("listLogs", {}, M).code === "FORBIDDEN" && ok(call("listLogs", {}, T), "logs").length > 5);

// ---- deactivate kills session ----
ok(call("toggleUser", { id: ayesha.id }, T), "deactivate ayesha");
check("deactivated session rejected", call("getCatalog", {}, S2).code === "AUTH_EXPIRED");
check("cannot delete user with sales", !call("deleteUser", { id: 2 }, T).success);

// ---- password reset via OTP ----
ok(call("forgotPassword", { email: "sameer@x.in" }), "forgot");
const otp = /code is: (\d{6})/.exec(env.mails[env.mails.length - 1].body)[1];
check("wrong otp", !call("resetPassword", { email: "sameer@x.in", otp: "000000", password: "newpass1" }).success);
ok(call("resetPassword", { email: "sameer@x.in", otp, password: "newpass1" }), "reset");
check("old session ended", call("getCatalog", {}, S1).code === "AUTH_EXPIRED");
ok(call("login", { email: "sameer@x.in", password: "newpass1" }), "login new pwd");

// The reply must never reveal whether an address is a real account, and neither must the limits:
// if they only fired for real accounts, the error itself would be the giveaway.
const cacheClear = () => require("vm").runInContext("CacheService.getScriptCache().removeAll(['otp_sent_nobody@x.in','otp_day_nobody@x.in','otp_sent_sameer@x.in','otp_day_sameer@x.in'])", ctx);
cacheClear();
const mailsBefore = env.mails.length;
const unknown1 = call("forgotPassword", { email: "nobody@x.in" });
const known1 = call("forgotPassword", { email: "sameer@x.in" });
check("unknown address gets the same answer as a real one", unknown1.success && unknown1.message === known1.message, { unknown: unknown1.message, known: known1.message });
check("no email is sent for an unknown address", env.mails.length === mailsBefore + 1, env.mails.length - mailsBefore);
const unknown2 = call("forgotPassword", { email: "nobody@x.in" });
const known2 = call("forgotPassword", { email: "sameer@x.in" });
check("the wait message is identical for both, so it gives nothing away",
    !unknown2.success && !known2.success && unknown2.message === known2.message, { unknown: unknown2.message, known: known2.message });
// the burst cap stops the send quota being drained — and it applies to unknown addresses too,
// so it cannot be used to tell a real account from a made-up one
cacheClear();
let capped = null;
for (let i = 0; i < 12 && !capped; i++) {
    require("vm").runInContext("CacheService.getScriptCache().remove('otp_sent_nobody@x.in')", ctx); // skip the 60s spacing
    const r = call("forgotPassword", { email: "nobody@x.in" });
    if (!r.success) capped = { at: i + 1, message: r.message };
}
check("a burst of requests is capped at 10, even for an unknown address", capped && capped.at === 11, capped);
require("vm").runInContext("CacheService.getScriptCache().removeAll(['otp_sent_sameer@x.in','otp_day_sameer@x.in'])", ctx);
check("the cap is per address — someone else is unaffected", call("forgotPassword", { email: "sameer@x.in" }).success);

// ---- the Sheet's own password reset: the way back in when email is no help ----
// its own account, so resetting it cannot disturb the tokens the rest of the suite is using
ok(call("saveUser", { name: "Reset Me", email: "resetme@x.in", role: "salesperson", password: "secret7" }, T), "add the account to reset");
const S3 = ok(call("login", { email: "resetme@x.in", password: "secret7" }), "that account logs in").token;
const otherStillValid = ok(call("getCatalog", {}, M), "manager token before the reset");
const rsp = ctx.resetStaffPassword_("RESETME@x.in"); // matched whatever the case
check("it returns a password and who it belongs to", /^groovy@\d{4}$/.test(rsp.password) && rsp.name === "Reset Me", rsp);
check("the old password no longer works", !call("login", { email: "resetme@x.in", password: "secret7" }).success);
ok(call("login", { email: "resetme@x.in", password: rsp.password }), "login with the new password");
check("that person is signed out everywhere", call("getCatalog", {}, S3).code === "AUTH_EXPIRED");
check("nobody else is signed out", !!otherStillValid && call("getCatalog", {}, M).success);
check("a pending reset code is cleared", require("vm").runInContext('resetReqCache_(); (findBy_("Users","email","resetme@x.in").otp || "") === ""', ctx));
check("an unknown address is refused", (() => { try { ctx.resetStaffPassword_("ghost@x.in"); return false; } catch (e) { return /No staff member/.test(e.message); } })());
check("the new password is never written to the log",
    require("vm").runInContext('resetReqCache_(); rows_("Activity_Logs").every((l) => String(l.details).indexOf("groovy@") < 0)', ctx));

// ---- lost replies: retries with the same req_id never save twice ----
const rqStock = () => call("getCatalog", {}, T, 1).data.variants.find((v) => v.id === vBottle.id).stock_qty;
const rq0 = rqStock();
const rqA = call("stockIn", { lines: [{ variant_id: vBottle.id, qty: 2, unit_cost: 40 }] }, T, 1, "req-test-0001");
const rqA2 = call("stockIn", { lines: [{ variant_id: vBottle.id, qty: 2, unit_cost: 40 }] }, T, 1, "req-test-0001");
check("retry with same req_id: saved once", rqA.success && rqStock() === rq0 + 2, { rq0, now: rqStock() });
check("retry with same req_id: same reply", JSON.stringify(rqA2) === JSON.stringify(rqA));
call("stockIn", { lines: [{ variant_id: vBottle.id, qty: 2, unit_cost: 40 }] }, T, 1, "req-test-0002");
check("new req_id: saved again", rqStock() === rq0 + 4);
env.cache.set("rq_req-test-0003", "PENDING");
check("still running → IN_PROGRESS", call("stockIn", { lines: [{ variant_id: vBottle.id, qty: 1 }] }, T, 1, "req-test-0003").code === "IN_PROGRESS" && rqStock() === rq0 + 4);
const rqBad = call("stockIn", { lines: [{ variant_id: vBottle.id, qty: 0 }] }, T, 1, "req-test-0004");
const rqBad2 = call("stockIn", { lines: [{ variant_id: vBottle.id, qty: 3 }] }, T, 1, "req-test-0004");
check("failed try is not remembered", !rqBad.success && rqBad2.success && rqStock() === rq0 + 7, { rqBad, rqBad2 });
// a retried read (same req_id, because Google lost the first reply) is answered from the saved
// reply instead of running the whole query again — that retry used to cost another full read
const rqR1 = call("getCatalog", {}, T, 1, "req-test-0005");
call("stockIn", { lines: [{ variant_id: vBottle.id, qty: 1 }] }, T, 1, "req-test-0006");
const rqStockNow = () => rqStock();
const rqR2 = call("getCatalog", {}, T, 1, "req-test-0005");
const qty = (r) => r.data.variants.find((v) => v.id === vBottle.id).stock_qty;
check("a retried read replays its saved reply", qty(rqR2) === qty(rqR1), { first: qty(rqR1), retry: qty(rqR2), now: rqStockNow() });
// a fresh request (its own req_id) always sees the new figures
const rqR3 = call("getCatalog", {}, T, 1, "req-test-0007");
check("a new read sees the change", qty(rqR3) === qty(rqR1) + 1, { first: qty(rqR1), fresh: qty(rqR3) });
check("no req_id works as before", call("stockIn", { lines: [{ variant_id: vBottle.id, qty: 1 }] }, T, 1).success && rqStock() === rq0 + 9);
check("bad req_id ignored", call("stockIn", { lines: [{ variant_id: vBottle.id, qty: 1 }] }, T, 1, "x").success && rqStock() === rq0 + 10);
// a phone locked mid-save retries when it wakes, maybe much later: seen live-like in the stress test,
// a transfer retried 3 hours on was saved twice because its reply was kept for only 10 minutes
check("a save's reply is kept 6 hours, a read's 2 minutes", env.cacheTtl.get("rq_req-test-0001") === 21600 && env.cacheTtl.get("rq_req-test-0005") === 120,
    { save: env.cacheTtl.get("rq_req-test-0001"), read: env.cacheTtl.get("rq_req-test-0005") });
env.expireCache(11 * 60);
const rqLate = call("stockIn", { lines: [{ variant_id: vBottle.id, qty: 2, unit_cost: 40 }] }, T, 1, "req-test-0001");
check("a retry 11 minutes later is not saved again", JSON.stringify(rqLate) === JSON.stringify(rqA) && rqStock() === rq0 + 10, { now: rqStock(), expected: rq0 + 10 });
const rqRLate = call("getCatalog", {}, T, 1, "req-test-0005");
check("a read retried 11 minutes later is answered fresh", qty(rqRLate) === rqStock(), { replayed: qty(rqRLate), now: rqStock() });

// ---- CSV import ----
const imp = ok(call("importCatalog", { rows: [
    { brand: "Armaf", product: "Club De Nuit", category: "Eau De Parfum", size_label: "105ml", mrp: 3300, sell_price: 2499, cost: 1800, opening_stock: 3, barcode: "6294015152225" },
    { brand: "Armaf", product: "Club De Nuit", category: "Eau De Parfum", size_label: "30ml", mrp: 1200, sell_price: 899, opening_stock: 2 },
    { brand: "X", product: "", category: "EDP", size_label: "1", sell_price: 1 },
    { brand: "Y", product: "Dup", category: "Eau De Parfum", size_label: "5ml", sell_price: 5, barcode: "6294015152225" },
] }, T), "import");
check("import grouped sizes", imp.products === 1 && imp.variants === 2, imp);
check("import errors reported", imp.errors.length === 2, imp.errors);
// re-upload = update, never duplicate
const cdnRows = () => [
    { brand: "Armaf", product: "Club De Nuit", category: "Eau De Parfum", size_label: "105ml", mrp: 3300, sell_price: 2499, cost: 1800, opening_stock: 3, barcode: "6294015152225" },
    { brand: "Armaf", product: "Club De Nuit", category: "Eau De Parfum", size_label: "30ml", mrp: 1200, sell_price: 899, opening_stock: 2 },
];
const cdnSizes = () => call("getCatalog", {}, T).data.variants.filter((v) => /^(105ml|30ml)$/.test(v.size_label) && call("getCatalog", {}, T).data.products.find((x) => x.id === v.product_id).name === "Club De Nuit");
const cdn105 = () => cdnSizes().find((v) => v.size_label === "105ml");
const cdn30 = () => cdnSizes().find((v) => v.size_label === "30ml");
const stock105 = cdn105().stock_qty;
const reImp = ok(call("importCatalog", { rows: cdnRows() }, T), "re-import same file");
check("re-import: nothing added or updated", reImp.variants === 0 && reImp.products === 0 && reImp.updated === 0 && reImp.unchanged === 2, reImp);
check("re-import: no duplicate sizes", cdnSizes().length === 2, cdnSizes().map((v) => v.size_label));
check("re-import: opening stock ignored + reported", cdn105().stock_qty === stock105 && reImp.stock_ignored === 2, reImp);
const impUpd = ok(call("importCatalog", { rows: [{ brand: "armaf", product: "club de nuit", size_label: "105 ML", sell_price: 2399, opening_stock: 9 }] }, T), "import price change");
check("import update: price saved", impUpd.updated === 1 && cdn105().sell_price === 2399, impUpd);
check("import update: blank cells kept", cdn105().mrp === 3300 && cdn105().stock_qty === stock105);
ok(call("importCatalog", { rows: [{ brand: "Armaf", product: "Club De Nuit", size_label: "30ml", barcode: "6294015100001" }] }, T), "import adds barcode");
check("import update: barcode set on existing size", cdn30().barcode === "6294015100001" && cdnSizes().length === 2);
const clash2 = ok(call("importCatalog", { rows: [
    { brand: "Armaf", product: "Club De Nuit", size_label: "30ml", barcode: "6294015199999" },
    { brand: "Someone", product: "Else", category: "Eau De Parfum", size_label: "10ml", sell_price: 100, barcode: "6294015152225" },
    { brand: "Armaf", product: "Club De Nuit", size_label: "30ml", sale_type: "loose" },
    { brand: "Armaf", product: "Club De Nuit", category: "Eau De Parfum", size_label: "200ml", sell_price: 3999 },
    { brand: "Armaf", product: "Club De Nuit", category: "Eau De Parfum", size_label: "200ml", sell_price: 3999 },
] }, T), "import conflicts");
const impMsgs = clash2.errors.map((e) => e.row + ":" + e.message).join(" | ");
check("import: size already has other barcode", /2:Size 30ml already has barcode/.test(impMsgs), impMsgs);
check("import: barcode of another product", /3:Barcode 6294015152225 belongs to Armaf Club De Nuit/.test(impMsgs), impMsgs);
check("import: packed/loose change refused", /4:Can't change packed\/loose/.test(impMsgs), impMsgs);
check("import: new size added once, repeat refused", clash2.variants === 1 && /6:Repeats an earlier row/.test(impMsgs), clash2);

// SKU works as a key like the barcode (website exports carry SKU-0001 …)
const skuVar = (sku) => call("getCatalog", {}, T).data.variants.find((v) => String(v.sku).toUpperCase() === sku.toUpperCase());
const prodNameOf = (v) => call("getCatalog", {}, T).data.products.find((x) => x.id === v.product_id).name;
const skuNew = ok(call("importCatalog", { rows: [
    { brand: "Groovy Fragrances", product: "Flora Inspired Perfume | Unisex", new_category: "Eau De Parfum", size_label: "30ml", size_ml: 30, sell_price: 350, mrp: 350, sku: "SKU-0001", barcode: "2220631", opening_stock: 47, gst_rate: 18 },
    { brand: "Groovy Fragrances", product: "Chocolate Musk Roll-On Attar", new_category: "Packed Attar", size_label: "12ml", sell_price: 400, sku: "SKU-0020", barcode: "800006" },
] }, T, 1), "import with SKUs and new_category");
check("new products use new_category", skuNew.products === 2 && call("getCatalog", {}, T).data.categories.find((c) => c.id === call("getCatalog", {}, T).data.products.find((x) => x.name === "Chocolate Musk Roll-On Attar").category_id).name === "Packed Attar");
check("SKU stored, opening stock for the new size", skuVar("SKU-0001") && skuVar("SKU-0001").stock_qty === 47);
// rename in the app, then re-import by SKU with the website name and a new price
const floraVar = skuVar("SKU-0001");
const floraProd = call("getCatalog", {}, T).data.products.find((x) => x.id === floraVar.product_id);
ok(call("saveProduct", Object.assign({}, floraProd, { name: "Flora 30", brand_name: "Groovy Fragrances", variants: [{ id: floraVar.id, size_label: "30ml", barcode: floraVar.barcode, sell_price: 350, mrp: 350 }] }), T, 1), "rename product in app (old app: no sku sent)");
check("saving without sku keeps the SKU", skuVar("SKU-0001") && skuVar("SKU-0001").id === floraVar.id);
const bySkuUpd = ok(call("importCatalog", { rows: [
    { brand: "Groovy Fragrances", product: "Flora Inspired Perfume | Unisex", size_label: "30ML", sell_price: 375, mrp: 400, sku: "sku-0001", opening_stock: 999, new_category: "Packed Attar" },
] }, T, 1), "re-import by SKU, other name");
check("SKU match updates price, keeps app name, ignores stock", bySkuUpd.updated === 1 && skuVar("SKU-0001").sell_price === 375 && prodNameOf(skuVar("SKU-0001")) === "Flora 30" && skuVar("SKU-0001").stock_qty === 47, bySkuUpd);
check("new_category never changes an existing product", call("getCatalog", {}, T).data.products.find((x) => x.id === floraVar.product_id).category_id === floraProd.category_id);
// SKU filled in on a size found by brand + product + size
ok(call("importCatalog", { rows: [{ brand: "Armaf", product: "Club De Nuit", size_label: "105ml", sku: "SKU-CDN-105" }] }, T), "fill SKU by name+size");
check("SKU filled on matched size", skuVar("SKU-CDN-105") && prodNameOf(skuVar("SKU-CDN-105")) === "Club De Nuit");
const skuConf = ok(call("importCatalog", { rows: [
    { brand: "Armaf", product: "Club De Nuit", size_label: "105ml", sku: "SKU-OTHER" },
    { brand: "X", product: "Y", size_label: "30ml", sell_price: 5, barcode: "2220631", sku: "SKU-0020" },
    { brand: "Nope", product: "Wrong Name", size_label: "30ml", sell_price: 5, barcode: "6294015152225" },
    { brand: "Nope", product: "Wrong Name", size_label: "12ml", sell_price: 410, mrp: 450, barcode: "800006", sku: "SKU-0020" },
] }, T, 1), "SKU conflicts");
const skuMsgs = skuConf.errors.map((e) => e.row + ":" + e.message).join(" | ");
check("size already has another SKU", /2:Size 105ml already has SKU SKU-CDN-105/.test(skuMsgs), skuMsgs);
check("barcode and SKU of different items", /3:Barcode 2220631 and SKU SKU-0020 belong to different items/.test(skuMsgs), skuMsgs);
check("barcode + other name without SKU still refused", /4:Barcode 6294015152225 belongs to/.test(skuMsgs), skuMsgs);
check("barcode + other name allowed when SKU agrees", skuConf.updated === 1 && skuVar("SKU-0020").sell_price === 410 && prodNameOf(skuVar("SKU-0020")) === "Chocolate Musk Roll-On Attar", skuConf);
const skuAgain = ok(call("importCatalog", { rows: [{ brand: "Groovy Fragrances", product: "Flora Inspired Perfume | Unisex", size_label: "30ML", sell_price: 375, mrp: 400, sku: "SKU-0001" }] }, T, 1), "same SKU row again");
check("same SKU file again: unchanged, no duplicate", skuAgain.unchanged === 1 && skuAgain.variants === 0 && call("getCatalog", {}, T).data.variants.filter((v) => String(v.sku).toUpperCase() === "SKU-0001").length === 1);
// saveProduct: duplicate SKU refused, explicit SKU edit saved
const dupSku = call("saveProduct", { name: "Dup Sku", brand_name: "X", category_id: cat("Eau De Parfum"), gst_rate: 18, variants: [{ size_label: "10ml", sell_price: 100, sku: "sku-0001" }] }, T, 1);
check("saveProduct refuses a duplicate SKU", !dupSku.success && /SKU sku-0001 already belongs to/.test(dupSku.message), dupSku);
ok(call("saveProduct", Object.assign({}, floraProd, { name: "Flora 30", brand_name: "Groovy Fragrances", variants: [{ id: floraVar.id, size_label: "30ml", barcode: floraVar.barcode, sell_price: 375, mrp: 400, sku: "SKU-0001-B" }] }), T, 1), "edit SKU in app");
check("SKU edited in app", skuVar("SKU-0001-B") && skuVar("SKU-0001-B").id === floraVar.id);

// website export: a row with no barcode gets its Product Id, so the size can still be scanned
const varById = (id) => call("getCatalog", {}, T).data.variants.find((v) => v.id === id);
const fbNew = ok(call("importCatalog", { rows: [
    { brand: "Groovy Fragrances", product: "Real Rose Perfume", new_category: "Eau De Parfum", size_label: "30ml", size_ml: 30, sell_price: 200, mrp: 400, sku: "SKU-RR-30", barcode: "", barcode_fallback: "900101" },
    { brand: "Groovy Fragrances", product: "Real Rose Perfume", size_label: "60ml", size_ml: 60, sell_price: 300, mrp: 600, sku: "SKU-RR-60", barcode: "", barcode_fallback: "900102" },
] }, T, 1), "website rows without a barcode");
check("blank barcode filled from Product Id", skuVar("SKU-RR-30") && skuVar("SKU-RR-30").barcode === "900101" && skuVar("SKU-RR-60").barcode === "900102", fbNew);
check("fills are counted for the import summary", fbNew.barcodes_filled === 2, fbNew);
const rr30 = skuVar("SKU-RR-30");
// the same file again: found by SKU, nothing duplicated, no second fill counted
const fbAgain = ok(call("importCatalog", { rows: [
    { brand: "Groovy Fragrances", product: "Real Rose Perfume", size_label: "30ml", sell_price: 200, mrp: 400, sku: "SKU-RR-30", barcode: "", barcode_fallback: "900101" },
] }, T, 1), "same website file again");
check("re-upload: no duplicate, no error, nothing refilled", fbAgain.variants === 0 && fbAgain.unchanged === 1 && !fbAgain.errors.length && fbAgain.barcodes_filled === 0 && skuVar("SKU-RR-30").id === rr30.id, fbAgain);
// found by the filled barcode alone, even when the row carries no SKU
const fbByCode = ok(call("importCatalog", { rows: [
    { brand: "Groovy Fragrances", product: "Real Rose Perfume", size_label: "30ml", sell_price: 210, barcode: "", barcode_fallback: "900101" },
] }, T, 1), "row matched by the filled Product Id");
check("filled Product Id identifies the size later", fbByCode.updated === 1 && varById(rr30.id).sell_price === 210 && call("getCatalog", {}, T).data.variants.filter((v) => v.barcode === "900101").length === 1, fbByCode);
// a real barcode saved in the app is never replaced, and the row still updates
ok(call("saveProduct", Object.assign({}, call("getCatalog", {}, T).data.products.find((x) => x.id === rr30.product_id), {
    brand_name: "Groovy Fragrances",
    variants: [{ id: rr30.id, size_label: "30ml", barcode: "8901234567890", sku: "SKU-RR-30", sell_price: 210, mrp: 400 }],
}), T, 1), "shop scans a real barcode onto the size");
const fbKeep = ok(call("importCatalog", { rows: [
    { brand: "Groovy Fragrances", product: "Real Rose Perfume", size_label: "30ml", sell_price: 225, sku: "SKU-RR-30", barcode: "", barcode_fallback: "900101" },
] }, T, 1), "website row over a real barcode");
check("real barcode kept, row still updates, no error", !fbKeep.errors.length && varById(rr30.id).barcode === "8901234567890" && varById(rr30.id).sell_price === 225, fbKeep);
// a Product Id that is already someone else's barcode is ignored rather than failing
const fbTaken = ok(call("importCatalog", { rows: [
    { brand: "Groovy Fragrances", product: "Rose Attar Mini", new_category: "Packed Attar", size_label: "3ml", sell_price: 50, sku: "SKU-RR-3", barcode: "", barcode_fallback: "8901234567890" },
] }, T, 1), "Product Id already used as a barcode");
check("taken Product Id ignored, size still created", !fbTaken.errors.length && fbTaken.variants === 1 && skuVar("SKU-RR-3").barcode === "" && fbTaken.barcodes_filled === 0, fbTaken);
// two rows in one file carrying the same Product Id: the first fills, the second is left blank
const fbDup = ok(call("importCatalog", { rows: [
    { brand: "Groovy Fragrances", product: "Twin A", new_category: "Eau De Parfum", size_label: "10ml", sell_price: 90, sku: "SKU-TW-A", barcode: "", barcode_fallback: "900777" },
    { brand: "Groovy Fragrances", product: "Twin B", new_category: "Eau De Parfum", size_label: "10ml", sell_price: 90, sku: "SKU-TW-B", barcode: "", barcode_fallback: "900777" },
] }, T, 1), "repeated Product Id in one file");
check("repeated Product Id: first fills, second blank, no error", !fbDup.errors.length && fbDup.variants === 2 && skuVar("SKU-TW-A").barcode === "900777" && skuVar("SKU-TW-B").barcode === "" && fbDup.barcodes_filled === 1, fbDup);
// a hand-made CSV (no fallback field) behaves exactly as before
const noFb = ok(call("importCatalog", { rows: [{ brand: "Groovy Fragrances", product: "Plain Row", new_category: "Eau De Parfum", size_label: "5ml", sell_price: 20 }] }, T, 1), "template CSV row");
check("template CSV unaffected: size created without a barcode", noFb.variants === 1 && noFb.barcodes_filled === 0 && call("getCatalog", {}, T).data.products.some((x) => x.name === "Plain Row"), noFb);
check("template CSV unaffected: reorder level left at 0", skuVar("SKU-RR-3") && varById(skuVar("SKU-RR-3").id).reorder_level === 0);

// the website exports Min Quantity as 0 on every row, so a size would never warn when it runs low:
// a reorder level of 2 is filled in — but only where none is set
const webRow = (o) => Object.assign({ brand: "Groovy Fragrances", new_category: "Eau De Parfum", barcode: "", reorder_fallback: 2 }, o);
const rlNew = ok(call("importCatalog", { rows: [
    webRow({ product: "Reorder One", size_label: "30ml", sell_price: 200, sku: "SKU-RL-1", reorder_level: "" }),
    webRow({ product: "Reorder Two", size_label: "30ml", sell_price: 200, sku: "SKU-RL-2", reorder_level: 5 }),
] }, T, 1), "website rows with and without a minimum");
check("blank minimum becomes a reorder level of 2", skuVar("SKU-RL-1").reorder_level === 2, rlNew);
check("a minimum in the file wins over the fallback", skuVar("SKU-RL-2").reorder_level === 5);
// re-uploading the same file changes nothing
const rlAgain = ok(call("importCatalog", { rows: [webRow({ product: "Reorder One", size_label: "30ml", sell_price: 200, sku: "SKU-RL-1", reorder_level: "" })] }, T, 1), "same website file again");
check("re-upload: reorder level unchanged, nothing to update", rlAgain.unchanged === 1 && skuVar("SKU-RL-1").reorder_level === 2, rlAgain);
// a level set in the app survives the next upload — the regression this fallback design exists to prevent
const rl1 = skuVar("SKU-RL-1");
ok(call("saveProduct", Object.assign({}, call("getCatalog", {}, T).data.products.find((x) => x.id === rl1.product_id), {
    brand_name: "Groovy Fragrances",
    variants: [{ id: rl1.id, size_label: "30ml", sell_price: 200, sku: "SKU-RL-1", reorder_level: 6 }],
}), T, 1), "shop sets its own reorder level");
const rlKeep = ok(call("importCatalog", { rows: [webRow({ product: "Reorder One", size_label: "30ml", sell_price: 190, sku: "SKU-RL-1", reorder_level: "" })] }, T, 1), "website row over a level set here");
check("a reorder level set in the app is never replaced", !rlKeep.errors.length && skuVar("SKU-RL-1").reorder_level === 6 && skuVar("SKU-RL-1").sell_price === 190, rlKeep);
// a size still sitting at 0 (imported before this) is backfilled by the next upload
const rlOld = ok(call("importCatalog", { rows: [{ brand: "Groovy Fragrances", product: "Reorder Old", new_category: "Eau De Parfum", size_label: "30ml", sell_price: 200, sku: "SKU-RL-3" }] }, T, 1), "size created with no reorder level");
check("older size starts at 0", rlOld.variants === 1 && skuVar("SKU-RL-3").reorder_level === 0);
ok(call("importCatalog", { rows: [webRow({ product: "Reorder Old", size_label: "30ml", sell_price: 200, sku: "SKU-RL-3", reorder_level: "" })] }, T, 1), "website re-upload backfills it");
check("a level still at 0 is backfilled to 2", skuVar("SKU-RL-3").reorder_level === 2);

// ---- setup upgrades an older sheet that lacks a newly added trailing column ----
const salesSh = env.ss.getSheetByName("Sales");
const lastCol = require("vm").runInContext("Object.keys(SCHEMA.Sales).length", ctx);
salesSh.getRange(1, lastCol).setValue(""); // simulate sheet created before gst_hidden existed
salesSh.deleteColumns(lastCol, 1);
ctx.setupSheets();
const upMsg = env.alerts.pop();
const lastKey = require("vm").runInContext("Object.keys(SCHEMA.Sales).pop()", ctx);
check("setup migration adds column", salesSh.getRange(1, lastCol).getValues()[0][0] === lastKey && upMsg.indexOf(lastKey) >= 0, upMsg);
check("sales readable after migration", ok(call("listSales", {}, T), "list after migration").sales.length > 0);

// ================= multiple branches =================
const branchesErr = (r) => r.code === "BRANCH";
check("prefix+code over 4 chars rejected", !call("saveBranch", { name: "X", code: "KNX" }, T).success);
check("second blank code rejected", !call("saveBranch", { name: "Blank" }, T).success);
const KN = ok(call("saveBranch", { name: "Kalyani Nagar", code: "kn", report_emails: "kn@x.in" }, T), "add branch KN").id;
ok(call("saveBranch", { id: 1, name: "Kondhwa", code: "" }, T), "rename branch 1");
check("code with bills can't change", !call("saveBranch", { id: 1, name: "Kondhwa", code: "KD" }, T).success);

// staff: Ravi works anywhere (home Kondhwa), Kiran only at KN, Meena manages KN only
ok(call("saveUser", { name: "Ravi", email: "ravi@x.in", role: "salesperson", password: "secret4", branch_id: 1 }, T), "add Ravi");
ok(call("saveUser", { name: "Kiran", email: "kiran@x.in", role: "salesperson", password: "secret5", branch_id: KN, branch_ids: [KN] }, T), "add Kiran");
ok(call("saveUser", { name: "Meena", email: "meena@x.in", role: "manager", password: "secret6", branch_id: KN, branch_ids: [KN] }, T), "add Meena");
const RAVI = ok(call("login", { email: "ravi@x.in", password: "secret4" }), "Ravi login");
const KIRAN = ok(call("login", { email: "kiran@x.in", password: "secret5" }), "Kiran login");
const MEENA = ok(call("login", { email: "meena@x.in", password: "secret6" }), "Meena login").token;
check("Ravi may use both branches", RAVI.user.branch_ids.length === 2 && RAVI.user.home_branch_id === 1, RAVI.user);
check("Kiran limited to KN", KIRAN.user.branch_ids.join() === String(KN) && KIRAN.user.home_branch_id === KN, KIRAN.user);

// transfer Kondhwa → KN
const stockAt = (b, vid) => call("getCatalog", {}, T, b).data.variants.find((v) => v.id === vid).stock_qty;
const kdBottleBefore = stockAt(1, vBottle.id);
const tr = ok(call("transferStock", { to_branch_id: KN, lines: [{ variant_id: vBottle.id, qty: 2 }, { variant_id: vBottle.id, qty: 1 }] }, T, 1), "transfer 3 to KN");
check("transfer no", /^TR\d{5}$/.test(tr.transfer_no), tr);
check("stock moved out of Kondhwa", stockAt(1, vBottle.id) === kdBottleBefore - 3);
check("stock moved into KN", stockAt(KN, vBottle.id) === 3);
check("all-branches total", stockAt(0, vBottle.id) === kdBottleBefore);
check("stock_by_branch in catalog", call("getCatalog", {}, T, KN).data.variants.find((v) => v.id === vBottle.id).stock_by_branch[KN] === 3);
check("over-transfer rejected", /Only/.test(call("transferStock", { to_branch_id: KN, lines: [{ variant_id: vBottle.id, qty: 999 }] }, T, 1).message));
check("salesperson cannot transfer", call("transferStock", { to_branch_id: 1, lines: [{ variant_id: vBottle.id, qty: 1 }] }, KIRAN.token).code === "FORBIDDEN");
check("KN manager cannot transfer out of Kondhwa", branchesErr(call("transferStock", { to_branch_id: KN, lines: [{ variant_id: vBottle.id, qty: 1 }] }, MEENA, 1)));
check("transfer listed", ok(call("listTransfers", {}, MEENA), "transfers at KN").some((t) => t.id === tr.id && t.items.length === 1 && t.items[0].qty === 3));

// sales per branch
const sellArgs = (o) => Object.assign({ client_ref: "br" + Math.random(), lines: [{ variant_id: vBottle.id, qty: 1 }], payments: [{ method: "cash", amount: 50 }] }, o);
const kSale = ok(call("completeSale", sellArgs({}), KIRAN.token), "Kiran sells at KN (home)").sale;
check("KN bill series", /^GFKN\/\d\d-\d\d\/00001$/.test(kSale.invoice_no) && kSale.branch_id === KN, kSale.invoice_no);
check("sale took KN stock only", stockAt(KN, vBottle.id) === 2 && stockAt(1, vBottle.id) === kdBottleBefore - 3);
check("Kiran can't sell at Kondhwa", branchesErr(call("completeSale", sellArgs({}), KIRAN.token, 1)));
const rKN = ok(call("completeSale", sellArgs({}), RAVI.token, KN), "Ravi sells at KN").sale;
const rKD = ok(call("completeSale", sellArgs({}), RAVI.token, 1), "Ravi switches to Kondhwa and sells").sale;
check("Ravi KN bill in KN series", /^GFKN\/\d\d-\d\d\/00002$/.test(rKN.invoice_no), rKN.invoice_no);
check("Ravi Kondhwa bill in main series", /^GF\/\d\d-\d\d\/\d{5}$/.test(rKD.invoice_no) && rKD.branch_id === 1, rKD.invoice_no);
const raviList = ok(call("listSales", {}, RAVI.token, 1), "Ravi's sales").sales;
check("salesperson sees own bills from both branches", raviList.length === 2 && raviList.some((x) => x.branch_name === "Kalyani Nagar") && raviList.some((x) => x.branch_name === "Kondhwa"), raviList);
const sellersKN = ok(call("listSellers", {}, T, KN), "sellers at KN");
const sellersKD = ok(call("listSellers", {}, T, 1), "sellers at KD");
check("sold-by list is per branch", sellersKN.some((u) => u.name === "Kiran") && sellersKN.some((u) => u.name === "Sameer") && sellersKD.every((u) => u.name !== "Kiran" && u.name !== "Meena"));
check("seller must work at the branch", /does not work at/.test(call("completeSale", sellArgs({ salesman_id: KIRAN.user.id }), T, 1).message));

// returns & voids only at the selling branch
const kItem = ok(call("getSale", { id: kSale.id }, MEENA), "KN manager opens KN bill").items[0];
check("return refused at another branch", /made at Kalyani Nagar/.test(call("returnItems", { sale_id: kSale.id, items: [{ sale_item_id: kItem.id, qty: 1 }], refund_method: "cash", reason: "x" }, T, 1).message));
const kRet = ok(call("returnItems", { sale_id: kSale.id, items: [{ sale_item_id: kItem.id, qty: 1 }], refund_method: "cash", reason: "Leaked" }, MEENA), "return at KN");
check("KN credit note series", /^GFKNC\/\d\d-\d\d\/0001$/.test(kRet.returns[0].credit_note_no), kRet.returns[0].credit_note_no);
check("returned stock back at KN", stockAt(KN, vBottle.id) === 2);
check("void refused at another branch", /made at Kalyani Nagar/.test(call("voidSale", { id: rKN.id, reason: "x" }, T, 1).message));
ok(call("voidSale", { id: rKN.id, reason: "Test" }, T, KN), "void at KN");
check("KN manager can't open a Kondhwa bill", !call("getSale", { id: rKD.id }, MEENA).success);

// the owner's "All branches"
check("no selling on All branches", branchesErr(call("completeSale", sellArgs({}), T, 0)));
check("no stock in on All branches", branchesErr(call("stockIn", { lines: [{ variant_id: vBottle.id, qty: 1 }] }, T, 0)));
const dashAll = ok(call("dashboard", {}, T, 0), "dashboard all branches");
check("dashboard per-branch rows", dashAll.by_branch && dashAll.by_branch.length === 2 && dashAll.by_branch.some((b) => b.name === "Kalyani Nagar" && b.bills >= 1), dashAll.by_branch);
const dcKN = ok(call("report", { type: "day_close" }, T, KN), "day close KN");
check("KN day close only KN bills", dcKN.bills === 1 && dcKN.branch_name === "Kalyani Nagar", { bills: dcKN.bills });
const dcAll = ok(call("report", { type: "day_close" }, T, 0), "day close all");
check("all-branches day close has breakdown", dcAll.by_branch.length === 2 && Math.abs(dcAll.by_branch.reduce((a, b) => a + b.net, 0) - dcAll.net) < 0.01, dcAll.by_branch);
// a customer belongs to the branch that billed them first, so the branches add up to the whole shop
const sumBr = (f) => dcAll.by_branch.reduce((a, b) => a + b[f], 0);
check("per-branch items add up to the whole shop", Math.abs(sumBr("items") - dcAll.by_salesman.reduce((a, r) => a + r.items, 0)) < 0.001, dcAll.by_branch);
check("a new customer is counted at one branch only", sumBr("new_customers") === dcAll.by_salesman.reduce((a, r) => a + r.new_customers, 0), dcAll.by_branch);
// the same customer billed at a second branch is not new there
const crossArgs = { client_ref: "cross-1", lines: [{ variant_id: vBottle.id, qty: 1 }], payments: [{ method: "cash", amount: 50 }], customer: { phone: "9822200011", name: "Cross Branch" } };
ok(call("completeSale", crossArgs, T, 1), "new customer's first bill at Kondhwa");
const knNewBefore = ok(call("dashboard", {}, T, KN), "KN dashboard before the cross-branch bill").today.new_customers;
ok(call("completeSale", Object.assign({}, crossArgs, { client_ref: "cross-2" }), KIRAN.token, KN), "same customer later at KN");
check("a customer is new to the shop once, not once per branch", ok(call("dashboard", {}, T, KN), "KN dash after").today.new_customers === knNewBefore, { knNewBefore });
check("and they count at the branch that billed them first", ok(call("dashboard", {}, T, 0), "all dash").by_branch.find((b) => b.branch_id === 1).new_customers >= 1);
check("salesperson can't use All", branchesErr(call("dashboard", {}, RAVI.token, 999)));

// expenses & held bills stay with their branch
ok(call("saveExpense", { title: "KN tea", amount: 40, method: "cash" }, MEENA), "KN expense");
check("KN expense not in Kondhwa list", !ok(call("listExpenses", {}, T, 1), "KD expenses").expenses.some((e) => e.title === "KN tea"));
check("KN expense in KN list", ok(call("listExpenses", {}, T, KN), "KN expenses").expenses.some((e) => e.title === "KN tea" && e.branch_name === "Kalyani Nagar"));
ok(call("holdBill", { label: "KN hold", cart: { lines: [{ variant_id: vBottle.id, qty: 1 }] } }, KIRAN.token), "hold at KN");
check("held bill not visible at Kondhwa", !ok(call("listHeld", {}, T, 1), "held KD").some((h) => h.label === "KN hold"));

// nightly email: one per branch, branch list + owner list
ok(call("saveSettings", { settings: { nightly_report: "yes", nightly_report_skip_empty: "no" } }, T), "nightly on for branch test");
env.mails.length = 0;
const nightly = ctx.sendNightlyReport();
check("one nightly email per branch", env.mails.length === 2 && /Kondhwa: sent/.test(nightly) && /Kalyani Nagar: sent/.test(nightly), nightly);
const knMail = env.mails.find((m) => /Kalyani Nagar/.test(m.subject));
check("KN email to KN list + owner list", knMail && knMail.to.split(",")[0] === "kn@x.in" && knMail.to.indexOf("owner@x.in") > 0, knMail && knMail.to);
ok(call("saveSettings", { settings: { nightly_report: "no" } }, T), "nightly off again");

// migration: stock counted before branches existed moves to branch 1
const envM = createEnv();
envM.ctx.setupSheets();
require("vm").runInContext(`appendRows_("Variants", [{ id: 1, product_id: 1, sku: "", barcode: "OLD1", size_label: "100ml", size_ml: 100, unit: "pcs", mrp: 10, sell_price: 10, avg_cost: 5, stock_qty: 7, reorder_level: 0, active: 1 }]);`, envM.ctx);
envM.ctx.setupSheets();
check("old stock moved to branch 1", require("vm").runInContext("stockOf_(1, 1)", envM.ctx) === 7);

// ================= final-review fixes =================
const vmRun = (code, c = ctx) => require("vm").runInContext(code, c);
// day close money is per branch
const methodsNet = (d) => Object.values(d.methods).reduce((a, m) => a + m.net, 0);
const dcKN2 = ok(call("report", { type: "day_close" }, T, KN), "day close KN (money)");
const dcKD2 = ok(call("report", { type: "day_close" }, T, 1), "day close KD (money)");
const dcAll2 = ok(call("report", { type: "day_close" }, T, 0), "day close all (money)");
check("KN money only KN", Math.abs(methodsNet(dcKN2) - dcKN2.net) < 0.01, { money: methodsNet(dcKN2), net: dcKN2.net });
check("KD money only KD", Math.abs(methodsNet(dcKD2) - dcKD2.net) < 0.01, { money: methodsNet(dcKD2), net: dcKD2.net });
check("branch money adds up to all", Math.abs(methodsNet(dcKN2) + methodsNet(dcKD2) - methodsNet(dcAll2)) < 0.01);
// cost prices hidden from salespeople in bill details
const rSale = ok(call("getSale", { id: rKD.id }, RAVI.token, 1), "salesperson opens own bill");
check("salesperson bill detail has no cost", rSale.items.every((i) => i.unit_cost === undefined));
check("manager bill detail keeps cost", ok(call("getSale", { id: kSale.id }, MEENA), "manager bill").items.every((i) => i.unit_cost !== undefined));
// expenses: KN-only manager can't touch a Kondhwa expense
const kdExp = ok(call("saveExpense", { title: "KD rent", amount: 100, method: "cash" }, T, 1), "KD expense").id;
check("KN manager can't delete KD expense", /another branch/.test(call("deleteExpense", { id: kdExp }, MEENA).message));
check("KN manager can't edit KD expense", /another branch/.test(call("saveExpense", { id: kdExp, title: "x", amount: 1 }, MEENA).message));
// staff whose only branch is closed can't fall into "all branches"
const TMP = ok(call("saveBranch", { name: "Temp", code: "TP" }, T), "temp branch").id;
ok(call("saveUser", { name: "Tina", email: "tina@x.in", role: "salesperson", password: "secret7", branch_id: TMP, branch_ids: [TMP] }, T), "add Tina");
const TINA = ok(call("login", { email: "tina@x.in", password: "secret7" }), "Tina login").token;
ok(call("saveBranch", { id: TMP, name: "Temp", code: "TP", active: 0 }, T), "close temp branch");
check("staff with no active branch refused", branchesErr(call("dashboard", {}, TINA)) && branchesErr(call("listSales", {}, TINA, 0)));
// old sessions are cleaned up at login
vmRun(`appendRows_("Sessions", [{ token: "x".repeat(64), user_id: ${RAVI.user.id}, created_at: "2020-01-01 00:00:00", expires_at: "2020-02-01 00:00:00", device: "old" }]);`);
ok(call("login", { email: "ravi@x.in", password: "secret4" }), "Ravi logs in again");
check("expired sessions removed", !vmRun(`resetReqCache_(); rows_("Sessions").some((s) => s.device === "old")`));
// sheet not upgraded after a code update → clear message, not a crash
envM.ss.getSheetByName("Sales").getRange(1, schemaColsOf("Sales", envM)).setValue("");
check("outdated sheet gives Setup message", vmRun(`resetReqCache_(); (() => { try { rows_("Sales"); return "no error"; } catch (e) { return e.code; } })()`, envM.ctx) === "SETUP");
envM.ctx.setupSheets(); // repairs it again
function schemaColsOf(name, e) {
    return require("vm").runInContext(`Object.keys(SCHEMA.${name}).length`, e.ctx);
}

// ---- setup never deletes the owner's own columns ----
const salesTab = env.ss.getSheetByName("Sales");
const schemaCols = require("vm").runInContext("Object.keys(SCHEMA.Sales).length", ctx);
const before = ok(call("listSales", { from: "2000-01-01" }, T, 0), "sales before own column").summary;
salesTab.insertColumnsAfter(salesTab.getMaxColumns(), 1);
salesTab.getRange(1, schemaCols + 1).setValue("Remarks");
salesTab.getRange(2, schemaCols + 1).setValue("VIP customer");
ctx.setupSheets();
const keptMsg = env.alerts.pop();
check("own column kept by setup", salesTab.getRange(2, schemaCols + 1).getValues()[0][0] === "VIP customer" && /Kept your extra columns in: Sales/.test(keptMsg), keptMsg);
const after = ok(call("listSales", { from: "2000-01-01" }, T, 0), "sales with own column").summary;
check("app unaffected by own column", after.bills === before.bills && after.net === before.net, { before, after });
check("empty spare columns still trimmed on new sheets", envM.ss.getSheetByName("Sales").getMaxColumns() === schemaCols);

// ---- delete a product added by mistake (owner, never used) ----
const mistake = ok(call("saveProduct", {
    name: "Typo Oud", brand_name: "Lattafa", category_id: cat("Eau De Parfum"), hsn: "3303", gst_rate: 18,
    variants: [{ size_label: "50ml", barcode: "DEL0001", mrp: 900, sell_price: 800, cost: 500, opening_stock: 3 }],
}, T, 1), "add mistaken product").id;
const mistakeVid = () => vmRun(`resetReqCache_(); (rows_("Variants").find((v) => v.barcode === "DEL0001") || {}).id || 0`);
const mVid = mistakeVid();
check("manager cannot delete product", call("deleteProduct", { id: mistake }, M, 1).code === "FORBIDDEN");
const RAVI2 = ok(call("login", { email: "ravi@x.in", password: "secret4" }), "Ravi login for delete test").token;
const sDel = call("deleteProduct", { id: mistake }, RAVI2, 1);
check("salesperson cannot delete product", sDel.code === "FORBIDDEN", sDel);
const heldDel = ok(call("holdBill", { label: "del test", cart: { lines: [{ variant_id: mVid, qty: 1 }] } }, T, 1), "hold mistaken product");
check("held bill blocks delete", /held bill/.test(call("deleteProduct", { id: mistake }, T, 1).message || ""));
ok(call("deleteHeld", { id: heldDel.id }, T, 1), "drop held bill");
ok(call("deleteProduct", { id: mistake }, T, 1), "owner deletes unused product");
check("product rows gone", vmRun(`resetReqCache_(); !rows_("Products").some((p) => p.id === ${mistake}) && !rows_("Variants").some((v) => v.id === ${mVid}) && !rows_("Branch_Stock").some((b) => b.variant_id === ${mVid}) && !rows_("Stock_Movements").some((m) => m.variant_id === ${mVid})`));
check("gone from catalog", !call("getCatalog", {}, T, 1).data.variants.some((v) => v.barcode === "DEL0001"));
check("delete logged", vmRun(`resetReqCache_(); rows_("Activity_Logs").some((l) => l.action === "DELETE" && l.entity === "Products" && /Typo Oud/.test(l.details))`));
ok(call("saveProduct", {
    name: "Real Oud", brand_name: "Lattafa", category_id: cat("Eau De Parfum"), hsn: "3303", gst_rate: 18,
    variants: [{ size_label: "50ml", barcode: "DEL0001", mrp: 900, sell_price: 800 }],
}, T, 1), "barcode reusable after delete");
const usedDel = call("deleteProduct", { id: asad.id }, T, 1);
check("sold product cannot be deleted", !usedDel.success && /hide it instead/.test(usedDel.message), usedDel);
check("sold product still there", call("getCatalog", {}, T, 1).data.variants.some((v) => v.barcode === "0628113420084"));

// ---- delete an empty category (owner) ----
const tempCat = ok(call("saveCategory", { name: "Temp Cat", default_hsn: "3307", default_gst: 18 }, T), "add temp category").id;
check("manager cannot delete category", call("deleteCategory", { id: tempCat }, M).code === "FORBIDDEN");
ok(call("deleteCategory", { id: tempCat }, T), "owner deletes empty category");
check("category gone from catalog", !call("getCatalog", {}, T, 1).data.categories.some((c) => c.id === tempCat));
check("category delete logged", vmRun(`resetReqCache_(); rows_("Activity_Logs").some((l) => l.action === "DELETE" && l.entity === "Categories" && l.details === "Temp Cat")`));
const usedCat = call("deleteCategory", { id: cat("Eau De Parfum") }, T);
check("category in use refused", !usedCat.success && /hide it instead/.test(usedCat.message), usedCat);
const hidCat = ok(call("saveCategory", { name: "Hidden Only", default_gst: 18 }, T), "add category for hidden product").id;
const hidProd = ok(call("saveProduct", { name: "Hidden Thing", brand_name: "Groovy", category_id: hidCat, hsn: "3307", gst_rate: 18,
    variants: [{ size_label: "1 pc", sell_price: 10 }] }, T, 1), "product in that category").id;
ok(call("toggleProduct", { id: hidProd }, T), "hide that product");
check("category with only a hidden product refused", /Used by 1 product /.test(call("deleteCategory", { id: hidCat }, T).message || ""));
const envC = createEnv();
envC.ctx.setupSheets();
const cPwd = /Password: (\S+)/.exec(envC.alerts.pop())[1];
const CT = envC.call("login", { email: "owner@groovy.test", password: cPwd }).data.token;
const allCats = envC.call("getCatalog", {}, CT).data.categories;
allCats.slice(1).forEach((c) => envC.call("deleteCategory", { id: c.id }, CT));
const lastCat = envC.call("deleteCategory", { id: allCats[0].id }, CT);
check("last category kept", !lastCat.success && /at least one/.test(lastCat.message) && envC.call("getCatalog", {}, CT).data.categories.length === 1, lastCat);

// ---- invoice PDFs in Drive ----
const gpFolder = env.drive.root.createFolder("Groovy POS");
env.drive.sheetFile.parent = gpFolder; // the owner moved the Sheet into "Groovy POS"
const pdfFiles = () => env.drive.files().filter((f) => !f.trashed && /\.pdf$/.test(f.name));
const pathOf = (f) => { const p = []; let x = f.parent; while (x) { p.unshift(x.name); x = x.parent; } return p.join("/"); };
check("PDF timer installed every 15 min", env.triggers.some((x) => x.fn === "savePendingInvoicePdfs" && x.minutes === 15), env.triggers);
const pdfSaleReq = { client_ref: "pdf-1", lines: [{ variant_id: vBottle.id, qty: 1 }], customer: { phone: "9876500001", name: "<b>Evil</b> & Co" }, payments: [{ method: "cash", amount: 50 }] };
const pdfSale = ok(call("completeSale", pdfSaleReq, T, 1), "sale for PDF").sale;
const pdf1 = ok(call("saveInvoicePdf", { id: pdfSale.id }, T, 1), "save PDF manually");
const pdfFile = pdfFiles().find((f) => f.name === pdfSale.invoice_no.replace(/\//g, "-") + ".pdf");
const fyDir = (d) => require("vm").runInContext("fyFolderName_(" + JSON.stringify(String(d)) + ")", ctx);
const monthDir = (d) => "My Drive/Groovy POS/Sales_Invoices/" + fyDir(d) + "/" + String(d).slice(5, 7);
check("PDF saved in Sales_Invoices/FY yyyy-yy/MM/<kind>", !!pdfFile && pathOf(pdfFile) === monthDir(pdfSale.date) + "/Non-GST", pdfFile && pathOf(pdfFile));
check("FY folder names", fyDir("2026-09-19") === "FY 2026-27" && fyDir("2027-02-10") === "FY 2026-27" && fyDir("2026-03-31") === "FY 2025-26" && fyDir("2099-12-01") === "FY 2099-00");
const febFolder = require("vm").runInContext('invoiceFolder_("2026-02-15", false)', ctx);
check("Feb bill goes to FY 2025-26/02", pathOf({ parent: febFolder }) === "My Drive/Groovy POS/Sales_Invoices/FY 2025-26/02/Non-GST", pathOf({ parent: febFolder }));

// GST bills go to the accountant's folder; bills without GST (or with no GSTIN set) go next door
ok(call("saveSettings", { settings: { gstin: "27ABCDE1234F1Z5" } }, T), "set GSTIN");
const gstSale = ok(call("completeSale", { client_ref: "pdf-gst", lines: [{ variant_id: vBottle.id, qty: 1 }], payments: [{ method: "cash", amount: 50 }] }, T, 1), "GST bill").sale;
ok(call("saveInvoicePdf", { id: gstSale.id }, T, 1), "save GST bill PDF");
const gstFile = pdfFiles().find((f) => f.name.startsWith(gstSale.invoice_no.replace(/[/]/g, "-")));
check("bill with GST → GST folder", gstFile && pathOf(gstFile) === monthDir(gstSale.date) + "/GST", gstFile && pathOf(gstFile));
const noGstSale = ok(call("completeSale", { client_ref: "pdf-nogst", gst_hidden: true, lines: [{ variant_id: vBottle.id, qty: 1 }], payments: [{ method: "cash", amount: 50 }] }, T, 1), "bill without GST shown").sale;
ok(call("saveInvoicePdf", { id: noGstSale.id }, T, 1), "save non-GST bill PDF");
const noGstFile = pdfFiles().find((f) => f.name.startsWith(noGstSale.invoice_no.replace(/[/]/g, "-")));
check("bill with GST hidden → Non-GST folder", noGstFile && pathOf(noGstFile) === monthDir(noGstSale.date) + "/Non-GST", noGstFile && pathOf(noGstFile));
// a credit note is filed with its bill
const gstDetail = ok(call("getSale", { id: gstSale.id }, T, 1), "GST bill detail");
ok(call("returnItems", { sale_id: gstSale.id, items: [{ sale_item_id: gstDetail.items[0].id, qty: 1, restock: true }], refund_method: "cash", reason: "test" }, T, 1), "return on the GST bill");
ctx.savePendingInvoicePdfs();
const cnFile = pdfFiles().filter((f) => /C-|CN-/.test(f.name)).pop();
check("credit note filed with its bill", cnFile && pathOf(cnFile).endsWith("/GST"), cnFile && pathOf(cnFile));
ok(call("saveSettings", { settings: { gstin: "" } }, T), "clear GSTIN again");
check("pdf_url stored on the bill", !!pdf1.pdf_url && ok(call("getSale", { id: pdfSale.id }, T, 1), "bill detail").sale.pdf_url === pdf1.pdf_url);
check("PDF html escapes customer name", pdfFile && pdfFile.html.includes("&lt;b&gt;Evil&lt;/b&gt; &amp; Co") && !pdfFile.html.includes("<b>Evil"));
// the savings line is worded like the receipt, and the whole page uses one sans face
check("savings line says 'You saved ₹X on MRP!'", pdfFile && /You saved [^<]+ on MRP!/.test(pdfFile.html), pdfFile && (/You saved[^<]*/.exec(pdfFile.html) || [])[0]);
check("no mixed serif font in the PDF", pdfFiles().every((f) => !/Georgia/.test(f.html) && !/[^-]serif/.test(f.html)));
// the document's name heads the page in a full-width centred band, not a block beside the letterhead
check("title band is full width and centred", pdfFile && /text-align:center[^>]*>INVOICE</.test(pdfFile.html) && !/width:150px/.test(pdfFile.html));
// Google's PDF converter paints text, borders and images but never a background, so nothing may rely on
// a fill to be readable: white text came out as near-invisible grey on the real PDF
pdfFiles().forEach((f) => check("no white text to vanish on (" + f.name + ")", !/#ffffff|#fff\b/i.test(f.html), (/color:\s*#f{3,6}/i.exec(f.html) || [])[0]));
check("title reads as brown text between rules", pdfFile && /border-top:2px solid #654321[^"]*color:#654321[^"]*text-align:center">INVOICE</.test(pdfFile.html));
check("items header is brown over a brown rule", pdfFile && /\.items th\{[^}]*color:#654321;border-bottom:2px solid #654321/.test(pdfFile.html));
// every total shares one table, which is what keeps Grand Total's divider in line with CGST/SGST
const totTables = (h) => (h.match(/<table class="tot"/g) || []).length;
check("totals are a single table", pdfFile && totTables(pdfFile.html) === 1 && /<tr class="grand"><td>Grand Total<\/td>/.test(pdfFile.html), totTables(pdfFile && pdfFile.html));
check("credit note totals are one table too", pdfFiles().some((f) => /CREDIT NOTE/.test(f.html) && totTables(f.html) === 1 && /<tr class="grand"><td>Refund</.test(f.html)));
const pdfCount = pdfFiles().length;
const pdf2 = ok(call("saveInvoicePdf", { id: pdfSale.id }, T, 1), "save PDF again");
check("second press: already saved, no duplicate file", pdf2.already === true && pdfFiles().length === pdfCount);
const RAVI3 = ok(call("login", { email: "ravi@x.in", password: "secret4" }), "Ravi login for PDF").token;
check("salesperson can't save someone else's bill PDF", call("saveInvoicePdf", { id: pdfSale.id }, RAVI3, 1).code === "FORBIDDEN");
// GST hidden → plain INVOICE without HSN/GST columns
const hidSale = ok(call("completeSale", Object.assign({}, pdfSaleReq, { client_ref: "pdf-2", gst_hidden: true, customer: {} }), T, 1), "gst-hidden sale").sale;
ok(call("saveInvoicePdf", { id: hidSale.id }, T, 1), "save gst-hidden PDF");
const hidFile = pdfFiles().find((f) => f.name.startsWith(hidSale.invoice_no.replace(/\//g, "-")));
check("GST hidden: no HSN / tax columns", hidFile && !hidFile.html.includes(">HSN<") && !hidFile.html.includes("TAX INVOICE") && hidFile.html.includes("INVOICE"));
// void after the PDF exists → timer renames it -VOID
ok(call("voidSale", { id: pdfSale.id, reason: "test" }, T, 1), "void PDF sale");
require("vm").runInContext("resetReqCache_()", ctx);
const jobDone = ctx.savePendingInvoicePdfs();
check("timer: renames voided bill's PDF", pdfFile.name === pdfSale.invoice_no.replace(/\//g, "-") + "-VOID.pdf", pdfFile.name);
const pdfLeft = require("vm").runInContext('resetReqCache_(); rows_("Sales").filter((s) => !s.pdf_url).length + rows_("Returns").filter((r) => !r.pdf_url).length', ctx);
check("timer: every bill and credit note now has a PDF", jobDone > 0 && pdfLeft === 0, { jobDone, pdfLeft });
check("credit notes saved as PDFs", require("vm").runInContext('rows_("Returns").every((r) => r.pdf_url)', ctx) &&
    pdfFiles().some((f) => /C-|CN-/.test(f.name) && f.html.includes("CREDIT NOTE")));
// the lock only looks at the bill's own row — if rows moved in between, it finds the bill the old way
const shiftSale = ok(call("completeSale", { client_ref: "pdf-shift", lines: [{ variant_id: vBottle.id, qty: 1 }], payments: [{ method: "cash", amount: 50 }] }, T, 1), "bill for the row-shift PDF").sale;
const neighbour = ok(call("completeSale", { client_ref: "pdf-shift-2", lines: [{ variant_id: vBottle.id, qty: 1 }], payments: [{ method: "cash", amount: 50 }] }, T, 1), "bill after it").sale;
const shiftRow = vmRun(`resetReqCache_(); globalThis.__shiftS = rows_("Sales").find((s) => s.id === ${shiftSale.id}); __shiftS._r`);
env.ss.getSheetByName("Sales").deleteRow(shiftRow - 1); // someone deletes the row above by hand: every row moves up one
const shifted = vmRun(`resetReqCache_(); savePdfForSale_(__shiftS)`);
const afterShift = ok(call("getSale", { id: shiftSale.id }, T, 1), "row-shift bill").sale;
const nbAfter = ok(call("getSale", { id: neighbour.id }, T, 1), "its neighbour").sale;
check("rows moved: PDF link still lands on the right bill", !!shifted.pdf_url && afterShift.pdf_url === shifted.pdf_url, { shifted, got: afterShift.pdf_url });
check("rows moved: the bill below is not touched", !nbAfter.pdf_url, nbAfter.pdf_url);
// another save got there first while this PDF was being made: keep the first link, bin the new file
const raceSale = vmRun(`resetReqCache_(); globalThis.__raceS = rows_("Sales").find((s) => s.id === ${neighbour.id}); __raceS.id`);
vmRun(`resetReqCache_(); const f = findBy_("Sales", "id", ${raceSale}); f.pdf_url = "https://drive.google.com/file/d/FIRST/view"; updateFields_("Sales", f, ["pdf_url"]);`);
const filesBefore = pdfFiles().length;
const raced = vmRun(`resetReqCache_(); savePdfForSale_(__raceS)`);
check("saved meanwhile: first link kept, reported as already saved", raced.already === true && raced.pdf_url === "https://drive.google.com/file/d/FIRST/view", raced);
check("saved meanwhile: the extra file is binned", pdfFiles().length === filesBefore, [filesBefore, pdfFiles().length]);
check("saved meanwhile: bill still has the first link", ok(call("getSale", { id: raceSale }, T, 1), "raced bill").sale.pdf_url === "https://drive.google.com/file/d/FIRST/view");
// old yyyy-MM folders (before the FY layout) are moved into FY …/MM by the timer; links stay the same
let pdfRootF = pdfFile.parent; // walk up to Sales_Invoices
while (pdfRootF && pdfRootF.name !== "Sales_Invoices") pdfRootF = pdfRootF.parent;
const oldDir = pdfRootF.createFolder("2026-08");
const oldPdf = oldDir.createFile({ name: "GF-26-27-OLD01.pdf", mime: "application/pdf", html: "old" });
const oldUrl = oldPdf.getUrl();
ctx.savePendingInvoicePdfs();
check("old month folder: PDF moved to FY 2026-27/08, same id and link", pathOf(oldPdf) === "My Drive/Groovy POS/Sales_Invoices/FY 2026-27/08" && oldPdf.getUrl() === oldUrl, pathOf(oldPdf));
check("old month folder binned", oldDir.trashed === true);

// Folders are found by name, never remembered by id: a Drive folder keeps its id through a rename and
// a move, so remembering ids made the app follow a folder someone had filed elsewhere.
const dirNamed = (parent, name) => { const it = parent.getFoldersByName(name); return it.hasNext() ? it.next() : null; };
// each save is its own Apps Script execution in production, so the per-run folder memo starts empty
const newRun = () => require("vm").runInContext("PDF_DIRS_ = {}", ctx);
const saveBill = (ref, gstHidden) => {
    const s = ok(call("completeSale", { client_ref: ref, gst_hidden: !!gstHidden, lines: [{ variant_id: vBottle.id, qty: 1 }], payments: [{ method: "cash", amount: 50 }] }, T, 1), "bill " + ref).sale;
    newRun();
    ok(call("saveInvoicePdf", { id: s.id }, T, 1), "save PDF " + ref);
    return pdfFiles().find((f) => f.name.startsWith(s.invoice_no.replace(/[/]/g, "-")));
};
ok(call("saveSettings", { settings: { gstin: "27ABCDE1234F1Z5" } }, T), "GSTIN on for folder tests");
const TODAY = require("vm").runInContext("todayStr_()", ctx);
const fyName = fyDir(TODAY);
newRun();
const rootF = require("vm").runInContext("invoiceRoot_()", ctx);
// the reported case: rename the FY folder and move it to the top of the drive
const fyF = dirNamed(rootF, fyName);
check("the FY folder is there to begin with", !!fyF, fyName);
fyF.setName("FY 2026-27 OLD");
fyF.moveTo(env.drive.root);
const afterRename = saveBill("dir-1");
check("renamed and moved FY folder: a fresh one is built by name",
    pathOf(afterRename) === monthDir(TODAY) + "/GST", pathOf(afterRename));
check("the moved folder is left alone", fyF.name === "FY 2026-27 OLD" && pathOf({ parent: fyF }) === "My Drive/FY 2026-27 OLD", pathOf({ parent: fyF }));
// moving Sales_Invoices itself is rebuilt the same way
newRun();
const rootBefore = require("vm").runInContext("invoiceRoot_()", ctx);
rootBefore.moveTo(env.drive.root);
rootBefore.setName("Sales_Invoices ARCHIVE");
const afterRootMove = saveBill("dir-2");
check("moved Sales_Invoices: a new one appears beside the Sheet",
    pathOf(afterRootMove) === monthDir(TODAY) + "/GST", pathOf(afterRootMove));
// the two kinds are each created on their first bill of that kind
newRun();
const freshRoot = require("vm").runInContext("invoiceRoot_()", ctx);
const freshMonth = dirNamed(dirNamed(freshRoot, fyName), TODAY.slice(5, 7));
check("Non-GST is not created before it is needed", !dirNamed(freshMonth, "Non-GST"));
const firstNonGst = saveBill("dir-3", true);
check("first non-GST bill creates Non-GST", pathOf(firstNonGst) === monthDir(TODAY) + "/Non-GST", pathOf(firstNonGst));
// a bill in another month gets its own month folder under the same FY
newRun();
const janFolder = require("vm").runInContext('invoiceFolder_("2027-01-09", true)', ctx);
check("a new month gets its own folder", pathOf({ parent: janFolder }) === "My Drive/Groovy POS/Sales_Invoices/FY 2026-27/01/GST", pathOf({ parent: janFolder }));
// running again must not duplicate anything
const countUnder = (parent, name) => { let n = 0; const it = parent.getFoldersByName(name); while (it.hasNext()) { it.next(); n++; } return n; };
saveBill("dir-4");
ctx.savePendingInvoicePdfs();
newRun();
const root2 = require("vm").runInContext("invoiceRoot_()", ctx);
const fy2 = dirNamed(root2, fyName);
check("no duplicate folders after repeated runs",
    countUnder(root2, fyName) === 1 && countUnder(fy2, TODAY.slice(5, 7)) === 1 &&
    countUnder(dirNamed(fy2, TODAY.slice(5, 7)), "GST") === 1,
    { fy: countUnder(root2, fyName) });
check("links on older bills still work", !!pdf1.pdf_url && pdf1.pdf_url.indexOf("/d/") > 0, pdf1.pdf_url);
const pdfTotal = pdfFiles().length;
check("timer again: nothing new to do", ctx.savePendingInvoicePdfs() === 0 && pdfFiles().length === pdfTotal);
// turning it off removes the timer and stops the job
ok(call("saveSettings", { settings: { invoice_pdfs: "no" } }, T), "PDFs off");
check("PDFs off: timer removed", !env.triggers.some((x) => x.fn === "savePendingInvoicePdfs"));
ok(call("completeSale", Object.assign({}, pdfSaleReq, { client_ref: "pdf-3", customer: {} }), T, 1), "sale while PDFs off");
check("PDFs off: job does nothing", ctx.savePendingInvoicePdfs() === undefined && pdfFiles().length === pdfTotal);
ok(call("saveSettings", { settings: { invoice_pdfs: "yes" } }, T), "PDFs on");
check("PDFs on: timer back", env.triggers.filter((x) => x.fn === "savePendingInvoicePdfs").length === 1);

// Generate SKU continues the website series (SKU-0001 …); numbers are never handed out twice
const genSku = () => call("generateSku", {}, T, 1);
const skuHigh = Math.max(...call("getCatalog", {}, T).data.variants.map((v) => (/^SKU-(\d+)$/i.exec(v.sku || "") || [0, 0])[1]).map(Number));
const g1 = genSku().data.sku;
const g2 = genSku().data.sku;
check("generateSku: next after highest SKU-####", g1 === "SKU-" + String(skuHigh + 1).padStart(4, "0") && g2 === "SKU-" + String(skuHigh + 2).padStart(4, "0"), { skuHigh, g1, g2 });
const g3prod = ok(call("saveProduct", { name: "Gen Sku Item", brand_name: "X", category_id: cat("Eau De Parfum"), gst_rate: 18, variants: [{ size_label: "10ml", sell_price: 100, sku: genSku().data.sku }] }, T, 1), "save with generated SKU").id;
const g3sku = call("getCatalog", {}, T).data.variants.find((v) => v.product_id === g3prod).sku;
ok(call("deleteProduct", { id: g3prod }, T, 1), "delete item with the highest SKU");
check("deleted item's SKU number not reused", genSku().data.sku === "SKU-" + String(Number(g3sku.slice(4)) + 1).padStart(4, "0"), g3sku);
check("salesperson can't generate SKU", call("generateSku", {}, RAVI3, 1).code === "FORBIDDEN");
check("sku counter hidden from app settings", !("sku_seq" in call("bootstrap", {}, T, 1).data.settings));

// ---- reset test data (keep setup) on a fresh env ----
const envR = createEnv();
envR.ctx.setupSheets();
const rPwd = /Password: (\S+)/.exec(envR.alerts.pop())[1];
const RT = envR.call("login", { email: "owner@groovy.test", password: rPwd }).data.token;
const rRun = (code) => require("vm").runInContext("resetReqCache_(); " + code, envR.ctx);
const rCat = envR.call("getCatalog", {}, RT).data.categories[0].id;
envR.call("saveSettings", { settings: { business_name: "Groovy Test Shop" } }, RT);
const rProd = envR.call("saveProduct", {
    name: "Reset Oud", brand_name: "Groovy", category_id: rCat, hsn: "3303", gst_rate: 18,
    variants: [{ size_label: "50ml", barcode: "RST001", mrp: 500, sell_price: 400, cost: 200, opening_stock: 5 }],
}, RT).data.id;
const rVid = envR.call("getCatalog", {}, RT).data.variants.find((v) => v.barcode === "RST001").id;
envR.call("generateBarcode", {}, RT);
check("reset: test data created",
    envR.call("stockIn", { lines: [{ variant_id: rVid, qty: 2, unit_cost: 200 }] }, RT).success &&
    envR.call("completeSale", { client_ref: "r-1", lines: [{ variant_id: rVid, qty: 1 }], customer: { phone: "9999988888", name: "Test" },
        payments: [{ method: "cash", amount: 400 }] }, RT).success &&
    envR.call("saveExpense", { title: "Tea", amount: 20, method: "cash" }, RT).success &&
    envR.call("holdBill", { cart: { lines: [{ variant_id: rVid, qty: 1 }] } }, RT).success);
const rVer = envR.call("getCatalog", {}, RT).data.version;
const rBc = String(rRun('setting_("internal_barcode_seq")'));
const rRes = envR.ctx.resetTestData_();
check("reset: day-to-day tabs empty", rRun('RESET_TABS_.filter((n) => n !== "Activity_Logs").every((n) => rows_(n).length === 0)'), rRes);
check("reset: only the reset log entry left", rRun('rows_("Activity_Logs").length === 1 && rows_("Activity_Logs")[0].action === "RESET"'));
check("reset: stock 0", rRun('rows_("Variants").every((v) => v.stock_qty === 0)'));
check("reset: setup kept", rRun(
    'rows_("Products").some((p) => p.id === ' + rProd + ') && rows_("Users").length === 1 && rows_("Branches").length >= 1 && ' +
    'rows_("Categories").length > 1 && setting_("business_name") === "Groovy Test Shop"'));
check("reset: bill counters removed, barcode counter kept",
    rRun('!rows_("Settings").some((s) => /^(inv|cn)_seq_/.test(s.key)) && String(setting_("internal_barcode_seq"))') === rBc);
check("reset: old login rejected", envR.call("getCatalog", {}, RT).code === "AUTH_EXPIRED");
const RT2 = envR.call("login", { email: "owner@groovy.test", password: rPwd }).data.token;
check("reset: catalog version bumped", envR.call("getCatalog", {}, RT2).data.version > rVer);
envR.call("stockIn", { lines: [{ variant_id: rVid, qty: 3, unit_cost: 200 }] }, RT2);
const rstSale = envR.call("completeSale", { client_ref: "r-2", lines: [{ variant_id: rVid, qty: 1 }], payments: [{ method: "cash", amount: 400 }] }, RT2);
check("reset: bill numbers restart", rstSale.success && /\/00001$/.test(rstSale.data.sale.invoice_no), rstSale);
check("reset: stock works after", envR.call("getCatalog", {}, RT2).data.variants.find((v) => v.id === rVid).stock_qty === 2);

// ---- an unchanged catalogue is not sent again (the whole payload is the app's biggest download) ----
const cv = envR.call("getCatalog", {}, RT2).data;
check("catalogue reply says which branch its stock is for", cv.branch_id !== undefined, cv.branch_id);
const same = envR.call("getCatalog", { catalog_version: cv.version, catalog_branch: cv.branch_id }, RT2).data;
check("same version + branch: payload skipped", same.unchanged === true && !same.variants && !same.products && same.version === cv.version, same);
const older = envR.call("getCatalog", { catalog_version: cv.version - 1, catalog_branch: cv.branch_id }, RT2).data;
check("older version: full payload", !older.unchanged && Array.isArray(older.variants) && older.variants.length > 0);
check("no version sent (an older app): full payload", !envR.call("getCatalog", {}, RT2).data.unchanged);
// stock is per branch, so the same version at a different branch must still send the figures
const otherBranch = envR.call("getCatalog", { catalog_version: cv.version, catalog_branch: cv.branch_id + 99 }, RT2).data;
check("same version, different branch: full payload", !otherBranch.unchanged && Array.isArray(otherBranch.variants));
// a sale moves stock but not the catalogue: the big payload is NOT sent again, and the new figure
// arrives as a small stock update instead
const beforeStock = envR.call("getStock", {}, RT2, 1).data;
envR.call("completeSale", { client_ref: "r-4", lines: [{ variant_id: rVid, qty: 1 }], payments: [{ method: "cash", amount: 400 }] }, RT2, 1);
const afterSale = envR.call("getCatalog", { catalog_version: cv.version, catalog_branch: cv.branch_id }, RT2).data;
check("after a sale the catalogue is not sent again", afterSale.unchanged === true && afterSale.version === cv.version, afterSale.version);
const afterStock = envR.call("getStock", { since: beforeStock.at }, RT2, 1).data;
check("after a sale the stock update carries the new figure",
    afterStock.stock_version > beforeStock.stock_version && afterStock.changed[rVid] === cv.variants.find((v) => v.id === rVid).stock_qty - 1,
    { changed: afterStock.changed, was: cv.variants.find((v) => v.id === rVid).stock_qty });
// the stock update is the whole current map (no movement history is read), and it is exactly the
// catalogue's stock — every variant, this branch and per branch
const catNow = envR.call("getCatalog", {}, RT2, 1).data;
check("the stock update is the whole current map", afterStock.full === true, afterStock.full);
check("...and matches the catalogue for every variant", catNow.variants.every((v) =>
    (afterStock.changed[v.id] || 0) === v.stock_qty && JSON.stringify(afterStock.by_branch[v.id] || {}) === JSON.stringify(v.stock_by_branch)),
    catNow.variants.filter((v) => (afterStock.changed[v.id] || 0) !== v.stock_qty).map((v) => [v.id, afterStock.changed[v.id], v.stock_qty]));
// with no starting point, the whole map comes back and says so
const wholeMap = envR.call("getStock", {}, RT2, 1).data;
check("a device with no starting point gets the whole stock map", wholeMap.full === true && Object.keys(wholeMap.changed).length > 0, Object.keys(wholeMap.changed).length);
// a catalogue edit still does move the version, and the payload comes again
const gateBrand = envR.call("saveBrand", { name: "Gate Test Brand" }, RT2, 1);
const afterEdit = envR.call("getCatalog", { catalog_version: cv.version, catalog_branch: cv.branch_id }, RT2, 1).data;
check("editing the catalogue does send it again", gateBrand.success && !afterEdit.unchanged && afterEdit.version > cv.version, { brand: gateBrand.message, version: afterEdit.version, was: cv.version });
// bootstrap carries the same gate, since that is what the app calls on open
const bootGate = envR.call("bootstrap", { catalog_version: afterEdit.version, catalog_branch: afterEdit.branch_id }, RT2, 1).data;
check("bootstrap skips an unchanged catalogue too", bootGate.catalog.unchanged === true && !bootGate.catalog.variants && !!bootGate.settings && !!bootGate.user, bootGate.catalog);

// cost price is manager-only, so a role change makes a cached catalogue the wrong shape for that
// person — the version must move, or the gate above would keep handing them a cost-less copy
const crewRes = ok(envR.call("saveUser", { name: "Crew", email: "crew@x.in", role: "salesperson", password: "secret9" }, RT2), "add a salesperson");
const crewId = crewRes.id;
const crewToken = () => envR.call("login", { email: "crew@x.in", password: "secret9" }).data.token;
const CREW = crewToken();
const crewCat = envR.call("getCatalog", {}, CREW, 1).data;
check("a salesperson's catalogue has no cost price", crewCat.variants.every((v) => v.avg_cost === undefined), Object.keys(crewCat.variants[0]));
check("a manager's catalogue has cost price", envR.call("getCatalog", {}, RT2).data.variants.some((v) => "avg_cost" in v));
const verBefore = envR.call("getCatalog", {}, RT2).data.version;
ok(envR.call("saveUser", { id: crewId, name: "Crew Renamed", email: "crew@x.in", role: "salesperson" }, RT2), "edit name only");
check("editing a name does not make every phone refetch", envR.call("getCatalog", {}, RT2).data.version === verBefore);
ok(envR.call("saveUser", { id: crewId, name: "Crew Renamed", email: "crew@x.in", role: "manager" }, RT2), "promote to manager");
const verAfter = envR.call("getCatalog", {}, RT2).data.version;
check("a role change moves the version", verAfter > verBefore, { verBefore, verAfter });
const CREW2 = crewToken();
const crewAgain = envR.call("getCatalog", { catalog_version: crewCat.version, catalog_branch: crewCat.branch_id }, CREW2, 1).data;
check("the promoted salesperson gets a full catalogue, with cost price",
    !crewAgain.unchanged && crewAgain.variants.some((v) => "avg_cost" in v), crewAgain.unchanged);

// ---- log everyone out: ends logins and touches nothing else ----
const beforeOut = {
    version: envR.call("getCatalog", {}, RT2).data.version,
    variants: rRun('rows_("Variants").map((v) => v.id + ":" + v.stock_qty).join(",")'),
    sales: rRun('rows_("Sales").length'),
    products: rRun('rows_("Products").length'),
};
const ended = envR.ctx.logoutEveryone_();
check("logout all: sessions ended", ended >= 1 && rRun('rows_("Sessions").length === 0'), ended);
check("logout all: old token rejected", envR.call("getCatalog", {}, RT2).code === "AUTH_EXPIRED");
const RT3 = envR.call("login", { email: "owner@groovy.test", password: rPwd }).data.token;
check("logout all: nothing else moved",
    envR.call("getCatalog", {}, RT3).data.version === beforeOut.version &&
    rRun('rows_("Variants").map((v) => v.id + ":" + v.stock_qty).join(",")') === beforeOut.variants &&
    rRun('rows_("Sales").length') === beforeOut.sales && rRun('rows_("Products").length') === beforeOut.products, beforeOut);
check("logout all: app works after logging in again",
    envR.call("completeSale", { client_ref: "r-3", lines: [{ variant_id: rVid, qty: 1 }], payments: [{ method: "cash", amount: 400 }] }, RT3).success);

// ---- reset EVERYTHING: the catalogue goes too, the shop setup stays ----
const envA = createEnv();
envA.ctx.setupSheets();
const aPwd = /Password: (\S+)/.exec(envA.alerts.pop())[1];
const AT = envA.call("login", { email: "owner@groovy.test", password: aPwd }).data.token;
const aRun = (code) => require("vm").runInContext("resetReqCache_(); " + code, envA.ctx);
envA.call("saveSettings", { settings: { business_name: "Groovy Erase Test" } }, AT);
const aCat = envA.call("getCatalog", {}, AT).data.categories[0].id;
envA.call("saveProduct", {
    name: "Erase Oud", brand_name: "Groovy", category_id: aCat, hsn: "3303", gst_rate: 18,
    variants: [{ size_label: "50ml", barcode: "ERS001", mrp: 500, sell_price: 400, cost: 200, opening_stock: 5 }],
}, AT);
const aVid = envA.call("getCatalog", {}, AT).data.variants.find((v) => v.barcode === "ERS001").id;
envA.call("generateBarcode", {}, AT);
const aBc = String(aRun('setting_("internal_barcode_seq")'));
check("erase: test data created",
    envA.call("completeSale", { client_ref: "a-1", lines: [{ variant_id: aVid, qty: 1 }], payments: [{ method: "cash", amount: 400 }] }, AT).success &&
    envA.call("saveExpense", { title: "Tea", amount: 20, method: "cash" }, AT).success);
const aVer = envA.call("getCatalog", {}, AT).data.version;
const aRes = envA.ctx.resetAll_();
check("erase: catalogue emptied", aRun('["Variants", "Products", "Brands"].every((n) => rows_(n).length === 0)'), aRes);
check("erase: day-to-day tabs emptied too", aRun('RESET_TABS_.filter((n) => n !== "Activity_Logs").every((n) => rows_(n).length === 0)'));
check("erase: standard categories restored, not left empty",
    aRun("rows_(\"Categories\").length") === require("vm").runInContext("DEFAULT_CATEGORIES.length", envA.ctx), aRun('rows_("Categories").length'));
check("erase: staff, branches and settings kept",
    aRun('rows_("Users").length === 1 && rows_("Branches").length >= 1 && setting_("business_name") === "Groovy Erase Test"'));
check("erase: barcode counter kept, so printed labels stay unique", aRun('String(setting_("internal_barcode_seq"))') === aBc);
check("erase: old login rejected", envA.call("getCatalog", {}, AT).code === "AUTH_EXPIRED");
const AT2 = envA.call("login", { email: "owner@groovy.test", password: aPwd }).data.token;
check("erase: catalog version bumped", envA.call("getCatalog", {}, AT2).data.version > aVer);
// the shop can be built again from nothing
const aProd2 = envA.call("saveProduct", {
    name: "Fresh Start", brand_name: "New Brand", category_id: envA.call("getCatalog", {}, AT2).data.categories[0].id, gst_rate: 18,
    variants: [{ size_label: "30ml", sell_price: 300, mrp: 300, opening_stock: 4 }],
}, AT2, 1);
check("erase: a product can be added again", aProd2.success, aProd2);
const aVid2 = envA.call("getCatalog", {}, AT2).data.variants[0].id;
const aSale = envA.call("completeSale", { client_ref: "a-2", lines: [{ variant_id: aVid2, qty: 1 }], payments: [{ method: "cash", amount: 300 }] }, AT2, 1);
check("erase: bill numbers restart at 00001", aSale.success && /\/00001$/.test(aSale.data.sale.invoice_no), aSale);

// ---- demo seed on a fresh env ----
const env2 = createEnv();
env2.ctx.setupSheets();
env2.ctx.seedDemo();
const demoMsg = env2.alerts.pop();
check("demo seeded", /Demo data loaded/.test(demoMsg), demoMsg);
const bills = /(\d+) bills/.exec(demoMsg)[1];
const salesRows = env2.ctx.rows_("Sales").length;
check("demo sales saved", salesRows > 20, { salesRows, bills });

// ---- reading less of the sheet: block and tail reads must return exactly what a full read would ----
// (own env, so the row order can be meddled with safely)
const wrenvR2 = createEnv();
wrenvR2.ctx.setupSheets();
const wrrPwd = /Password: (\S+)/.exec(wrenvR2.alerts.pop())[1];
const wrRT = wrenvR2.call("login", { email: "owner@groovy.test", password: wrrPwd }).data.token;
const wrrCat = wrenvR2.call("bootstrap", {}, wrRT).data.catalog.categories[0].id;
wrenvR2.call("saveProduct", {
    name: "Window Tester", category_id: wrrCat, gst_rate: 18,
    variants: [{ size_label: "10ml", mrp: 100, sell_price: 100, cost: 40, opening_stock: 500, barcode: "WIN0001" }],
}, wrRT);
const wrrVid = wrenvR2.call("getCatalog", {}, wrRT).data.variants.find((v) => v.barcode === "WIN0001").id;
const wrrOwner = wrenvR2.ctx.findBy_("Users", "email", "owner@groovy.test");
const wrrBill = (ref, at) =>
    wrenvR2.ctx.apiCompleteSale_(
        { client_ref: ref, lines: [{ variant_id: wrrVid, qty: 1 }], payments: [{ method: "cash", amount: 100 }], _at: at },
        { user: wrrOwner, token: "", branch_id: 1 },
    ).data.sale;
// three days of bills, then one written out of order (an older date appended last, as an import would)
wrrBill("w-1", "2026-03-01 09:00:00");
const wrrMid = wrrBill("w-2", "2026-03-02 23:59:59");
const wrrLast = wrrBill("w-3", "2026-03-03 00:00:00");
const wrrOld = wrrBill("w-4", "2026-03-02 08:00:00");
const wrrList = (from, to) => wrenvR2.call("listSales", { from, to }, wrRT).data.sales.map((s) => s.invoice_no);
check("window read: one day, both ends of the clock", wrrList("2026-03-02", "2026-03-02").length === 2, wrrList("2026-03-02", "2026-03-02"));
check("window read: a row written out of order is still found", wrrList("2026-03-02", "2026-03-02").indexOf(wrrOld.invoice_no) >= 0, wrrOld.invoice_no);
check("window read: a date with nothing on it", wrrList("2026-02-01", "2026-02-01").length === 0);
check("window read: the whole range matches a full scan", wrrList("2026-03-01", "2026-03-03").length === 4, wrrList("2026-03-01", "2026-03-03"));
check("window read: boundaries are inclusive", wrrList("2026-03-03", "2026-03-03")[0] === wrrLast.invoice_no, wrrList("2026-03-03", "2026-03-03"));
// one bill's detail must carry only its own lines
const wrrDetail = wrenvR2.call("getSale", { id: wrrMid.id }, wrRT).data;
check("block read: a bill's lines are its own", wrrDetail.items.length === 1 && wrrDetail.items.every((i) => i.sale_id === wrrMid.id), wrrDetail.items);
check("block read: a bill's payments are its own", wrrDetail.payments.length > 0 && wrrDetail.payments.every((x) => x.sale_id === wrrMid.id), wrrDetail.payments);
// a day close over out-of-order rows still totals every bill of that day
const wrrDc = wrenvR2.call("report", { type: "day_close", date: "2026-03-02" }, wrRT).data;
check("day close covers out-of-order rows", wrrDc.bills === 2 && Math.abs(wrrDc.sales - 200) < 0.01, { bills: wrrDc.bills, sales: wrrDc.sales });
// the newest log lines, in order, however many there are
for (let i = 0; i < 40; i++) wrenvR2.ctx.log_({ user: { id: 1, name: "Owner" } }, "TEST", "Bench", i, "line " + i);
const wrrLogs = wrenvR2.call("listLogs", { limit: 10 }, wrRT).data;
check("tail read: newest logs first", wrrLogs.length === 10 && wrrLogs[0].details === "line 39" && wrrLogs[9].details === "line 30", wrrLogs.map((l) => l.details));
check("tail read: a search still looks past the newest rows", wrenvR2.call("listLogs", { q: "line 3", limit: 300 }, wrRT).data.length >= 11);
// a product whose last movement is older than the tail window is still found (the fallback path)
for (let i = 0; i < 60; i++)
    wrenvR2.ctx.appendRows_("Stock_Movements", [{
        id: wrenvR2.ctx.nextId_("Stock_Movements"), variant_id: 9999, type: "adjust", qty: 1, unit_cost: 0, balance: i,
        ref_type: "test", ref_id: String(i), note: "filler", user_id: 1, at: "2026-03-04 10:00:00", branch_id: 1,
    }]);
const wrrMoves = wrenvR2.call("movements", { variant_id: wrrVid, limit: 50 }, wrRT).data;
check("tail read: an older product's history is still found", wrrMoves.length > 0 && wrrMoves.every((m) => m.variant_id === wrrVid), wrrMoves.length);
// one customer's bills, found without reading every bill
const wrrCust = wrenvR2.call("saveCustomer", { name: "Window Cust", phone: "9876500123" }, wrRT).data;
wrwrrBill2 = wrenvR2.ctx.apiCompleteSale_(
    { client_ref: "w-5", lines: [{ variant_id: wrrVid, qty: 1 }], payments: [{ method: "cash", amount: 100 }], customer: { phone: "9876500123" } },
    { user: wrrOwner, token: "", branch_id: 1 },
).data.sale;
const rHist = wrenvR2.call("customerHistory", { id: wrrCust.id }, wrRT).data;
check("block read: a customer's own bills", rHist.sales.length === 1 && rHist.sales[0].invoice_no === wrwrrBill2.invoice_no, rHist.sales);

// ---- the kept copy of the catalogue must never be the stale one ----
const ccPrice = () => envR2c.call("getCatalog", {}, CCT).data.variants.find((v) => v.barcode === "CC0001").sell_price;
const envR2c = createEnv();
envR2c.ctx.setupSheets();
const ccPwd = /Password: (\S+)/.exec(envR2c.alerts.pop())[1];
const CCT = envR2c.call("login", { email: "owner@groovy.test", password: ccPwd }).data.token;
const ccCat = envR2c.call("bootstrap", {}, CCT).data.catalog.categories[0].id;
const ccProd = envR2c.call("saveProduct", {
    name: "Cache Tester", category_id: ccCat, gst_rate: 18,
    variants: [{ size_label: "20ml", mrp: 500, sell_price: 400, cost: 100, opening_stock: 10, barcode: "CC0001" }],
}, CCT).data;
check("catalogue: first read", ccPrice() === 400, ccPrice());
check("catalogue: second read is the same", ccPrice() === 400, ccPrice());
// a price change must show up at once, cache or no cache
const ccVar = envR2c.call("getCatalog", {}, CCT).data.variants.find((v) => v.barcode === "CC0001");
envR2c.call("saveProduct", {
    id: ccProd.id, name: "Cache Tester", category_id: ccCat, gst_rate: 18,
    variants: [{ id: ccVar.id, size_label: "20ml", mrp: 500, sell_price: 450, barcode: "CC0001" }],
}, CCT);
check("catalogue: a price change is picked up immediately", ccPrice() === 450, ccPrice());
// a name change too, and the product count stays right
envR2c.call("saveProduct", {
    id: ccProd.id, name: "Cache Tester Renamed", category_id: ccCat, gst_rate: 18,
    variants: [{ id: ccVar.id, size_label: "20ml", mrp: 500, sell_price: 450, barcode: "CC0001" }],
}, CCT);
const ccAfter = envR2c.call("getCatalog", {}, CCT).data;
check("catalogue: a rename is picked up immediately", ccAfter.products.some((p) => p.name === "Cache Tester Renamed"), ccAfter.products.map((p) => p.name));
check("catalogue: nothing is duplicated or lost", ccAfter.variants.filter((v) => v.barcode === "CC0001").length === 1, ccAfter.variants.length);
// stock is never taken from the kept copy: selling one must show one fewer straight away
const ccOwner = envR2c.ctx.findBy_("Users", "email", "owner@groovy.test");
envR2c.ctx.apiCompleteSale_(
    { client_ref: "cc-1", lines: [{ variant_id: ccVar.id, qty: 1 }], payments: [{ method: "cash", amount: 450 }] },
    { user: ccOwner, token: "", branch_id: 1 },
);
check("catalogue: stock is current even when the rest is kept", envR2c.call("getCatalog", {}, CCT).data.variants.find((v) => v.barcode === "CC0001").stock_qty === 9,
    envR2c.call("getCatalog", {}, CCT).data.variants.find((v) => v.barcode === "CC0001").stock_qty);
// a salesperson still never sees cost prices, even though the kept copy holds them
envR2c.call("saveUser", { name: "Cache Salesman", email: "cs@x.in", role: "salesperson", password: "secret9" }, CCT);
const CST = envR2c.call("login", { email: "cs@x.in", password: "secret9" }).data.token;
check("catalogue: cost stays hidden from a salesperson", envR2c.call("getCatalog", {}, CST).data.variants.every((v) => v.avg_cost === undefined));

// ---- the role was renamed from "salesman" to "salesperson": nobody may be locked out by it ----
const rnEnv = createEnv();
rnEnv.ctx.setupSheets();
const rnPwd = /Password: (\S+)/.exec(rnEnv.alerts.pop())[1];
const RNT = rnEnv.call("login", { email: "owner@groovy.test", password: rnPwd }).data.token;
const rnCat = rnEnv.call("bootstrap", {}, RNT).data.catalog.categories[0].id;
rnEnv.call("saveProduct", {
    name: "Role Tester", category_id: rnCat, gst_rate: 18,
    variants: [{ size_label: "5ml", mrp: 100, sell_price: 100, cost: 40, opening_stock: 50, barcode: "ROLE001" }],
}, RNT);
const rnVid = rnEnv.call("getCatalog", {}, RNT).data.variants.find((v) => v.barcode === "ROLE001").id;

// a staff row still stored the old way — exactly what every existing shop has until the sweep runs
rnEnv.call("saveUser", { name: "Old Row", email: "oldrow@x.in", role: "salesperson", password: "secret5" }, RNT);
const rnOld = rnEnv.ctx.findBy_("Users", "email", "oldrow@x.in");
rnOld.role = "salesman";
rnEnv.ctx.updateRows_("Users", [rnOld]);
const rnOldLogin = rnEnv.call("login", { email: "oldrow@x.in", password: "secret5" });
check("old role name: can still log in", rnOldLogin.success, rnOldLogin.message);
const OLDT = rnOldLogin.data.token;
check("old role name: is reported as salesperson", rnOldLogin.data.user.role === "salesperson", rnOldLogin.data.user.role);
check("old role name: can still sell", rnEnv.call("completeSale", {
    client_ref: "rn-1", lines: [{ variant_id: rnVid, qty: 1 }], payments: [{ method: "cash", amount: 100 }],
}, OLDT).success);
check("old role name: still kept out of staff", rnEnv.call("listUsers", {}, OLDT).code === "FORBIDDEN");
check("old role name: still kept out of stock-in", rnEnv.call("stockIn", { lines: [{ variant_id: rnVid, qty: 1 }] }, OLDT).code === "FORBIDDEN");
check("old role name: still sees only their own bills", rnEnv.call("listSales", {}, OLDT).data.sales.every((s) => s.salesman_name === "Old Row"));
check("old role name: cost price still hidden", rnEnv.call("getCatalog", {}, OLDT).data.variants.every((v) => v.avg_cost === undefined));

// an app that has not updated yet still sends the old word when saving staff
const rnLegacySave = rnEnv.call("saveUser", { name: "Legacy App", email: "legacy@x.in", role: "salesman", password: "secret6" }, RNT);
check("an app sending the old role name still saves", rnLegacySave.success, rnLegacySave.message);
check("...and it is stored under the new name", rnEnv.ctx.findBy_("Users", "email", "legacy@x.in").role === "salesperson",
    rnEnv.ctx.findBy_("Users", "email", "legacy@x.in").role);

// the one-time sweep rewrites what is left, once
check("rows still holding the old name are swept", rnEnv.ctx.migrateRoleNames_() === 1);
check("every staff row now reads salesperson", rnEnv.ctx.rows_("Users").every((u) => u.role !== "salesman"),
    rnEnv.ctx.rows_("Users").map((u) => u.role));
check("a second sweep finds nothing left to do", rnEnv.ctx.migrateRoleNames_() === 0);
check("the swept account still works", rnEnv.call("listSales", {}, OLDT).success);

// the owner and managers are untouched by any of this
rnEnv.call("saveUser", { name: "Mgr", email: "mgr-rn@x.in", role: "manager", password: "secret7" }, RNT);
const MGRT = rnEnv.call("login", { email: "mgr-rn@x.in", password: "secret7" }).data.token;
check("a manager still has manager rights", rnEnv.call("stockIn", { lines: [{ variant_id: rnVid, qty: 1, unit_cost: 40 }] }, MGRT).success);
check("an unknown role is still rejected", !rnEnv.call("saveUser", { name: "Nope", email: "nope@x.in", role: "wizard", password: "secret8" }, RNT).success);

// ---- backups: a copy of the sheet and the invoices, in Back_up ----
// (own env: the Drive tree is inspected directly, and bills are backdated into two months)
const bkEnv = createEnv();
const bkDrive = bkEnv.drive;
const bkGp = bkDrive.root.createFolder("Groovy POS");
bkDrive.sheetFile.parent = bkGp; // the sheet lives in the Groovy POS folder, as it does for real
bkEnv.ctx.setupSheets();
const bkPwd = /Password: (\S+)/.exec(bkEnv.alerts.pop())[1];
const BKT = bkEnv.call("login", { email: "owner@groovy.test", password: bkPwd }).data.token;
const bkCat = bkEnv.call("bootstrap", {}, BKT).data.catalog.categories[0].id;
bkEnv.call("saveProduct", {
    name: "Backup Tester", category_id: bkCat, gst_rate: 18,
    variants: [{ size_label: "5ml", mrp: 100, sell_price: 100, cost: 40, opening_stock: 500, barcode: "BK0001" }],
}, BKT);
const bkVid = bkEnv.call("getCatalog", {}, BKT).data.variants.find((v) => v.barcode === "BK0001").id;
const bkOwner = bkEnv.ctx.findBy_("Users", "email", "owner@groovy.test");
const bkBill = (ref, at) =>
    bkEnv.ctx.apiCompleteSale_(
        { client_ref: ref, lines: [{ variant_id: bkVid, qty: 1 }], payments: [{ method: "cash", amount: 100 }], _at: at },
        { user: bkOwner, token: "", branch_id: 1 },
    ).data.sale;
// two bills in August, one in September
bkBill("bk-1", "2026-08-10 10:00:00");
bkBill("bk-2", "2026-08-20 10:00:00");
bkBill("bk-3", "2026-09-05 10:00:00");
bkEnv.ctx.savePendingInvoicePdfs(); // files them under Sales_Invoices/FY 2026-27/08 and /09

const bkFolder = (parent, name) => { const it = parent.getFoldersByName(name); return it.hasNext() ? it.next() : null; };
const bkRoot = () => bkFolder(bkGp, "Back_up");
const bkPdfs = (folder) => {
    // every pdf anywhere under this folder
    const out = [];
    const walk = (f) => {
        const files = f.getFiles();
        while (files.hasNext()) { const x = files.next(); if (!x.trashed && /\.pdf$/.test(x.getName())) out.push(x); }
        const subs = f.getFolders();
        while (subs.hasNext()) walk(subs.next());
    };
    walk(folder);
    return out;
};
const bkPath = (f) => { const p = []; let x = f.parent; while (x) { p.unshift(x.name); x = x.parent; } return p.join("/"); };
const bkNamed = (folder, name) => { const it = folder.getFilesByName(name); return it.hasNext() ? it.next() : null; };

// the monthly job, run as if it were 1 September: it must cover August only
bkEnv.ctx.todayStr_ = undefined; // (todayStr_ is read through the vm context below)
require("vm").runInContext('todayStr_ = function () { return "2026-09-01"; };', bkEnv.ctx);
const bkMonthly = bkEnv.ctx.monthlyBackup();
check("monthly backup: folder is named for the month it covers", !!bkFolder(bkRoot(), "2026-08"), bkRoot() ? "no 2026-08" : "no Back_up");
const bkAug = bkFolder(bkRoot(), "2026-08");
check("monthly backup: the sheet is copied", !!bkNamed(bkAug, "Groovy POS Data 2026-08"), bkAug.getFiles().hasNext());
check("monthly backup: August's invoices, and only those", bkPdfs(bkAug).length === 2, bkPdfs(bkAug).map((f) => f.getName()));
check("monthly backup: filed the way they are stored", /Back_up\/2026-08\/Sales_Invoices\/FY 2026-27\/08\//.test(bkPath(bkPdfs(bkAug)[0])), bkPath(bkPdfs(bkAug)[0]));
check("monthly backup: says it finished", !!bkNamed(bkAug, "BACKUP COMPLETE.txt") && !bkNamed(bkAug, "BACKUP IN PROGRESS.txt"));
check("monthly backup: reports what it did", bkMonthly.invoices === 2 && bkMonthly.sheet === true && bkMonthly.finished === true, bkMonthly);

// running it again must not copy anything a second time
const bkAgain = bkEnv.ctx.monthlyBackup();
check("monthly backup again: nothing is copied twice", bkAgain.invoices === 0 && bkAgain.sheet === false, bkAgain);
check("monthly backup again: still one copy of each file", bkPdfs(bkAug).length === 2, bkPdfs(bkAug).length);
check("monthly backup again: one folder, not two", bkRoot().getFolders().hasNext(), true);

// a manual backup of everything, twice in the same day → two folders side by side
require("vm").runInContext('backupStamp_ = function () { return "2026-09-25 09-15"; };', bkEnv.ctx);
require("vm").runInContext('SpreadsheetApp.getUi = function () { return { alert: function () { return "YES"; }, Button: { YES: "YES", NO: "NO", CANCEL: "CANCEL" }, ButtonSet: { YES_NO_CANCEL: 1 } }; };', bkEnv.ctx);
bkEnv.ctx.backupNow();
const bkManual = bkFolder(bkRoot(), "2026-09-25 09-15");
check("manual backup: a folder stamped with the time", !!bkManual);
check("manual backup: every invoice, both months", bkPdfs(bkManual).length === 3, bkPdfs(bkManual).map((f) => f.getName()));
check("manual backup: the sheet too", !!bkNamed(bkManual, "Groovy POS Data 2026-09-25 09-15"));
check("manual backup: says it finished", !!bkNamed(bkManual, "BACKUP COMPLETE.txt"));
require("vm").runInContext('backupStamp_ = function () { return "2026-09-25 18-40"; };', bkEnv.ctx);
bkEnv.ctx.backupNow();
check("a second backup the same day sits beside the first", !!bkFolder(bkRoot(), "2026-09-25 18-40") && !!bkFolder(bkRoot(), "2026-09-25 09-15"));
check("the earlier backup is untouched", bkPdfs(bkFolder(bkRoot(), "2026-09-25 09-15")).length === 3);

// a run that is cut short leaves the marker, and the next one finishes the job
require("vm").runInContext('backupStamp_ = function () { return "2026-09-26 07-00"; };', bkEnv.ctx);
require("vm").runInContext('backupBudget_ = function () { var n = 0; return function () { return n++ < 2; }; };', bkEnv.ctx); // time runs out almost at once
bkEnv.ctx.backupNow();
const bkPart = bkFolder(bkRoot(), "2026-09-26 07-00");
check("interrupted: the folder says it is still running", !!bkNamed(bkPart, "BACKUP IN PROGRESS.txt") && !bkNamed(bkPart, "BACKUP COMPLETE.txt"));
check("interrupted: what is left to do is written down", /Months: /.test(bkNamed(bkPart, "BACKUP IN PROGRESS.txt").getBlob().getDataAsString()),
    bkNamed(bkPart, "BACKUP IN PROGRESS.txt").getBlob().getDataAsString());
check("interrupted: a follow-up run is booked", bkEnv.triggers.filter((t) => t.fn === "resumeBackup").length === 1, bkEnv.triggers.map((t) => t.fn));
const bkPartCount = bkPdfs(bkPart).length;
require("vm").runInContext('backupBudget_ = function () { return function () { return true; }; };', bkEnv.ctx); // time again
bkEnv.ctx.resumeBackup();
check("resumed: the same folder is finished off", !!bkNamed(bkPart, "BACKUP COMPLETE.txt") && !bkNamed(bkPart, "BACKUP IN PROGRESS.txt"));
check("resumed: every invoice is there, none twice", bkPdfs(bkPart).length === 3 && bkPartCount <= 3, { after: bkPdfs(bkPart).length, before: bkPartCount });
check("resumed: the follow-up booking is cleared", bkEnv.triggers.filter((t) => t.fn === "resumeBackup").length === 0);
check("resume with nothing to do is harmless", bkEnv.ctx.resumeBackup() === null);

// the monthly trigger installs itself, and only once
check("the monthly trigger is installed by the timer", bkEnv.triggers.filter((t) => t.fn === "monthlyBackup").length === 1, bkEnv.triggers.map((t) => t.fn));
const bkTrig = bkEnv.triggers.find((t) => t.fn === "monthlyBackup");
check("the monthly trigger runs on the 1st at 6am", bkTrig.monthDay === 1 && bkTrig.hour === 6 && bkTrig.tz === "Asia/Kolkata", bkTrig);
bkEnv.ctx.savePendingInvoicePdfs();
check("the timer does not add a second one", bkEnv.triggers.filter((t) => t.fn === "monthlyBackup").length === 1);

// a failure is emailed and logged
bkEnv.call("saveSettings", { settings: { report_emails: "owner@x.in" } }, BKT);
const bkMailsBefore = bkEnv.mails.length;
require("vm").runInContext('backupRoot_ = function () { throw new Error("Drive is full"); };', bkEnv.ctx);
let bkThrew = false;
try { bkEnv.ctx.monthlyBackup(); } catch (e) { bkThrew = true; }
check("a failed backup is reported, not silent", bkThrew && bkEnv.mails.length === bkMailsBefore + 1, { bkThrew, mails: bkEnv.mails.length - bkMailsBefore });
check("the email says what went wrong", /Drive is full/.test(bkEnv.mails[bkEnv.mails.length - 1].body), bkEnv.mails[bkEnv.mails.length - 1].subject);
check("and it is in the activity log", bkEnv.ctx.rows_("Activity_Logs").some((l) => l.action === "BACKUP_FAILED"),
    bkEnv.ctx.rows_("Activity_Logs").slice(-3).map((l) => l.action));
check("a successful backup is logged too", bkEnv.ctx.rows_("Activity_Logs").some((l) => l.action === "BACKUP"));

// ---- backups: product photos, and running the monthly one by hand ----
const b2Env = createEnv();
const b2Drive = b2Env.drive;
const b2Gp = b2Drive.root.createFolder("Groovy POS");
b2Drive.sheetFile.parent = b2Gp;
// the photo folder sits at the top of Drive, not beside the sheet — that is where uploads go
const b2Images = b2Drive.root.createFolder("GroovyPOS_Images");
b2Images.createFile({ name: "attar-1.jpg", mime: "image/jpeg", html: "photo one" });
b2Images.createFile({ name: "attar-2.jpg", mime: "image/jpeg", html: "photo two" });
b2Env.ctx.setupSheets();
const b2Pwd = /Password: (\S+)/.exec(b2Env.alerts.pop())[1];
const B2T = b2Env.call("login", { email: "owner@groovy.test", password: b2Pwd }).data.token;
const b2Cat = b2Env.call("bootstrap", {}, B2T).data.catalog.categories[0].id;
b2Env.call("saveProduct", {
    name: "Photo Tester", category_id: b2Cat, gst_rate: 18,
    variants: [{ size_label: "5ml", mrp: 100, sell_price: 100, cost: 40, opening_stock: 500, barcode: "B2-1" }],
}, B2T);
const b2Vid = b2Env.call("getCatalog", {}, B2T).data.variants.find((v) => v.barcode === "B2-1").id;
const b2Owner = b2Env.ctx.findBy_("Users", "email", "owner@groovy.test");
const b2Bill = (ref, at) =>
    b2Env.ctx.apiCompleteSale_(
        { client_ref: ref, lines: [{ variant_id: b2Vid, qty: 1 }], payments: [{ method: "cash", amount: 100 }], _at: at },
        { user: b2Owner, token: "", branch_id: 1 },
    ).data.sale;
b2Bill("b2-1", "2026-08-11 10:00:00");
b2Bill("b2-2", "2026-09-06 10:00:00");
b2Env.ctx.savePendingInvoicePdfs();

const b2Folder = (parent, name) => { const it = parent.getFoldersByName(name); return it.hasNext() ? it.next() : null; };
const b2Root = () => b2Folder(b2Gp, "Back_up");
const b2Named = (folder, name) => { const it = folder.getFilesByName(name); return it.hasNext() ? it.next() : null; };
const b2Count = (folder) => { let n = 0; const f = folder.getFiles(); while (f.hasNext()) { if (!f.next().trashed) n++; } return n; };
const b2Yes = 'SpreadsheetApp.getUi = function () { return { alert: function () { return "YES"; }, Button: { YES: "YES", NO: "NO", CANCEL: "CANCEL" }, ButtonSet: { YES_NO_CANCEL: 1, YES_NO: 2 } }; };';
const b2No = 'SpreadsheetApp.getUi = function () { return { alert: function () { return "NO"; }, Button: { YES: "YES", NO: "NO", CANCEL: "CANCEL" }, ButtonSet: { YES_NO_CANCEL: 1, YES_NO: 2 } }; };';

// a full backup takes the photos too
require("vm").runInContext('backupStamp_ = function () { return "2026-09-25 10-00"; };', b2Env.ctx);
require("vm").runInContext(b2Yes, b2Env.ctx);
b2Env.ctx.backupNow();
const b2Full = b2Folder(b2Root(), "2026-09-25 10-00");
const b2FullImgs = b2Folder(b2Full, "GroovyPOS_Images");
check("full backup: the product photos come too", !!b2FullImgs && b2Count(b2FullImgs) === 2, b2FullImgs ? b2Count(b2FullImgs) : "no folder");
check("full backup: the photos are counted in the note", /Photo files: 2/.test(b2Named(b2Full, "BACKUP COMPLETE.txt").getBlob().getDataAsString()),
    b2Named(b2Full, "BACKUP COMPLETE.txt").getBlob().getDataAsString());
check("full backup: the invoices are still there", !!b2Folder(b2Full, "Sales_Invoices"));

// a month-only backup leaves the photos alone
require("vm").runInContext('backupStamp_ = function () { return "2026-09-25 11-00"; };', b2Env.ctx);
require("vm").runInContext(b2No, b2Env.ctx);
b2Env.ctx.backupNow();
const b2Month = b2Folder(b2Root(), "2026-09-25 11-00");
check("a month's backup does not copy the photos", !b2Folder(b2Month, "GroovyPOS_Images"));
check("a month's backup still copies that month's invoices", !!b2Folder(b2Month, "Sales_Invoices"));

// a full backup that runs out of time during the photos must not say COMPLETE
require("vm").runInContext('backupStamp_ = function () { return "2026-09-25 12-00"; };', b2Env.ctx);
require("vm").runInContext(b2Yes, b2Env.ctx);
require("vm").runInContext('backupBudget_ = function () { var n = 0; return function () { return n++ < 6; }; };', b2Env.ctx);
b2Env.ctx.backupNow();
const b2Cut = b2Folder(b2Root(), "2026-09-25 12-00");
const b2Busy = b2Named(b2Cut, "BACKUP IN PROGRESS.txt");
check("cut short during the photos: not marked finished", !!b2Busy && !b2Named(b2Cut, "BACKUP COMPLETE.txt"), b2Busy ? "busy" : "no marker");
check("cut short during the photos: the note remembers to do them", /Images: yes/.test(b2Busy.getBlob().getDataAsString()), b2Busy.getBlob().getDataAsString());
require("vm").runInContext('backupBudget_ = function () { return function () { return true; }; };', b2Env.ctx);
b2Env.ctx.resumeBackup();
check("resumed: the photos are finished off", b2Count(b2Folder(b2Cut, "GroovyPOS_Images")) === 2, b2Count(b2Folder(b2Cut, "GroovyPOS_Images") || b2Cut));
check("resumed: only then is it COMPLETE", !!b2Named(b2Cut, "BACKUP COMPLETE.txt") && !b2Named(b2Cut, "BACKUP IN PROGRESS.txt"));

// "Back up last month" from the menu does what the 1st-of-the-month job does
require("vm").runInContext('todayStr_ = function () { return "2026-09-20"; };', b2Env.ctx);
require("vm").runInContext(b2Yes, b2Env.ctx);
b2Env.ctx.backupLastMonth();
const b2Aug = b2Folder(b2Root(), "2026-08");
check("back up last month: the folder is named for August", !!b2Aug);
check("back up last month: August's invoice, and the sheet", !!b2Folder(b2Aug, "Sales_Invoices") && !!b2Named(b2Aug, "Groovy POS Data 2026-08"));
check("back up last month: no photos in the monthly one", !b2Folder(b2Aug, "GroovyPOS_Images"));
check("back up last month: says it finished", !!b2Named(b2Aug, "BACKUP COMPLETE.txt"));
const b2AugFiles = b2Count(b2Aug);
b2Env.ctx.backupLastMonth();
check("back up last month again: nothing is copied twice", b2Count(b2Aug) === b2AugFiles, { before: b2AugFiles, after: b2Count(b2Aug) });
require("vm").runInContext(b2No, b2Env.ctx);
b2Env.ctx.backupLastMonth();
check("back up last month: saying no changes nothing", /Nothing was changed/.test(b2Env.alerts[b2Env.alerts.length - 1]), b2Env.alerts[b2Env.alerts.length - 1]);

// a shop with no photos at all is fine
const b2NoImg = createEnv();
b2NoImg.drive.sheetFile.parent = b2NoImg.drive.root.createFolder("Groovy POS");
b2NoImg.ctx.setupSheets();
b2NoImg.alerts.pop();
require("vm").runInContext('backupStamp_ = function () { return "2026-09-25 13-00"; };', b2NoImg.ctx);
require("vm").runInContext(b2Yes, b2NoImg.ctx);
b2NoImg.ctx.backupNow();
const b2Empty = (() => { const it = b2NoImg.drive.root.getFolders(); while (it.hasNext()) { const f = it.next(); if (f.getName() === "Groovy POS") { const b = f.getFoldersByName("Back_up"); if (b.hasNext()) return b.next().getFoldersByName("2026-09-25 13-00").next(); } } return null; })();
check("a shop with no photos backs up without complaint", !!b2Empty && !!b2Named(b2Empty, "BACKUP COMPLETE.txt"));

const countLiveImages = (folder) => { let n = 0; const it = folder.getFiles(); while (it.hasNext()) { if (!it.next().trashed) n++; } return n; };
// ---- a reset clears the Drive files of what it deleted, and never touches Back_up ----
const rdEnv = createEnv();
const rdDrive = rdEnv.drive;
const rdGp = rdDrive.root.createFolder("Groovy POS");
rdDrive.sheetFile.parent = rdGp;
const rdImages = rdDrive.root.createFolder("GroovyPOS_Images");
["a.jpg", "b.jpg"].forEach((n) => rdImages.createFile({ name: n, mime: "image/jpeg", html: "x" }));
rdEnv.ctx.setupSheets();
const rdPwd = /Password: (\S+)/.exec(rdEnv.alerts.pop())[1];
const RDT = rdEnv.call("login", { email: "owner@groovy.test", password: rdPwd }).data.token;
const rdCat = rdEnv.call("bootstrap", {}, RDT).data.catalog.categories[0].id;
rdEnv.call("saveProduct", {
    name: "Reset Drive Tester", category_id: rdCat, gst_rate: 18,
    variants: [{ size_label: "5ml", mrp: 100, sell_price: 100, cost: 40, opening_stock: 50, barcode: "RD1" }],
}, RDT);
const rdVid = rdEnv.call("getCatalog", {}, RDT).data.variants.find((v) => v.barcode === "RD1").id;
const rdOwner = rdEnv.ctx.findBy_("Users", "email", "owner@groovy.test");
["rd-1", "rd-2"].forEach((ref) =>
    rdEnv.ctx.apiCompleteSale_(
        { client_ref: ref, lines: [{ variant_id: rdVid, qty: 1 }], payments: [{ method: "cash", amount: 100 }] },
        { user: rdOwner, token: "", branch_id: 1 },
    ));
rdEnv.ctx.savePendingInvoicePdfs();

const rdYes = 'SpreadsheetApp.getUi = function () { return { alert: function () { return "YES"; }, prompt: function () { return { getSelectedButton: function () { return "OK"; }, getResponseText: function () { return PROMPT_ANSWER; } }; }, Button: { YES: "YES", NO: "NO", OK: "OK", CANCEL: "CANCEL" }, ButtonSet: { YES_NO_CANCEL: 1, YES_NO: 2, OK_CANCEL: 3 } }; };';
const rdLive = (f) => !f.trashed;
const rdPdfsUnder = (folder) => {
    const out = [];
    const walk = (f) => {
        if (f.trashed) return;
        const files = f.getFiles();
        while (files.hasNext()) { const x = files.next(); if (rdLive(x) && /\.pdf$/.test(x.getName())) out.push(x); }
        const subs = f.getFolders();
        while (subs.hasNext()) walk(subs.next());
    };
    walk(folder);
    return out;
};
const rdFolder = (parent, name) => { const it = parent.getFoldersByName(name); return it.hasNext() ? it.next() : null; };

// a full backup first, exactly as you would before wiping anything
require("vm").runInContext(rdYes, rdEnv.ctx);
require("vm").runInContext('backupStamp_ = function () { return "2026-09-25 08-00"; };', rdEnv.ctx);
rdEnv.ctx.backupNow();
const rdBackup = rdFolder(rdFolder(rdGp, "Back_up"), "2026-09-25 08-00");
const rdBackedUpPdfs = rdPdfsUnder(rdBackup).length;
const rdBackedUpPhotos = (() => { const f = rdFolder(rdBackup, "GroovyPOS_Images"); let n = 0; const it = f.getFiles(); while (it.hasNext()) { if (rdLive(it.next())) n++; } return n; })();
check("before the reset: the backup holds the invoices and photos", rdBackedUpPdfs === 2 && rdBackedUpPhotos === 2, { rdBackedUpPdfs, rdBackedUpPhotos });
check("the warning names the backup it found", /Last finished backup: 2026-09-25 08-00/.test(rdEnv.ctx.backupStatusLine_()), rdEnv.ctx.backupStatusLine_());

// option 3: bills and their PDFs go; products and photos stay
require("vm").runInContext('PROMPT_ANSWER = "RESET";', rdEnv.ctx);
rdEnv.ctx.resetTestData();
const rdInvoiceRoot = rdFolder(rdGp, "Sales_Invoices");
check("reset test data: the invoice PDFs are gone", rdPdfsUnder(rdInvoiceRoot).length === 0, rdPdfsUnder(rdInvoiceRoot).map((f) => f.getName()));
check("reset test data: the Sales_Invoices folder itself stays", !!rdInvoiceRoot && !rdInvoiceRoot.trashed);
check("reset test data: the product photos are kept", countLiveImages(rdImages) === 2, countLiveImages(rdImages));
check("reset test data: products are kept", rdEnv.ctx.rows_("Products").length === 1);
check("reset test data: the backup is untouched", rdPdfsUnder(rdBackup).length === 2 && !rdBackup.trashed, rdPdfsUnder(rdBackup).length);

// a new bill after the reset starts at 00001 again and does not clash with anything
// (a reset zeroes the stock and logs everyone out, so both are put back first)
const RDT2 = rdEnv.call("login", { email: "owner@groovy.test", password: rdPwd }).data.token;
rdEnv.call("adjustStock", { variant_id: rdVid, mode: "set", qty: 10 }, RDT2, 1);
rdEnv.ctx.apiCompleteSale_(
    { client_ref: "rd-3", lines: [{ variant_id: rdVid, qty: 1 }], payments: [{ method: "cash", amount: 100 }] },
    { user: rdEnv.ctx.findBy_("Users", "email", "owner@groovy.test"), token: "", branch_id: 1 });
rdEnv.ctx.savePendingInvoicePdfs();
const rdFresh = rdPdfsUnder(rdFolder(rdGp, "Sales_Invoices"));
check("after the reset: one bill, one PDF, no duplicate name", rdFresh.length === 1 && /00001/.test(rdFresh[0].getName()), rdFresh.map((f) => f.getName()));

// option 4: the photos go too
require("vm").runInContext('PROMPT_ANSWER = "ERASE ALL";', rdEnv.ctx);
rdEnv.ctx.resetAll();
check("reset everything: the photos are gone", countLiveImages(rdImages) === 0, countLiveImages(rdImages));
check("reset everything: the photo folder itself stays, ready for the next upload", !rdImages.trashed);
check("reset everything: the invoice PDFs are gone", rdPdfsUnder(rdFolder(rdGp, "Sales_Invoices")).length === 0);
check("reset everything: products are gone", rdEnv.ctx.rows_("Products").length === 0);
check("reset everything: the backup still has everything", rdPdfsUnder(rdBackup).length === 2 && !rdBackup.trashed, rdPdfsUnder(rdBackup).length);
check("reset everything: the backup's photos are still there too",
    (() => { const f = rdFolder(rdBackup, "GroovyPOS_Images"); let n = 0; const it = f.getFiles(); while (it.hasNext()) { if (rdLive(it.next())) n++; } return n; })() === 2);
check("reset everything: the Back_up folder is never binned", !rdFolder(rdGp, "Back_up").trashed);

// with no backup at all, the warning says so plainly
const rdNoBk = createEnv();
rdNoBk.drive.sheetFile.parent = rdNoBk.drive.root.createFolder("Groovy POS");
rdNoBk.ctx.setupSheets();
rdNoBk.alerts.pop();
check("with no backup, the warning says so", /no finished backup yet/.test(rdNoBk.ctx.backupStatusLine_()), rdNoBk.ctx.backupStatusLine_());

// ---- "admin" became "owner": every power must survive, for a row still stored the old way ----
const owEnv = createEnv();
owEnv.ctx.setupSheets();
const owPwd = /Password: (\S+)/.exec(owEnv.alerts.pop())[1];
const OWT0 = owEnv.call("login", { email: "owner@groovy.test", password: owPwd }).data.token;
const owCat = owEnv.call("bootstrap", {}, OWT0).data.catalog.categories[0].id;
owEnv.call("saveProduct", {
    name: "Owner Tester", category_id: owCat, gst_rate: 18,
    variants: [{ size_label: "5ml", mrp: 100, sell_price: 100, cost: 40, opening_stock: 50, barcode: "OW1" }],
}, OWT0);
const owVid = owEnv.call("getCatalog", {}, OWT0).data.variants.find((v) => v.barcode === "OW1").id;
owEnv.call("saveUser", { name: "Mgr Owner Test", email: "mgr-ow@x.in", role: "manager", password: "secret1" }, OWT0);
owEnv.call("saveUser", { name: "Sp Owner Test", email: "sp-ow@x.in", role: "salesperson", password: "secret2" }, OWT0);
const OWM = owEnv.call("login", { email: "mgr-ow@x.in", password: "secret1" }).data.token;
const OWS = owEnv.call("login", { email: "sp-ow@x.in", password: "secret2" }).data.token;

// put the owner's row back to the word it was stored under before this rename
const owRow = owEnv.ctx.findBy_("Users", "email", "owner@groovy.test");
owRow.role = "ad" + "min";
owEnv.ctx.updateRows_("Users", [owRow]);
const owLogin = owEnv.call("login", { email: "owner@groovy.test", password: owPwd });
check("old role name: the owner can still log in", owLogin.success, owLogin.message);
const OWT = owLogin.data.token;
check("old role name: reported as owner", owLogin.data.user.role === "owner", owLogin.data.user.role);
check("old role name: still works at every branch", owLogin.data.user.home_branch_id === 0, owLogin.data.user.home_branch_id);

// every power the owner alone has, with the row still stored the old way
check("owner power: staff", owEnv.call("listUsers", {}, OWT).success);
check("owner power: settings", owEnv.call("saveSettings", { settings: { tagline: "Smell Of Perfection" } }, OWT).success);
check("owner power: activity log", owEnv.call("listLogs", {}, OWT).success);
check("owner power: branches", owEnv.call("listBranches", {}, OWT).success);
check("owner power: add a branch", owEnv.call("saveBranch", { name: "Owner Test Branch", code: "OT" }, OWT).success);
const owTempCat = owEnv.call("saveCategory", { name: "Owner Temp Cat" }, OWT).data.id;
check("owner power: delete a category", owEnv.call("deleteCategory", { id: owTempCat }, OWT).success);
const owMistake = owEnv.call("saveProduct", { name: "Mistake", category_id: owCat, gst_rate: 18, variants: [{ size_label: "1ml", sell_price: 10, mrp: 10 }] }, OWT).data.id;
check("owner power: delete a product", owEnv.call("deleteProduct", { id: owMistake }, OWT).success);
check("owner power: reads across all branches", owEnv.call("dashboard", {}, OWT, 0).success);

// and the others are still kept out of all of it
check("a manager is still refused staff", owEnv.call("listUsers", {}, OWM).code === "FORBIDDEN");
check("a manager is still refused settings", owEnv.call("saveSettings", { settings: { tagline: "x" } }, OWM).code === "FORBIDDEN");
check("a manager is still refused the activity log", owEnv.call("listLogs", {}, OWM).code === "FORBIDDEN");
check("a manager is still refused branches", owEnv.call("listBranches", {}, OWM).code === "FORBIDDEN");
check("a salesperson is still refused staff", owEnv.call("listUsers", {}, OWS).code === "FORBIDDEN");
check("a salesperson is still refused stock-in", owEnv.call("stockIn", { lines: [{ variant_id: owVid, qty: 1 }] }, OWS).code === "FORBIDDEN");
check("a manager still cannot see report emails", owEnv.call("getSettings", {}, OWM).data.report_emails === undefined);
check("the owner can see report emails", owEnv.call("getSettings", {}, OWT).data.report_emails !== undefined);

// the two that would fail without a sound: nobody gets the day close, or the nightly job finds no one
owEnv.call("saveSettings", { settings: { report_emails: "" } }, OWT); // empty list = send to the owner
const owMailsBefore = owEnv.mails.length;
const owMail = owEnv.call("emailDayClose", {}, OWT);
check("day close still reaches the owner when no list is set", owMail.success && owEnv.mails.length === owMailsBefore + 1, owMail.message);
check("...and it is addressed to them", /owner@groovy\.test/.test(owEnv.mails[owEnv.mails.length - 1].to), owEnv.mails[owEnv.mails.length - 1].to);
check("the nightly job can still find an owner to run as", !!owEnv.ctx.rows_("Users").find((u) => owEnv.ctx.roleName_(u.role) === "owner"));

// an app that has not updated yet still saves an Admin, stored under the new name
const owLegacy = owEnv.call("saveUser", { name: "Legacy Owner", email: "legacy-ow@x.in", role: "ad" + "min", password: "secret3" }, OWT);
check("an app sending the old role name still saves", owLegacy.success, owLegacy.message);
check("...and it is stored as owner", owEnv.ctx.findBy_("Users", "email", "legacy-ow@x.in").role === "owner",
    owEnv.ctx.findBy_("Users", "email", "legacy-ow@x.in").role);
check("the new account has the owner's powers", owEnv.call("listUsers", {}, owEnv.call("login", { email: "legacy-ow@x.in", password: "secret3" }).data.token).success);

// the sweep rewrites what is left, both old words, and is safe to run twice
check("rows still holding an old role name are swept", owEnv.ctx.migrateRoleNames_() >= 1);
check("no old role name is left in the sheet", owEnv.ctx.rows_("Users").every((u) => u.role === "owner" || u.role === "manager" || u.role === "salesperson"),
    owEnv.ctx.rows_("Users").map((u) => u.role));
check("a second sweep finds nothing to do", owEnv.ctx.migrateRoleNames_() === 0);
check("the swept owner still has every power", owEnv.call("listUsers", {}, OWT).success && owEnv.call("listLogs", {}, OWT).success);
check("an unknown role is still rejected", !owEnv.call("saveUser", { name: "Nope", email: "nope-ow@x.in", role: "boss", password: "secret4" }, OWT).success);

// ---- a salesperson may take returns, but only up to salesperson_max_return ----
const capEnv = createEnv();
capEnv.ctx.setupSheets();
const capPwd = /Password: (\S+)/.exec(capEnv.alerts.pop())[1];
const CAPT = capEnv.call("login", { email: "owner@groovy.test", password: capPwd }).data.token;
const capCat = capEnv.call("bootstrap", {}, CAPT).data.catalog.categories[0].id;
capEnv.call("saveProduct", {
    name: "Cap Tester", category_id: capCat, gst_rate: 18,
    variants: [{ size_label: "50ml", mrp: 1000, sell_price: 1000, cost: 400, opening_stock: 90, barcode: "CAP1" }],
}, CAPT);
const capVid = capEnv.call("getCatalog", {}, CAPT).data.variants.find((v) => v.barcode === "CAP1").id;
capEnv.call("saveUser", { name: "Cap Sp", email: "cap-sp@x.in", role: "salesperson", password: "secret1" }, CAPT);
capEnv.call("saveUser", { name: "Cap Mgr", email: "cap-mgr@x.in", role: "manager", password: "secret2" }, CAPT);
const CAPSP = capEnv.call("login", { email: "cap-sp@x.in", password: "secret1" }).data.token;
const CAPMG = capEnv.call("login", { email: "cap-mgr@x.in", password: "secret2" }).data.token;

// ₹1,000 a piece, so the rupees in these checks are the quantities
const capBill = (ref, qty, extra, token, branch) =>
    capEnv.call("completeSale", Object.assign({
        client_ref: ref, lines: [{ variant_id: capVid, qty }], payments: [{ method: "cash", amount: 99999 }],
    }, extra || {}), token || CAPSP, branch || 1).data;
const capReturn = (bill, qty, token, extra) =>
    capEnv.call("returnItems", Object.assign({
        sale_id: bill.sale.id, items: [{ sale_item_id: bill.items[0].id, qty }], refund_method: "cash", reason: "Wrong size",
    }, extra || {}), token, 1);

check("the cap ships at ₹2,000", capEnv.call("getSettings", {}, CAPT).data.salesperson_max_return === "2000",
    capEnv.call("getSettings", {}, CAPT).data.salesperson_max_return);
check("a salesperson can see the cap, to warn before trying", capEnv.call("getSettings", {}, CAPSP).data.salesperson_max_return === "2000");

const cb1 = capBill("cap-1", 3);
check("the test bill is ₹3,000", cb1.sale.grand_total === 3000, cb1.sale.grand_total);
const cr1 = capReturn(cb1, 1, CAPSP);
check("a salesperson can now return ₹1,000 of a ₹3,000 bill", cr1.success, cr1.message);
check("...it is a proper credit note", /^GF\/CN\/\d\d-\d\d\/0001$/.test(cr1.data.returns[0].credit_note_no), cr1.data.returns[0]);
check("...the bill is part returned", cr1.data.sale.status === "part_returned", cr1.data.sale.status);
check("...and cost prices are still hidden from them", cr1.data.items.every((i) => i.unit_cost === undefined), cr1.data.items[0]);
const cr2 = capReturn(cb1, 1, CAPSP);
check("a second ₹1,000 lands exactly on the cap and is allowed", cr2.success, cr2.message);
const cr3 = capReturn(cb1, 1, CAPSP);
check("a third is refused: the cap counts the whole bill", /Refund limit/.test(cr3.message), cr3.message);
check("...and says what was already refunded", /already refunded/.test(cr3.message), cr3.message);
check("a manager can finish that same bill off", capReturn(cb1, 1, CAPMG).success);

// refused before anything is written — the reason the round-off settlement moved above addStock_
const cb2 = capBill("cap-2", 3);
const capStock = () => capEnv.call("getCatalog", {}, CAPT).data.variants.find((v) => v.id === capVid).stock_qty;
const stockBefore = capStock();
const tooBig = capReturn(cb2, 3, CAPSP);
check("₹3,000 in one go is refused", /Refund limit/.test(tooBig.message), tooBig.message);
const afterFail = capEnv.call("getSale", { id: cb2.sale.id }, CAPT).data;
check("the refused return moved no stock", capStock() === stockBefore, [stockBefore, capStock()]);
check("the refused return left the bill alone", afterFail.sale.status === "completed" && Number(afterFail.sale.refunded) === 0, afterFail.sale);
check("the refused return wrote no credit note", afterFail.returns.length === 0, afterFail.returns);
const mRet = capReturn(cb2, 3, CAPMG);
check("a manager returns the whole ₹3,000 bill", mRet.success, mRet.message);
check("...and the credit note series never skipped a number", /0004$/.test(mRet.data.returns[0].credit_note_no), mRet.data.returns[0].credit_note_no);

const cb3 = capBill("cap-3", 3);
check("the owner is not capped", capReturn(cb3, 3, CAPT).success);

// 0 = back to exactly how it was before this change
ok(capEnv.call("saveSettings", { settings: { salesperson_max_return: "0" } }, CAPT), "cap switched off");
const cb4 = capBill("cap-4", 1);
const offTry = capReturn(cb4, 1, CAPSP);
check("cap 0 keeps a salesperson out of returns altogether", /Only a manager/.test(offTry.message), offTry.message);
check("...while a manager still returns as before", capReturn(cb4, 1, CAPMG).success);

// a shop whose Settings row was never written still gets the default
capEnv.ctx.setSetting_("salesperson_max_return", "", 0);
const cb5 = capBill("cap-5", 3);
check("with the setting empty the ₹2,000 default applies", capReturn(cb5, 1, CAPSP).success);
check("...and is enforced", /Refund limit/.test(capReturn(cb5, 2, CAPSP).message));
check("clearing the cap from the app is rejected", !capEnv.call("saveSettings", { settings: { salesperson_max_return: "" } }, CAPT).success);
check("a negative cap is rejected", !capEnv.call("saveSettings", { settings: { salesperson_max_return: "-5" } }, CAPT).success);
ok(capEnv.call("saveSettings", { settings: { salesperson_max_return: "2000" } }, CAPT), "cap set back to ₹2,000");

// past the window the cap is not the obstacle, and only the owner may override
const cbOld = capBill("cap-old", 1, { _at: "2026-01-05 11:00:00" });
const lateSp = capReturn(cbOld, 1, CAPSP);
check("a late bill tells a salesperson about the window, not the cap", /Return window/.test(lateSp.message) && !/Refund limit/.test(lateSp.message), lateSp.message);
check("a manager still cannot override a late bill", !capReturn(cbOld, 1, CAPMG, { override: true }).success);
check("the owner still can", capReturn(cbOld, 1, CAPT, { override: true }).success);

// another branch's bill is still refused, salesperson or not
const capKN = ok(capEnv.call("saveBranch", { name: "Kalyani Nagar", code: "KN" }, CAPT), "second branch").id;
ok(capEnv.call("transferStock", { to_branch_id: capKN, lines: [{ variant_id: capVid, qty: 10 }] }, CAPT, 1), "stock to KN");
const cbKN = capBill("cap-kn", 1, {}, CAPT, capKN);
const knTry = capReturn(cbKN, 1, CAPSP);
check("a salesperson cannot return another branch's bill", /made at Kalyani Nagar/.test(knTry.message), knTry.message);

// the day's figures still add up with a salesperson doing the returning
const capClose = ok(capEnv.call("report", { type: "day_close" }, CAPT, 1), "day close after salesperson returns");
check("day close counts the salesperson's refunds", capClose.returns > 0, capClose.returns);
check("day close nets them off the sales", Math.abs(capClose.net - (capClose.sales - capClose.returns)) < 0.02, [capClose.sales, capClose.returns, capClose.net]);


// ---- exchange: items back and a replacement, one credit note + one bill, settled in one go ----
const xEnv = createEnv();
xEnv.ctx.setupSheets();
const xPwd = /Password: (\S+)/.exec(xEnv.alerts.pop())[1];
const XT = xEnv.call("login", { email: "owner@groovy.test", password: xPwd }).data.token;
const xCat = xEnv.call("bootstrap", {}, XT).data.catalog.categories[0].id;
const x2r = (n) => Math.round(n * 100) / 100;
const xMake = (name, code, price, stock) => {
    xEnv.call("saveProduct", { name, category_id: xCat, gst_rate: 18,
        variants: [{ size_label: "50ml", mrp: price, sell_price: price, cost: x2r(price / 2), opening_stock: stock === undefined ? 20 : stock, barcode: code }] }, XT);
    return xEnv.call("getCatalog", {}, XT).data.variants.find((v) => v.barcode === code).id;
};
const XA = xMake("Xchg A", "XA", 1000);
const XB = xMake("Xchg B", "XB", 1000);
const XDEAR = xMake("Xchg Dear", "XD", 1600);
const XCHEAP = xMake("Xchg Cheap", "XC", 600);
const XLAST = xMake("Xchg Last One", "XL", 1000, 1);
xEnv.call("saveUser", { name: "Xchg Sp", email: "x-sp@x.in", role: "salesperson", password: "secret1" }, XT);
xEnv.call("saveUser", { name: "Xchg Mgr", email: "x-mgr@x.in", role: "manager", password: "secret2" }, XT);
const XSP = xEnv.call("login", { email: "x-sp@x.in", password: "secret1" }).data.token;
const XMG = xEnv.call("login", { email: "x-mgr@x.in", password: "secret2" }).data.token;

let xRef = 0;
const xBill = (variant, qty, token) => xEnv.call("completeSale", {
    client_ref: "xb" + ++xRef, lines: [{ variant_id: variant, qty }], payments: [{ method: "cash", amount: 99999 }],
    customer: { phone: "9876500001", name: "Exchange Customer" },
}, token || XSP, 1).data;
const xSwapOn = (bill, qty, lines, extra, token) => xEnv.call("exchange", Object.assign({
    client_ref: "xx" + ++xRef, sale_id: bill.sale.id, items: [{ sale_item_id: bill.items[0].id, qty, restock: true }],
    reason: "Wrong size", lines, payments: [], refund_method: "cash",
}, extra || {}), token || XSP, 1);
const xStock = (v) => xEnv.call("getCatalog", {}, XT).data.variants.find((x) => x.id === v).stock_qty;
const xPays = (d) => d.payments.map((x) => [x.method, x.amount]);
const xSale = (id) => xEnv.call("getSale", { id }, XT).data;

// an even swap: nothing crosses the counter
const xb1 = xBill(XA, 3);
const xaBefore = xStock(XA);
const xbBefore = xStock(XB);
const x1 = xSwapOn(xb1, 1, [{ variant_id: XB, qty: 1 }]);
check("an even swap goes through", x1.success, x1.message);
check("...the new bill is for the replacement only", x1.data.sale.grand_total === 1000, x1.data.sale.grand_total);
check("...no cash moves at all", x1.data.payments.every((x) => x.method === "exchange"), xPays(x1.data));
check("...the bill's payment row names the credit note", x1.data.payments[0].reference === x1.data.exchange.credit_note_no,
    [x1.data.payments[0].reference, x1.data.exchange.credit_note_no]);
check("...the bill number ran on without a gap", /00002$/.test(x1.data.sale.invoice_no), x1.data.sale.invoice_no);
check("...the credit note is the first of its series", /CN\/\d\d-\d\d\/0001$/.test(x1.data.exchange.credit_note_no), x1.data.exchange.credit_note_no);
check("...what came back is on the shelf", xStock(XA) === xaBefore + 1, [xaBefore, xStock(XA)]);
check("...what went out has left it", xStock(XB) === xbBefore - 1, [xbBefore, xStock(XB)]);
const xb1After = xSale(xb1.sale.id);
check("...the old bill is part returned", xb1After.sale.status === "part_returned", xb1After.sale.status);
check("...and its refund row is the exchange, not cash", xb1After.payments.filter((x) => x.amount < 0).every((x) => x.method === "exchange"),
    xb1After.payments.filter((x) => x.amount < 0).map((x) => x.method));
const xDay = xEnv.call("report", { type: "day_close" }, XT, 1).data;
check("the day close shows the exchange as its own method", !!xDay.methods.exchange && xDay.methods.exchange.net === 0, xDay.methods);
check("...and the cash it expects is untouched by it", xDay.expected_cash === xDay.methods.cash.net, [xDay.expected_cash, xDay.methods.cash.net]);

// a dearer replacement: the customer pays the difference
const xb2 = xBill(XA, 1);
const x2 = xSwapOn(xb2, 1, [{ variant_id: XDEAR, qty: 1 }], { payments: [{ method: "cash", amount: 600 }] });
check("a dearer replacement goes through", x2.success, x2.message);
check("...only the difference is collected", x2r(x2.data.payments.filter((x) => x.method === "cash").reduce((a, x) => a + x.amount, 0)) === 600, xPays(x2.data));
check("...the credit covers the rest", x2.data.payments.filter((x) => x.method === "exchange")[0].amount === 1000, xPays(x2.data));
check("...nothing is left owing", x2.data.exchange.refunded === 0, x2.data.exchange);
check("a short difference is refused", /short/i.test(xSwapOn(xBill(XA, 1), 1, [{ variant_id: XDEAR, qty: 1 }], { payments: [{ method: "cash", amount: 100 }] }).message));

// a cheaper replacement: money goes back
const xb3 = xBill(XA, 1);
const x3 = xSwapOn(xb3, 1, [{ variant_id: XCHEAP, qty: 1 }], { refund_method: "upi" });
check("a cheaper replacement goes through", x3.success, x3.message);
check("...the leftover is handed back", x3.data.exchange.refunded === 400, x3.data.exchange);
check("...by the method chosen", xSale(xb3.sale.id).payments.some((x) => x.method === "upi" && x.amount === -400),
    xSale(xb3.sale.id).payments.map((x) => [x.method, x.amount]));
check("...and the message says so", /400 back to the customer/.test(x3.message), x3.message);

// the leaked-bottle case: the same product back out again, when it was the last one
const xb4 = xBill(XLAST, 1);
check("the shelf is empty after that sale", xStock(XLAST) === 0, xStock(XLAST));
const x4 = xSwapOn(xb4, 1, [{ variant_id: XLAST, qty: 1 }]);
check("a leaked bottle can be swapped for the same one, last in stock", x4.success, x4.message);
check("...and the shelf is back where it started", xStock(XLAST) === 0, xStock(XLAST));

// nothing is written when the swap does not add up
const xb5 = xBill(XA, 1);
const xCnBefore = xEnv.ctx.rows_("Returns").length;
const xSaleBefore = xEnv.ctx.rows_("Sales").length;
const xStockBefore = xStock(XA);
const xNoStock = xSwapOn(xb5, 1, [{ variant_id: XLAST, qty: 5 }]);
check("a replacement that is not in stock is refused", /in stock/.test(xNoStock.message), xNoStock.message);
check("...and no credit note was written", xEnv.ctx.rows_("Returns").length === xCnBefore, [xCnBefore, xEnv.ctx.rows_("Returns").length]);
check("...no bill was written", xEnv.ctx.rows_("Sales").length === xSaleBefore, [xSaleBefore, xEnv.ctx.rows_("Sales").length]);
check("...no stock moved", xStock(XA) === xStockBefore, [xStockBefore, xStock(XA)]);
check("...the old bill is untouched", xSale(xb5.sale.id).sale.status === "completed");
const xNextOk = xSwapOn(xb5, 1, [{ variant_id: XB, qty: 1 }]);
check("...and the next exchange skips no bill number", xNextOk.success && Number(/(\d+)$/.exec(xNextOk.data.sale.invoice_no)[1]) === xSaleBefore + 1,
    [xNextOk.data && xNextOk.data.sale.invoice_no, xSaleBefore]);

// a retried exchange saves once
const xb6 = xBill(XA, 1);
const xRetryReq = { client_ref: "x-retry", sale_id: xb6.sale.id, items: [{ sale_item_id: xb6.items[0].id, qty: 1, restock: true }],
    reason: "Wrong item", lines: [{ variant_id: XB, qty: 1 }], payments: [], refund_method: "cash" };
const xOnce = xEnv.call("exchange", xRetryReq, XSP, 1);
const xTwice = xEnv.call("exchange", xRetryReq, XSP, 1);
check("a retried exchange returns the one already saved", xTwice.success && xTwice.data.sale.id === xOnce.data.sale.id, xTwice.message);
check("...and writes nothing twice", xEnv.ctx.rows_("Returns").filter((r) => r.sale_id === xb6.sale.id).length === 1);
check("...the reply still names the credit note", xTwice.data.exchange.credit_note_no === xOnce.data.exchange.credit_note_no,
    [xTwice.data.exchange, xOnce.data.exchange]);

// a salesperson is limited on cash out, not on the size of a swap
const xbBig = xBill(XDEAR, 2, XMG); // 3,200, well over the 2,000 cash limit
const xEvenBig = xEnv.call("exchange", { client_ref: "x-big", sale_id: xbBig.sale.id,
    items: [{ sale_item_id: xbBig.items[0].id, qty: 2, restock: true }], reason: "Wrong item",
    lines: [{ variant_id: XDEAR, qty: 2 }], payments: [], refund_method: "cash" }, XSP, 1);
check("a salesperson may swap 3,200 evenly", xEvenBig.success, xEvenBig.message);
const xbCash = xBill(XDEAR, 2, XMG);
const xCashReq = { sale_id: xbCash.sale.id, items: [{ sale_item_id: xbCash.items[0].id, qty: 2, restock: true }],
    reason: "Wrong item", lines: [{ variant_id: XCHEAP, qty: 1 }], payments: [], refund_method: "cash" };
const xBigCash = xEnv.call("exchange", Object.assign({ client_ref: "x-cashback" }, xCashReq), XSP, 1);
check("but not hand back 2,600 in cash", /at most ₹2000 on one bill/.test(xBigCash.message), xBigCash.message);
check("...and that refusal wrote nothing", xSale(xbCash.sale.id).sale.status === "completed");
check("a manager can hand that back", xEnv.call("exchange", Object.assign({ client_ref: "x-cashback-m" }, xCashReq), XMG, 1).success);
xEnv.call("saveSettings", { settings: { salesperson_max_return: "0" } }, XT);
const xbOff = xBill(XA, 1);
check("with the limit at 0 a salesperson still swaps evenly", xEnv.call("exchange", { client_ref: "x-off-even", sale_id: xbOff.sale.id,
    items: [{ sale_item_id: xbOff.items[0].id, qty: 1, restock: true }], reason: "Wrong item",
    lines: [{ variant_id: XB, qty: 1 }], payments: [], refund_method: "cash" }, XSP, 1).success);
const xbOff2 = xBill(XA, 1);
check("...but hands back no cash at all", /Only a manager can hand money back/.test(xEnv.call("exchange", { client_ref: "x-off-cash", sale_id: xbOff2.sale.id,
    items: [{ sale_item_id: xbOff2.items[0].id, qty: 1, restock: true }], reason: "Wrong item",
    lines: [{ variant_id: XCHEAP, qty: 1 }], payments: [], refund_method: "cash" }, XSP, 1).message));
xEnv.call("saveSettings", { settings: { salesperson_max_return: "2000" } }, XT);

// the rules a plain return already has still apply
const xbOld = xEnv.call("completeSale", { client_ref: "x-old", lines: [{ variant_id: XA, qty: 1 }],
    payments: [{ method: "cash", amount: 9999 }], _at: "2026-01-07 12:00:00" }, XSP, 1).data;
const xLate = xSwapOn(xbOld, 1, [{ variant_id: XB, qty: 1 }]);
check("a bill past the return window cannot be swapped", /Return window/.test(xLate.message), xLate.message);
check("...unless the owner says so", xEnv.call("exchange", { client_ref: "x-old-ok", sale_id: xbOld.sale.id,
    items: [{ sale_item_id: xbOld.items[0].id, qty: 1, restock: true }], reason: "Damaged",
    lines: [{ variant_id: XB, qty: 1 }], payments: [], refund_method: "cash", override: true }, XT, 1).success);
const xKN = ok(xEnv.call("saveBranch", { name: "Kalyani Nagar", code: "KN" }, XT), "branch for the exchange tests").id;
ok(xEnv.call("transferStock", { to_branch_id: xKN, lines: [{ variant_id: XA, qty: 5 }] }, XT, 1), "stock to KN for exchanges");
const xbKN = xEnv.call("completeSale", { client_ref: "x-kn", lines: [{ variant_id: XA, qty: 1 }],
    payments: [{ method: "cash", amount: 9999 }] }, XT, xKN).data;
check("another branch's bill cannot be swapped here", /made at Kalyani Nagar/.test(xSwapOn(xbKN, 1, [{ variant_id: XB, qty: 1 }]).message));

// the credit note cannot be conjured up on an ordinary bill
check("a plain sale cannot be paid with an exchange", /Unknown payment method/.test(xEnv.call("completeSale", { client_ref: "x-cheat",
    lines: [{ variant_id: XA, qty: 1 }], payments: [{ method: "exchange", amount: 1000 }] }, XSP, 1).message));
check("a plain refund cannot be marked as an exchange", /Choose how the refund is paid/.test(xEnv.call("returnItems", { sale_id: xb1.sale.id,
    items: [{ sale_item_id: xb1.items[0].id, qty: 1 }], refund_method: "exchange", reason: "x" }, XMG, 1).message));

// a bill part paid by a credit note is not voidable
const xbVoid = xBill(XA, 1);
const xvSwap = xSwapOn(xbVoid, 1, [{ variant_id: XB, qty: 1 }]);
check("the swap to be voided saved", xvSwap.success, xvSwap.message);
check("a bill part paid by an exchange cannot be voided",
    /part paid by an exchange/.test(xEnv.call("voidSale", { id: xvSwap.data.sale.id, reason: "mistake" }, XMG, 1).message));
check("an ordinary bill can still be voided", xEnv.call("voidSale", { id: xBill(XA, 1, XMG).sale.id, reason: "mistake" }, XMG, 1).success);

// the books
const xGst = ok(xEnv.call("report", { type: "gst_summary" }, XT, 1), "GST summary with exchanges");
check("GST counts the exchange's credit notes", xGst.credit_notes_by_rate.length > 0 && xGst.credit_notes_by_rate[0].total > 0, xGst.credit_notes_by_rate);
check("GST counts the exchange's bills", xGst.totals.total > 0, xGst.totals);
const xBoard = ok(xEnv.call("report", { type: "salesman_performance" }, XT, 1), "leaderboard with exchanges");
check("the leaderboard nets an exchange off the seller", xBoard.rows.some((r) => r.returns > 0), xBoard.rows && xBoard.rows.map((r) => [r.name, r.sales, r.returns]));

// replies built from the rows just written must match the bill read back, for every role and kind of bill
const xRead = (id, token, branch) => xEnv.call("getSale", { id }, token, branch).data;
const xExReply = Object.assign({}, x1.data);
delete xExReply.exchange; // the exchange summary is extra to the bill itself
check("exchange reply equals the bill read back", sameData(xExReply, xRead(x1.data.sale.id, XSP, 1)), { reply: xExReply, read: xRead(x1.data.sale.id, XSP, 1) });
check("owner walk-in reply equals the bill read back", sameData(xbKN, xRead(xbKN.sale.id, XT, xKN)), { reply: xbKN, read: xRead(xbKN.sale.id, XT, xKN) });
const xbMgr = xBill(XA, 1, XMG);
check("manager reply (with costs) equals the bill read back", sameData(xbMgr, xRead(xbMgr.sale.id, XMG, 1)), { reply: xbMgr, read: xRead(xbMgr.sale.id, XMG, 1) });
check("manager reply keeps unit cost", xbMgr.items[0].unit_cost > 0, xbMgr.items[0]);
const xbSp = xBill(XA, 1);
check("salesperson reply hides unit cost", !("unit_cost" in xbSp.items[0]), xbSp.items[0]);
const xbSplit = xEnv.call("completeSale", { client_ref: "x-split", lines: [{ variant_id: XA, qty: 1 }], bill_disc: 10, notes: "gift wrap",
    payments: [{ method: "upi", amount: 500, reference: "U1" }, { method: "cash", amount: 2000 }] }, XT, 1).data;
check("split-payment reply equals the bill read back", sameData(xbSplit, xRead(xbSplit.sale.id, XT, 1)), { reply: xbSplit, read: xRead(xbSplit.sale.id, XT, 1) });

// a sheet whose header is out of date still asks for Setup, now that header rows are read once per request
const xSalesSh = xEnv.ss.getSheetByName("Sales");
const xDateCol = require("vm").runInContext('Object.keys(SCHEMA.Sales).indexOf("date")', xEnv.ctx) + 1;
xSalesSh.getRange(1, xDateCol).setValue("date_old");
const xStale = xEnv.call("listSales", {}, XT, 1);
check("an out-of-date header asks for Setup", !xStale.success && xStale.code === "SETUP", xStale);
const xStaleDash = xEnv.call("dashboard", {}, XT, 1);
check("...on a screen that reads several columns too", !xStaleDash.success && xStaleDash.code === "SETUP", xStaleDash);
xSalesSh.getRange(1, xDateCol).setValue("date");
check("...and works again once the header is right", xEnv.call("listSales", {}, XT, 1).success);


// ---- a stale sheet size must not put rows in the middle ----
// On Google, getMaxRows() can still report the size from before another person's save grew the sheet
// (seen in the 12-person stress test). Rows must still go in order, under the last row with data.
{
    const sEnv = createEnv();
    sEnv.ctx.setupSheets();
    const sPwd = /Password: (\S+)/.exec(sEnv.alerts.pop())[1];
    const ST = sEnv.call("login", { email: "owner@groovy.test", password: sPwd }).data.token;
    const exp = (title) => sEnv.call("saveExpense", { amount: 10, title, category: "Other", method: "cash" }, ST, 1);
    ok(exp("before"), "expense before the sheet fills");
    const sh = sEnv.ss.getSheetByName("Expenses");
    sh.maxRows = sh.getLastRow(); // the sheet is full: the next save has to add rows
    const staleMax = sh.maxRows;
    ok(exp("A"), "expense A grows the sheet");
    const realMax = sh.getMaxRows;
    sh.getMaxRows = () => staleMax; // the next save still sees the size from before A
    ok(exp("B"), "expense B with an out-of-date sheet size");
    sh.getMaxRows = realMax;
    ok(exp("C"), "expense C afterwards");
    const last = sh.getLastRow();
    const col = (c) => sh.getRange(2, c, last - 1, 1).getValues().map((r) => r[0]);
    const ids = col(1).filter((v) => v !== "");
    const titles = col(require("vm").runInContext('Object.keys(SCHEMA.Expenses).indexOf("title")', sEnv.ctx) + 1).filter((v) => v !== "");
    check("stale size: no blank rows in the middle of the data", ids.length === last - 1, { dataRows: ids.length, lastRow: last });
    check("stale size: rows stay in the order they were saved", JSON.stringify(titles) === JSON.stringify(["before", "A", "B", "C"]), titles);
    check("stale size: ids never repeat", new Set(ids).size === ids.length, ids);
    const spareRows = require("vm").runInContext("SPARE_ROWS_", sEnv.ctx);
    check("stale size: the sheet doesn't balloon", sh.getMaxRows() <= last + 2 * (1 + spareRows), { maxRows: sh.getMaxRows(), last, spareRows });
}

// ---- spare rows, and records removed by emptying their row (sheet sizes never change during the day) ----
{
    const mEnv = createEnv();
    mEnv.ctx.setupSheets();
    const mPwd = /Password: (\S+)/.exec(mEnv.alerts.pop())[1];
    const MT = mEnv.call("login", { email: "owner@groovy.test", password: mPwd }).data.token;
    const mRun = (code) => require("vm").runInContext(code, mEnv.ctx);
    const SPARE = mRun("SPARE_ROWS_"), LOW = mRun("SPARE_LOW_");
    const sizes = () => Object.fromEntries(mEnv.ss.getSheets().map((s) => [s.getName(), s.getMaxRows()]));
    const lowTables = Object.keys(sizes()).filter((n) => mRun(`!!SCHEMA[${JSON.stringify(n)}]`)).filter((n) => { const s = mEnv.ss.getSheetByName(n); return s.getMaxRows() - s.getLastRow() < LOW; });
    check("setup leaves every table with spare empty rows", lowTables.length === 0, lowTables);
    // a table running low is topped up under its data; one with enough is left alone
    const exS = mEnv.ss.getSheetByName("Expenses");
    for (const t of ["a", "b"]) ok(mEnv.call("saveExpense", { amount: 5, title: t, category: "Other", method: "cash" }, MT, 1), "expense " + t);
    const exLast = exS.getLastRow();
    exS.maxRows = exLast + 10; // only 10 spare left
    const before = sizes();
    const added = mRun("resetReqCache_(); topUpSpareRows_()");
    check("top-up: only the low table grows", Object.keys(added).length === 1 && added.Expenses === SPARE - 10, added);
    check("top-up: to the full stock of spare rows", exS.getMaxRows() - exS.getLastRow() === SPARE, [exS.getMaxRows(), exS.getLastRow()]);
    check("top-up: the data isn't split", exS.getLastRow() === exLast && exS.getRange(2, 1, exLast - 1, 1).getValues().every((r) => r[0] !== ""));
    check("top-up: other tables untouched", Object.keys(before).filter((n) => n !== "Expenses").every((n) => sizes()[n] === before[n]));
    // records removed during the day: gone from the app, sheet size unchanged, ids stay unique
    const catFirst = mEnv.call("getCatalog", {}, MT, 1).data.categories[0].id;
    ok(mEnv.call("saveProduct", { name: "Hold Item", category_id: catFirst, gst_rate: 18, variants: [{ size_label: "10ml", mrp: 100, sell_price: 100, cost: 50, opening_stock: 20, barcode: "HOLD1" }] }, MT, 1), "item to sell");
    const vid = mEnv.call("getCatalog", {}, MT, 1).data.variants.find((v) => v.barcode === "HOLD1");
    const sizeNow = sizes();
    const h1 = ok(mEnv.call("holdBill", { label: "h1", cart: { lines: [{ variant_id: vid.id, qty: 1 }] } }, MT, 1), "hold h1").id;
    const h2 = ok(mEnv.call("holdBill", { label: "h2", cart: { lines: [{ variant_id: vid.id, qty: 1 }] } }, MT, 1), "hold h2").id;
    ok(mEnv.call("deleteHeld", { id: h1 }, MT, 1), "delete held h1");
    const heldNow = ok(mEnv.call("listHeld", {}, MT, 1), "held list").map((h) => h.id);
    check("held bill removed: not listed", !heldNow.includes(h1) && heldNow.includes(h2), heldNow);
    const h3 = ok(mEnv.call("holdBill", { label: "h3", cart: { lines: [{ variant_id: vid.id, qty: 1 }] } }, MT, 1), "hold h3").id;
    check("held bill removed: next id still unique", ![h1, h2].includes(h3), [h1, h2, h3]);
    ok(mEnv.call("completeSale", { client_ref: "m-held", held_id: h2, lines: [{ variant_id: vid.id, qty: 1 }], payments: [{ method: "cash", amount: 99999 }] }, MT, 1), "sale from held h2");
    check("sale from a held bill removes it", !ok(mEnv.call("listHeld", {}, MT, 1), "held list").some((h) => h.id === h2));
    const exId = ok(mEnv.call("saveExpense", { amount: 7, title: "gone", category: "Other", method: "cash" }, MT, 1), "expense to delete").id;
    ok(mEnv.call("deleteExpense", { id: exId }, MT, 1), "delete expense");
    check("expense removed: not listed", !ok(mEnv.call("listExpenses", {}, MT, 1), "expenses").expenses.some((e) => e.id === exId));
    const uid = ok(mEnv.call("saveUser", { name: "Temp", email: "temp.m@x.in", role: "salesperson", password: "secret1", branch_id: 1 }, MT, 1), "temp user").id;
    const TT = ok(mEnv.call("login", { email: "temp.m@x.in", password: "secret1" }), "temp login").token;
    ok(mEnv.call("logout", {}, TT, 1), "temp logout");
    check("logout: the token no longer works", mEnv.call("me", {}, TT, 1).code === "AUTH_EXPIRED");
    ok(mEnv.call("deleteUser", { id: uid }, MT, 1), "delete user");
    check("user removed: not listed", !ok(mEnv.call("listUsers", {}, MT, 1), "users").some((u) => u.id === uid));
    check("user removed: can't log in", !mEnv.call("login", { email: "temp.m@x.in", password: "secret1" }).success);
    const catId = ok(mEnv.call("saveCategory", { name: "Temp Cat", default_hsn: "3303", default_gst: 18 }, MT, 1), "temp category").id;
    ok(mEnv.call("deleteCategory", { id: catId }, MT, 1), "delete category");
    check("category removed: not in the catalogue", !mEnv.call("getCatalog", {}, MT, 1).data.categories.some((c) => c.id === catId));
    const catAny = mEnv.call("getCatalog", {}, MT, 1).data.categories[0].id;
    ok(mEnv.call("saveProduct", { name: "Temp Product", category_id: catAny, gst_rate: 18, variants: [{ size_label: "5ml", mrp: 10, sell_price: 10, cost: 5, opening_stock: 3, barcode: "TMPDEL1" }] }, MT, 1), "temp product");
    const tp = mEnv.call("getCatalog", {}, MT, 1).data.variants.find((v) => v.barcode === "TMPDEL1");
    ok(mEnv.call("deleteProduct", { id: tp.product_id }, MT, 1), "delete product");
    const catAfter = mEnv.call("getCatalog", {}, MT, 1).data;
    check("product removed: not in the catalogue", !catAfter.variants.some((v) => v.barcode === "TMPDEL1") && !catAfter.products.some((p) => p.id === tp.product_id));
    const newP = ok(mEnv.call("saveProduct", { name: "Next Product", category_id: catAny, gst_rate: 18, variants: [{ size_label: "5ml", mrp: 10, sell_price: 10, cost: 5, opening_stock: 1, barcode: "TMPNEXT" }] }, MT, 1), "product after a delete");
    const nv = mEnv.call("getCatalog", {}, MT, 1).data.variants.find((v) => v.barcode === "TMPNEXT");
    check("after deletes, a new product gets its own stock", nv && nv.stock_qty === 1, nv);
    const grown = Object.entries(sizes()).filter(([n, s]) => s !== sizeNow[n]);
    check("no sheet changed size during all of the above", grown.length === 0, grown);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

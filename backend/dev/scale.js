/**
 * Scale check: the backend on the in-memory mock with a year of history (default 30,000 bills).
 *
 *   node --max-old-space-size=8192 backend/dev/scale.js [--bills 30000] [--backend <dir>] [--out replies.json]
 *   node backend/dev/scale.js --compare old.json new.json
 *
 * Prints, per action, the Google Sheets calls it makes, the cells it reads, and the cells it reads while
 * holding the lock — the numbers that turn into seconds on the real server (~0.1 s a call). Then it
 * replays a fixed script of reads and writes and saves every reply, so two versions of the backend can
 * be compared reply by reply (--compare). The clock is frozen, so both runs see the same "now".
 * Dev-only: not pushed to Apps Script (.claspignore uploads only *.gs).
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);

if (args.includes("--compare")) {
    const [a, b] = [opt("--compare"), args[args.indexOf("--compare") + 2]].map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
    let diff = 0;
    a.forEach((x, i) => {
        const y = b[i];
        if (!y || x.step !== y.step) return diff++, console.log("step order differs at", i, x.step, y && y.step);
        if (JSON.stringify(x.reply) !== JSON.stringify(y.reply)) {
            diff++;
            console.log("DIFFERENT:", x.step, "\n  old:", JSON.stringify(x.reply).slice(0, 400), "\n  new:", JSON.stringify(y.reply).slice(0, 400));
        }
    });
    if (a.length !== b.length) diff++, console.log("step count differs", a.length, b.length);
    console.log(diff ? `\n${diff} step(s) differ` : `\nall ${a.length} replies identical`);
    process.exit(diff ? 1 : 0);
}

const BILLS = Number(opt("--bills", 30000));
const BACKEND = path.resolve(opt("--backend", path.join(__dirname, "..")));
const { createEnv } = require(path.join(BACKEND, "dev", "mock-gas"));
const env = createEnv();
const { ctx, ss, call } = env;
const run = (code) => vm.runInContext(code, ctx);

// ---- frozen clock: every `new Date()` in the backend is 1 s after the previous one ----
const HostDate = Date;
let tick = 0;
const BASE = HostDate.parse("2026-09-27T12:00:00+05:30");
class FrozenDate extends HostDate {
    constructor(...a) {
        if (a.length) super(...a);
        else super(BASE + tick++ * 1000);
    }
    static now() { return BASE + tick * 1000; } // reading the time doesn't move it (the PDF timer's 4-minute budget)
}
ctx.Date = FrozenDate;

// ---- count Sheets calls, cells read, and cells read inside the lock ----
let on = false, calls = 0, cells = 0, lockCells = 0, inLock = 0;
const s0 = (() => { ctx.setupSheets(); return ss.getSheetByName("Sales"); })();
env.alerts.length = 0;
const RangeP = Object.getPrototypeOf(s0.getRange(1, 1));
for (const P of [Object.getPrototypeOf(s0), RangeP, Object.getPrototypeOf(ss)])
    for (const m of Object.getOwnPropertyNames(P)) {
        if (m === "constructor" || typeof P[m] !== "function" || ["cell", "write", "getRange"].includes(m)) continue;
        const f = P[m];
        P[m] = function (...a) {
            if (on) {
                calls++;
                if (m === "getValues" || m === "getValue") {
                    const n = m === "getValue" ? 1 : this.nr * this.nc;
                    cells += n;
                    if (inLock) lockCells += n;
                }
            }
            return f.apply(this, a);
        };
    }
const origLock = run("withLock_");
ctx.withLock_ = function (fn) { inLock++; try { return origLock(fn); } finally { inLock--; } };
run("withLock_ = this.withLock_"); // .gs code looks the name up globally

// ---- base shop: demo catalogue, then grown to the live shop's size ----
run(`(function(){const u=rows_("Users")[0];u.email="admin@demo.local";u.salt=newSalt_();u.pwd_hash=hashPwd_("kiosk-boss-42",u.salt);updateRows_("Users",[u]);})()`);
ctx.seedDemo("kiosk-test-42");
// an older backend (--backend) seeds its own demo password: write the one this script logs in with
run(`(function(){resetReqCache_();const u=findBy_("Users","email","sameer@demo.local");u.salt=newSalt_();u.pwd_hash=hashPwd_("kiosk-test-42",u.salt);updateRows_("Users",[u]);})()`);
env.alerts.length = 0;
console.log(`growing the sheet to ${BILLS} bills…`);
const t0 = HostDate.now();
run(`(function(N){
  resetReqCache_();
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  // live shop size: ~1,700 products, ~2,900 variants, stock at 2 branches
  const brand = rows_("Brands")[0].id, cat = rows_("Categories")[0].id;
  let pid = nextId_("Products"), vid = nextId_("Variants");
  const prods = [], vars = [], bstock = [];
  for (let i = 0; i < 1700; i++) {
    const p = { id: pid++, name: "Scale Perfume " + i, brand_id: brand, category_id: cat, gender: "unisex", sale_type: "packed", hsn: "3303", gst_rate: 18, image: "", description: "", active: 1, created_by: 1, created_at: "2025-09-01 10:00:00", updated_at: "2025-09-01 10:00:00" };
    prods.push(p);
    const n = i % 3 === 0 ? 1 : 2;
    for (let k = 0; k < n; k++) {
      const v = { id: vid++, product_id: p.id, sku: "SC" + vid, barcode: "89" + (1000000 + vid), size_label: (k ? 50 : 100) + "ml", size_ml: k ? 50 : 100, unit: "pcs", mrp: 1000, sell_price: 900, avg_cost: 400, stock_qty: 0, reorder_level: 2, active: 1, created_at: "2025-09-01 10:00:00", updated_at: "2025-09-01 10:00:00" };
      vars.push(v);
      [1, 2].forEach((b) => bstock.push({ variant_id: v.id, branch_id: b, qty: 50 + Math.floor(rnd() * 50) }));
    }
  }
  appendRows_("Products", prods); appendRows_("Variants", vars); appendRows_("Branch_Stock", bstock);
  resetReqCache_();
  const allVars = rows_("Variants").filter((v) => v.unit === "pcs");
  // customers
  let cid = nextId_("Customers"); const custs = [];
  for (let i = 0; i < Math.round(N / 10); i++) custs.push({ id: cid++, name: "Customer S" + i, phone: String(7000000000 + i), gstin: "", total_spent: 0, bills: 0, last_visit: "", created_at: "2025-09-27 10:00:00" });
  appendRows_("Customers", custs);
  // a year of bills, oldest first, like the real sheet
  let sid = nextId_("Sales"), iid = nextId_("Sale_Items"), payid = nextId_("Payments"), mid = nextId_("Stock_Movements");
  const sales = [], items = [], pays = [], moves = [];
  const start = new Date("2025-09-27T10:00:00+05:30").getTime(), span = 365 * 86400000 - 86400000;
  for (let i = 0; i < N; i++) {
    const at = fmtDateTime_(new Date(start + Math.floor((i / N) * span)));
    const branch = rnd() < 0.5 ? 1 : 2;
    const c = rnd() < 0.6 ? pick(custs) : null;
    const nLines = 1 + Math.floor(rnd() * 3);
    let total = 0, pcs = 0; // a bill's item count is its pieces, as checkout stores it
    for (let k = 0; k < nLines; k++) {
      const v = pick(allVars), qty = 1 + Math.floor(rnd() * 2), line = v.sell_price * qty;
      total += line;
      pcs += qty;
      items.push({ id: iid++, sale_id: sid, variant_id: v.id, product_name: "Scale", brand: "", size: v.size_label, barcode: v.barcode, hsn: "3303", qty, unit: "pcs", mrp: v.mrp, price: v.sell_price, discount: 0, bill_disc_share: 0, line_total: line, gst_rate: 18, taxable: r2_(line / 1.18), tax: r2_(line - line / 1.18), unit_cost: 400, returned_qty: 0 });
      moves.push({ id: mid++, variant_id: v.id, type: "sale", qty: -qty, unit_cost: 400, balance: 40, ref_type: "sale", ref_id: String(sid), note: "", user_id: 1, at, branch_id: branch });
    }
    const voided = rnd() < 0.02;
    sales.push({ id: sid, client_ref: "scale-" + sid, invoice_no: "SC/25-26/" + pad_(sid, 6), fy: "25-26", date: at, customer_id: c ? c.id : 0, customer_name: c ? c.name : "", customer_phone: c ? c.phone : "", customer_gstin: "", salesman_id: 1, salesman_name: "Owner", created_by: 1, items: pcs, gross: total, item_disc: 0, bill_disc: 0, taxable: r2_(total / 1.18), cgst: r2_((total - total / 1.18) / 2), sgst: r2_((total - total / 1.18) / 2), round_off: 0, grand_total: total, tendered: total, change: 0, refunded: voided ? total : 0, status: voided ? "voided" : "completed", notes: "", updated_at: at, gst_hidden: 0, branch_id: branch, pdf_url: i < N - 20 ? "https://drive.google.com/file/d/SCALE" + sid + "/view" + (voided ? "#void" : "") : "" });
    pays.push({ id: payid++, sale_id: sid, return_id: 0, method: rnd() < 0.5 ? "cash" : "upi", amount: total, reference: "", user_id: 1, at });
    sid++;
  }
  appendRows_("Sales", sales); appendRows_("Sale_Items", items); appendRows_("Payments", pays); appendRows_("Stock_Movements", moves);
  resetReqCache_();
})(${BILLS})`);
console.log(`…done in ${Math.round((HostDate.now() - t0) / 1000)} s: ` +
    ["Sales", "Sale_Items", "Payments", "Stock_Movements", "Customers", "Variants", "Branch_Stock"].map((n) => n + " " + (ss.getSheetByName(n).getLastRow() - 1)).join(", "));

// ---- measure + replay ----
const replies = [];
const MASK = /^(token|req_id)$/;
const clean = (v) => JSON.parse(JSON.stringify(v, (k, x) => (MASK.test(k) ? "…" : x)));
const measured = [];
function measure(step, fn) {
    calls = cells = lockCells = 0;
    on = true;
    const t = HostDate.now();
    let r;
    try { r = fn(); } finally { on = false; }
    measured.push({ step, calls, cells, lockCells, ms: HostDate.now() - t });
    return r;
}
const rid = (() => { let n = 0; return () => "scale-req-" + ++n; })();
function api(step, action, payload, token, branch, summarize) {
    const r = measure(step, () => call(action, payload || {}, token, branch, rid()));
    replies.push({ step, reply: clean(summarize ? { success: r.success, message: r.message, data: summarize(r.data), cv: r.cv, sv: r.sv } : r) });
    return r;
}
const T = call("login", { email: "admin@demo.local", password: "kiosk-boss-42" }).data.token;
const S = call("login", { email: "sameer@demo.local", password: "kiosk-test-42" }).data.token;
const catSum = (d) => d && { version: d.version, variants: d.variants.length, stock: d.variants.map((v) => [v.id, v.stock_qty, v.stock_by_branch]) };

// the stock a phone ends up with after applying a getStock reply the way store.jsx refreshStock does
function applyStock(local, d) {
    const qty = d.changed || {}, byB = d.by_branch || {};
    return local.map(([id, q, bb]) => Object.prototype.hasOwnProperty.call(qty, id) ? [id, qty[id], byB[id] || bb] : d.full ? [id, 0, byB[id] || {}] : [id, q, bb]);
}
const phones = {}; // branch → {stock, at}
function phoneStart(b, token) { const c = call("getCatalog", {}, token, b).data; phones[b] = { stock: catSum(c).stock, at: c.at, token }; }
function phoneRefresh(step, b) {
    const p = phones[b];
    const r = measure(step, () => call("getStock", { since: p.at }, p.token, b, rid()));
    p.stock = applyStock(p.stock, r.data);
    p.at = r.data.at;
    const truth = catSum(call("getCatalog", {}, p.token, b).data).stock;
    const same = JSON.stringify(p.stock) === JSON.stringify(truth);
    replies.push({ step, reply: { stock_matches_server: same } });
    if (!same) console.log("  !! phone stock differs from the server after", step);
}

const B1 = 1, B2 = 2;
[B1, B2, 0].forEach((b) => phoneStart(b, T));
phones.s = null;
api("dashboard b1", "dashboard", {}, T, B1);
api("dashboard all", "dashboard", {}, T, 0);
api("listSales today b1", "listSales", {}, T, B1);
api("listSales month b1", "listSales", { from: "2026-09-01", to: "2026-09-27" }, T, B1);
api("listSales year all", "listSales", { from: "2025-09-27", to: "2026-09-27" }, T, 0);
for (const type of ["day_close", "salesman_performance", "profit", "gst_summary", "product_sales", "sales_register", "expenses"])
    api("report " + type, "report", { type, from: "2026-09-01", to: "2026-09-27" }, T, B1);
api("listCustomers", "listCustomers", {}, T, B1);
api("findCustomer", "findCustomer", { phone: "7000000005" }, T, B1);
const vA = run(`rows_("Variants").filter(v=>v.unit==="pcs"&&v.active)[5].id`);
const vB = run(`rows_("Variants").filter(v=>v.unit==="pcs"&&v.active)[9].id`);
const sale1 = api("completeSale walk-in", "completeSale", { client_ref: "g1", lines: [{ variant_id: vA, qty: 1 }], payments: [{ method: "cash", amount: 100000 }] }, T, B1);
api("completeSale returning customer", "completeSale", { client_ref: "g2", lines: [{ variant_id: vB, qty: 2 }], customer: { phone: "7000000005", name: "" }, payments: [{ method: "cash", amount: 100000 }] }, T, B1);
const sale3 = api("completeSale new customer", "completeSale", { client_ref: "g3", lines: [{ variant_id: vA, qty: 1 }, { variant_id: vB, qty: 1 }], customer: { phone: "9876512345", name: "New One" }, payments: [{ method: "cash", amount: 100000 }] }, S, B1);
api("completeSale retry g1", "completeSale", { client_ref: "g1", lines: [{ variant_id: vA, qty: 1 }], payments: [{ method: "cash", amount: 100000 }] }, T, B1);
phoneRefresh("getStock after sales b1", B1);
phoneRefresh("getStock after sales b2", B2);
phoneRefresh("getStock after sales all", 0);
api("voidSale", "voidSale", { id: sale1.data.sale.id, reason: "scale" }, T, B1);
api("returnItems", "returnItems", { sale_id: sale3.data.sale.id, items: [{ sale_item_id: sale3.data.items[0].id, qty: 1, restock: true }], refund_method: "cash", reason: "scale" }, T, B1);
api("stockIn", "stockIn", { lines: [{ variant_id: vA, qty: 3, unit_cost: 410 }] }, T, B1);
api("transferStock", "transferStock", { to_branch_id: B2, lines: [{ variant_id: vB, qty: 1 }] }, T, B1);
api("adjustStock", "adjustStock", { variant_id: vA, mode: "remove", qty: 1, reason: "damage" }, T, B1);
phoneRefresh("getStock after writes b1", B1);
phoneRefresh("getStock after writes b2", B2);
phoneRefresh("getStock after writes all", 0);
api("dashboard b1 after writes", "dashboard", {}, T, B1);
api("listSales today b1 after writes", "listSales", {}, T, B1);
api("report day_close after writes", "report", { type: "day_close" }, T, B1);
// the 15-minute timer: 20 bills without a PDF + today's new ones
measure("PDF timer run", () => ctx.savePendingInvoicePdfs());
replies.push({ step: "PDF timer run", reply: { pending_left: run(`resetReqCache_(); rows_("Sales").filter(s=>!s.pdf_url).length`) } });
api("getSale after PDF", "getSale", { id: sale3.data.sale.id }, T, B1);
api("getSale voided after PDF", "getSale", { id: sale1.data.sale.id }, T, B1);
api("saveInvoicePdf (already saved)", "saveInvoicePdf", { id: sale3.data.sale.id }, T, B1);
// people: writes then column reads in one request
const u = api("saveUser", "saveUser", { name: "Scale Temp", email: "scale.temp@x.in", role: "salesperson", password: "shop-pass-1", branch_id: B1 }, T, B1);
api("deleteUser (never sold)", "deleteUser", { id: u.data && u.data.id }, T, B1);
api("deleteUser (has sales)", "deleteUser", { id: run(`rows_("Users").find(u=>u.email==="sameer@demo.local").id`) }, T, B1);
api("bootstrap unchanged", "bootstrap", { catalog_version: run(`num_(setting_("catalog_version"),1)`), catalog_branch: B1 }, T, B1);
api("bootstrap full", "bootstrap", {}, T, B1, (d) => d && { user: d.user, branch_id: d.branch_id, catalog: catSum(d.catalog) });

// ---- report ----
console.log("\nstep".padEnd(40), "calls".padStart(6), "cells read".padStart(12), "in lock".padStart(10), "js ms".padStart(7));
for (const m of measured) console.log(m.step.padEnd(40), String(m.calls).padStart(6), String(m.cells).padStart(12), String(m.lockCells).padStart(10), String(m.ms).padStart(7));
const out = opt("--out");
if (out) { fs.writeFileSync(out, JSON.stringify(replies)); console.log("\nreplies saved to", out); }

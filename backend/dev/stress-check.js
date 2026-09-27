/**
 * Checks a stress-test copy of the shop from its .xlsx download (File → Download → .xlsx).
 *
 *   node backend/dev/stress-check.js <copy.xlsx> <stress-out dir>
 *
 * Needs the `xlsx` package (install it outside the project). Reads every table as it is in the sheet
 * and checks what the app can't show directly: every id unique, invoice / credit-note numbers unique,
 * stock = starting stock + every movement of the run, each item's total = its branches, no negative
 * stock, every save in the request log written exactly once, customer totals consistent.
 * Dev-only.
 */
const fs = require("fs");
const path = require("path");
const XLSX = require(process.env.XLSX_MODULE || "xlsx");

const [file, outDir] = process.argv.slice(2);
if (!file || !outDir) throw new Error("usage: stress-check.js <copy.xlsx> <stress-out dir>");
const wb = XLSX.readFile(file, { cellDates: false, raw: true });
const table = (name) => {
    const ws = wb.Sheets[name];
    if (!ws) throw new Error("sheet missing in the download: " + name);
    return XLSX.utils.sheet_to_json(ws, { defval: "", raw: true }).filter((r) => Object.values(r).some((v) => v !== ""));
};
const snap = JSON.parse(fs.readFileSync(path.join(outDir, "snapshot.json"), "utf8"));
const log = fs.readFileSync(path.join(outDir, "requests.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const started = snap.snapshot.started; // ISO, UTC
// sheet times are IST text "yyyy-MM-dd HH:mm:ss" (or Excel serials if a cell lost its text format)
const toIso = (v) => {
    if (typeof v === "number") return new Date(Math.round((v - 25569) * 86400000) - 5.5 * 3600000).toISOString();
    const s = String(v);
    return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) ? new Date(s.replace(" ", "T") + "+05:30").toISOString() : "";
};
// the sheet keeps whole seconds, so the run starts at the start of its first second (nothing that moves
// stock or money is written in the second before the run: that is only logins and the new test staff)
const startedSec = new Date(Math.floor(new Date(started).getTime() / 1000) * 1000).toISOString();
// NEXT_RUN=<next run's out dir>: check an earlier run in a copy that has had another run since — rows up to
// that run's start, and its starting stock as this run's end
const next = process.env.NEXT_RUN ? JSON.parse(fs.readFileSync(path.join(process.env.NEXT_RUN, "snapshot.json"), "utf8")) : null;
const endedSec = next ? next.snapshot.started : "9999";
const inRun = (v) => { const t = toIso(v); return !!t && t >= startedSec && t < endedSec; };
const r3 = (x) => Math.round((Number(x) + Number.EPSILON) * 1000) / 1000;
const r2 = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;

const problems = [];
const check = (name, ok, extra) => { console.log((ok ? "PASS " : "FAIL ") + name + (ok || extra === undefined ? "" : " → " + JSON.stringify(extra).slice(0, 700))); if (!ok) problems.push(name); };
const dups = (arr) => [...new Set(arr.filter((x, i) => x !== "" && arr.indexOf(x) !== i))];

const T = {};
for (const n of ["Sales", "Sale_Items", "Payments", "Stock_Movements", "Returns", "Return_Items", "Transfers", "Stock_In_Batches", "Expenses", "Branch_Stock", "Variants", "Customers", "Held_Bills"]) T[n] = table(n);
console.log("rows:", Object.fromEntries(Object.entries(T).map(([k, v]) => [k, v.length])));

// 1. ids and document numbers
// ids written during this run must not repeat anywhere in the table (earlier damage in a reused copy is not this run's)
const timeCol = { Sales: "date", Sale_Items: null, Payments: "at", Stock_Movements: "at", Returns: "at", Return_Items: null, Transfers: "at", Stock_In_Batches: "at", Expenses: "created_at", Customers: "created_at", Held_Bills: "at" };
for (const n of Object.keys(timeCol)) {
    const all = T[n].map((r) => Number(r.id));
    const runIds = timeCol[n] ? T[n].filter((r) => inRun(r[timeCol[n]])).map((r) => Number(r.id)) : [];
    const count = {};
    all.forEach((id) => (count[id] = (count[id] || 0) + 1));
    const bad = [...new Set(runIds.filter((id) => count[id] > 1))];
    check(`${n}: ids of this run unique${timeCol[n] ? "" : " (no time column — whole table)"}`, timeCol[n] ? bad.length === 0 : dups(all).length === 0, timeCol[n] ? bad : dups(all));
}
check("invoice numbers unique", dups(T.Sales.map((r) => r.invoice_no)).length === 0, dups(T.Sales.map((r) => r.invoice_no)));
check("credit note numbers unique", dups(T.Returns.map((r) => r.credit_note_no)).length === 0, dups(T.Returns.map((r) => r.credit_note_no)));
check("one bill per sale reference", dups(T.Sales.map((r) => r.client_ref)).length === 0, dups(T.Sales.map((r) => r.client_ref)));
check("transfer numbers unique", dups(T.Transfers.map((r) => r.transfer_no)).length === 0, dups(T.Transfers.map((r) => r.transfer_no)));

// 2. stock: start + movements of the run = end, per item and branch
const start = {};
Object.entries(snap.snapshot.stockAll.by_branch || {}).forEach(([vid, byB]) => Object.entries(byB).forEach(([bid, q]) => (start[vid + "|" + bid] = Number(q))));
const moved = {};
T.Stock_Movements.filter((m) => inRun(m.at)).forEach((m) => { const k = m.variant_id + "|" + m.branch_id; moved[k] = r3((moved[k] || 0) + Number(m.qty)); });
const end = {};
if (next) Object.entries(next.snapshot.stockAll.by_branch || {}).forEach(([vid, byB]) => Object.entries(byB).forEach(([bid, q]) => (end[vid + "|" + bid] = Number(q))));
else T.Branch_Stock.forEach((r) => (end[r.variant_id + "|" + r.branch_id] = r3((end[r.variant_id + "|" + r.branch_id] || 0) + Number(r.qty))));
const stockBad = Object.keys(moved).filter((k) => r3((start[k] || 0) + moved[k]) !== r3(end[k] || 0)).map((k) => ({ item_branch: k, start: start[k] || 0, moved: moved[k], end: end[k] || 0 }));
check(`stock = start + movements (${Object.keys(moved).length} item/branch pairs moved)`, stockBad.length === 0, stockBad.slice(0, 10));
const lastBal = {};
T.Stock_Movements.filter((m) => inRun(m.at)).forEach((m) => (lastBal[m.variant_id + "|" + m.branch_id] = Number(m.balance)));
const balBad = Object.entries(lastBal).filter(([k, b]) => r3(b) !== r3(end[k] || 0)).map(([k, b]) => ({ item_branch: k, last_balance: b, stock: end[k] }));
check("each item's last movement balance = its stock", balBad.length === 0, balBad.slice(0, 10));
const sumB = {};
T.Branch_Stock.forEach((r) => (sumB[r.variant_id] = r3((sumB[r.variant_id] || 0) + Number(r.qty))));
const totBad = T.Variants.filter((v) => r3(Number(v.stock_qty)) !== r3(sumB[v.id] || 0)).map((v) => ({ id: v.id, stock_qty: v.stock_qty, branches: sumB[v.id] || 0 }));
check("each item's total = sum of its branches", totBad.length === 0, totBad.slice(0, 10));
const neg = T.Branch_Stock.filter((r) => Number(r.qty) < 0).map((r) => [r.variant_id, r.branch_id, r.qty]);
check("no negative stock", neg.length === 0, neg.slice(0, 10));

// 3. every save in the log written exactly once, nothing extra
// with NEXT_RUN, that run's setup (opening stock-ins, new staff) happened inside this run's window too
const setupOfNext = next ? fs.readFileSync(path.join(process.env.NEXT_RUN, "requests.jsonl"), "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l)).filter((e) => e.at < endedSec) : [];
const ok = (a) => log.concat(setupOfNext).filter((e) => e.action === a && e.success && e.at >= startedSec && e.at < endedSec); // the run's, not setup's (opening stock-ins)
const runSales = T.Sales.filter((s) => inRun(s.date));
const loggedSaleIds = new Set([...ok("completeSale"), ...ok("exchange")].map((e) => e.data && e.data.sale && e.data.sale.id).filter(Boolean));
check("every sale in the log is in the sheet", [...loggedSaleIds].every((id) => T.Sales.some((s) => Number(s.id) === id)), [...loggedSaleIds].filter((id) => !T.Sales.some((s) => Number(s.id) === id)));
check("no sale in the sheet that the log doesn't know", runSales.every((s) => loggedSaleIds.has(Number(s.id))), runSales.filter((s) => !loggedSaleIds.has(Number(s.id))).map((s) => s.id));
const nReturns = ok("returnItems").length + ok("exchange").filter((e) => !/already saved/i.test(e.message)).length;
check(`credit notes of the run = successful returns + exchanges (${nReturns})`, T.Returns.filter((r) => inRun(r.at)).length === nReturns, T.Returns.filter((r) => inRun(r.at)).length);
check("stock-in batches of the run = successful stock-ins", T.Stock_In_Batches.filter((r) => inRun(r.at)).length === ok("stockIn").length, [T.Stock_In_Batches.filter((r) => inRun(r.at)).length, ok("stockIn").length]);
check("transfers of the run = successful transfers", T.Transfers.filter((r) => inRun(r.at)).length === ok("transferStock").length, [T.Transfers.filter((r) => inRun(r.at)).length, ok("transferStock").length]);
check("voided bills = successful voids", runSales.filter((s) => s.status === "voided").length === ok("voidSale").length, [runSales.filter((s) => s.status === "voided").length, ok("voidSale").length]);

// 4. money per bill, from the raw rows
const paysBy = {};
T.Payments.forEach((p) => (paysBy[p.sale_id] = r2((paysBy[p.sale_id] || 0) + Number(p.amount))));
const moneyBad = runSales.filter((s) => Math.abs((paysBy[s.id] || 0) - r2(Number(s.grand_total) - Number(s.refunded))) > 0.01).map((s) => ({ id: s.id, paid: paysBy[s.id] || 0, kept: r2(s.grand_total - s.refunded), status: s.status }));
check("payments add up for every bill of the run", moneyBad.length === 0, moneyBad.slice(0, 10));
const itemsBy = {};
T.Sale_Items.forEach((i) => (itemsBy[i.sale_id] = r2((itemsBy[i.sale_id] || 0) + Number(i.line_total))));
const lineBad = runSales.filter((s) => Math.abs(r2((itemsBy[s.id] || 0) + Number(s.round_off || 0)) - r2(s.grand_total)) > 0.01).map((s) => ({ id: s.id, lines: itemsBy[s.id], round_off: s.round_off, grand: s.grand_total }));
check("bill lines + round-off = bill total", lineBad.length === 0, lineBad.slice(0, 10));

// 5. customer totals (every bill of the customer, as the app keeps them: + on sale, − on void/return)
const custBills = {};
T.Sales.forEach((s) => { if (!Number(s.customer_id)) return; const c = (custBills[s.customer_id] = custBills[s.customer_id] || { spent: 0, bills: 0 }); c.spent = r2(c.spent + Number(s.grand_total) - Number(s.refunded)); if (s.status !== "voided") c.bills++; });
const touched = new Set(runSales.map((s) => Number(s.customer_id)).filter(Boolean));
const custBad = T.Customers.filter((c) => touched.has(Number(c.id))).filter((c) => { const x = custBills[c.id] || { spent: 0, bills: 0 }; return Math.abs(r2(c.total_spent) - Math.max(0, x.spent)) > 0.01 || Number(c.bills) !== x.bills; })
    .map((c) => ({ id: c.id, sheet: [c.total_spent, c.bills], from_bills: custBills[c.id] }));
check(`customer totals match their bills (${touched.size} customers in the run)`, custBad.length === 0, custBad.slice(0, 10));

console.log(problems.length ? `\n${problems.length} CHECK(S) FAILED: ${problems.join("; ")}` : "\nall sheet-level checks passed");
process.exit(problems.length ? 1 : 0);

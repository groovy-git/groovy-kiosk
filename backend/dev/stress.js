/**
 * Multi-user stress test against a SEPARATE TEST COPY of the shop (never the live one).
 *
 *   node backend/dev/stress.js <test web-app URL> --minutes 10 --branches 3 --out <dir>
 *
 * At every branch, two salespeople, a manager and an admin (owner role) work at the same time — 12 people
 * across 3 branches — plus deliberate collisions: the same sale sent twice, the same request retried,
 * two voids of one bill, two sales of the last unit, and two branches transferring the same item to each
 * other at once. Every request and reply is logged; at the end the harness reads the shop back and checks
 * it. Stock and the raw tables are then checked from an .xlsx download of the copy (stress-check.js).
 *
 * Refuses to run unless the server's shop name is "STRESS TEST COPY", and never talks to the live URL.
 * `--dry` allows a local mock (backend/dev/server.js) to try the harness itself. Dev-only.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const LIVE = "AKfycbwPlo-URdlZ5k4y1HKwUK5UDKyMgUfFHNCw7Nl2eMp7bqXmjQpq6dz6xTLMc61We53w"; // the live shop: forbidden
const args = process.argv.slice(2);
const URL = args[0];
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const MINUTES = Number(opt("--minutes", 10));
const NBRANCH = Number(opt("--branches", 3));
const OUT = opt("--out", path.join(process.cwd(), "stress-out"));
const OWNER = { email: opt("--owner", "groovy.pos@gmail.com"), password: opt("--password", "admin123") };
const DRY = args.includes("--dry");
// --pace 30-90: each person waits 30–90 s between actions (a busy counter) instead of going non-stop
const PACE = (opt("--pace", "") || "").split("-").map(Number).filter((x) => x > 0);
const think = () => (PACE.length ? new Promise((r) => setTimeout(r, 1000 * (PACE[0] + Math.random() * ((PACE[1] || PACE[0]) - PACE[0])))) : null);
if (!URL || !(/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(URL) || (DRY && /^http:\/\/localhost:\d+$/.test(URL))))
    throw new Error("give the TEST web-app URL (…/exec)");
if (URL.includes(LIVE)) throw new Error("That is the LIVE shop. The stress test only runs on a test copy.");
fs.mkdirSync(OUT, { recursive: true });
const logFile = path.join(OUT, "requests.jsonl");
fs.writeFileSync(logFile, "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];
const istDay = (d) => new Date((d ? new Date(d) : new Date()).getTime() + 5.5 * 3600000).toISOString().slice(0, 10);

// one call to the server, logged; retries a lost reply with the same req_id, like the app
async function call(who, action, payload, token, branch, reqId) {
    const req_id = reqId || crypto.randomUUID();
    const t0 = Date.now();
    let res = null, err = null, tries = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
        tries++;
        try {
            const r = await fetch(URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action, token, branch_id: branch || 0, req_id, payload }), redirect: "follow" });
            const txt = await r.text();
            try { res = JSON.parse(txt); err = null; } catch (e) { res = null; err = "not JSON (HTTP " + r.status + "): " + txt.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 120); }
            if (res && res.code === "IN_PROGRESS") { await sleep(1500); continue; }
            if (res) break;
        } catch (e) { err = String(e); }
        await sleep(800 * (attempt + 1));
    }
    const entry = { who, action, branch, req_id, client_ref: payload && payload.client_ref, payload, ms: Date.now() - t0, tries, at: new Date().toISOString(),
        success: !!(res && res.success), code: res && res.code, message: res && res.message, err, data: res && res.data,
        error: res && res.error, diag: res && res.diag }; // error/diag: only from a diagnostic test build
    fs.appendFileSync(logFile, JSON.stringify(entry) + "\n");
    return entry;
}

(async () => {
    // ---- safety gate ----
    const login = await call("owner", "login", { email: OWNER.email, password: OWNER.password, device: "stress test" });
    if (!login.success) throw new Error("owner login failed: " + login.message);
    const T = login.data.token;
    let boot = await call("owner", "bootstrap", {}, T, 0);
    const shop = boot.data && boot.data.settings && boot.data.settings.business_name;
    if (shop !== "STRESS TEST COPY") throw new Error(`Safety gate: shop name is "${shop}", not "STRESS TEST COPY". Not running.`);
    console.log("✓ safety gate: talking to the STRESS TEST COPY");

    // ---- branches: use the copy's, adding test branches until there are NBRANCH ----
    let branches = boot.data.branches.filter((b) => b.active !== 0);
    for (let i = branches.length; i < NBRANCH; i++) {
        const r = await call("owner", "saveBranch", { name: "Stress Branch " + (i + 1), code: "S" + (i + 1) }, T, 0);
        if (!r.success) throw new Error("could not add a test branch: " + r.message);
    }
    boot = await call("owner", "bootstrap", {}, T, 0);
    branches = boot.data.branches.filter((b) => b.active !== 0).slice(0, NBRANCH);
    console.log("branches:", branches.map((b) => `${b.name} (${b.id})`).join(", "));

    // ---- stock to work with at every branch: a test stock-in of 30 of 40 items at each ----
    const cat0 = (await call("owner", "getCatalog", {}, T, 0)).data;
    const items = cat0.variants.filter((v) => v.active && v.unit === "pcs" && v.sell_price > 0).slice(0, 41);
    if (items.length < (DRY ? 5 : 41)) throw new Error("not enough sellable items in the copy");
    const lastUnitItem = items.pop(); // kept out of everyone's hands until the last-unit race
    for (const b of branches) {
        const r = await call("owner", "stockIn", { lines: items.map((v) => ({ variant_id: v.id, qty: 30, unit_cost: 100 })) }, T, b.id);
        if (!r.success) throw new Error("opening stock-in failed at " + b.name + ": " + r.message);
    }

    // ---- 4 people per branch: 2 salespeople, a manager, an admin (owner role) ----
    const stamp = Date.now().toString(36);
    const mkUser = async (name, role, b) => {
        const email = `stress.${name.toLowerCase().replace(/\W/g, "")}.${stamp}@example.com`;
        const s = await call("owner", "saveUser", { name: "Stress " + name, email, role, password: "stress123", branch_id: b.id, branch_ids: role === "owner" ? [] : [b.id] }, T, b.id);
        if (!s.success) throw new Error("create user failed: " + s.message);
        const l = await call(name, "login", { email, password: "stress123", device: "stress test" });
        if (!l.success) throw new Error("login failed for " + name + ": " + l.message);
        return { name, role, email, id: s.data.id, token: l.data.token, branch: b.id };
    };
    const teams = [];
    for (const [i, b] of branches.entries()) {
        const t = { b, sp1: await mkUser(`B${i + 1}-Sales1`, "salesperson", b), sp2: await mkUser(`B${i + 1}-Sales2`, "salesperson", b),
            mg: await mkUser(`B${i + 1}-Manager`, "manager", b), ad: await mkUser(`B${i + 1}-Admin`, "owner", b) };
        teams.push(t);
    }
    // the sheet keeps whole seconds: let setup's last second pass, take the starting stock, and start the
    // run on the next whole second, so no setup row and no run row ever share a second
    await sleep(1200);
    const stockAll = (await call("owner", "getStock", {}, T, 0)).data;
    await sleep(1000 - (Date.now() % 1000) + 20);
    const snapshot = { started: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(), stockAll };
    fs.writeFileSync(path.join(OUT, "snapshot.json"), JSON.stringify({ snapshot, branches, lastUnitItem: lastUnitItem.id,
        users: teams.flatMap((t) => [t.sp1, t.sp2, t.mg, t.ad]).map(({ token, ...u }) => u) }, null, 1));

    // ---- shared state ----
    const bills = [];
    const phones = Array.from({ length: 20 }, (_, i) => "98" + String(76000000 + i * 7919).slice(0, 8));
    const lines = () => { const n = 1 + rnd(3), ls = [], seen = {}; for (let i = 0; i < n; i++) { const v = pick(items); if (!seen[v.id]) { seen[v.id] = 1; ls.push({ variant_id: v.id, qty: 1 }); } } return ls; };
    const priceOf = (ls) => ls.reduce((a, l) => a + items.find((v) => v.id === l.variant_id).sell_price * l.qty, 0);
    const restock = (team, ls) => call(team.mg.name, "stockIn", { lines: ls.map((l) => ({ variant_id: l.variant_id, qty: 10, unit_cost: 100 })) }, team.mg.token, team.b.id);
    const sale = async (u, team, extra) => {
        const ls = lines();
        const split = Math.random() < 0.3;
        const payload = Object.assign({ client_ref: crypto.randomUUID(), lines: ls, customer: Math.random() < 0.4 ? { phone: pick(phones), name: "" } : {},
            payments: split ? [{ method: "upi", amount: Math.floor(priceOf(ls) / 2) }, { method: "cash", amount: 999999 }] : [{ method: "cash", amount: 999999 }] }, extra || {});
        const r = await call(u.name, "completeSale", payload, u.token, team.b.id);
        if (!r.success && /in stock/i.test(r.message || "")) await restock(team, ls);
        if (r.success) bills.push({ id: r.data.sale.id, by: u.name, branch: team.b.id, items: r.data.items });
        return r;
    };
    const deadline = Date.now() + MINUTES * 60000;
    const counts = {};
    const tally = (k) => (counts[k] = (counts[k] || 0) + 1);
    const recent = (team, n) => bills.filter((x) => x.branch === team.b.id && x.items && x.items.length).slice(-n);

    const held = {}; // user name → ids of their held bills
    const salesWorker = async (u, team) => {
        while (Date.now() < deadline) {
            await think();
            if (Date.now() >= deadline) break;
            const x = Math.random();
            const mine = (held[u.name] = held[u.name] || []);
            if (x < 0.65) tally("sale:" + (await sale(u, team)).success);
            else if (x < 0.72) { const h = await call(u.name, "holdBill", { label: "stress", cart: { lines: lines() } }, u.token, team.b.id); if (h.success) mine.push(h.data.id); tally("hold:" + h.success); }
            else if (x < 0.76) { const id = mine.shift(); if (id) tally("deleteHeld:" + (await call(u.name, "deleteHeld", { id }, u.token, team.b.id)).success); }
            else if (x < 0.8) { const id = mine.shift(); if (id) tally("saleFromHeld:" + (await sale(u, team, { held_id: id })).success); }
            else if (x < 0.83) { // log out and in again (a session row is emptied, another written)
                await call(u.name, "logout", {}, u.token, team.b.id);
                const l = await call(u.name, "login", { email: u.email, password: "stress123", device: "stress test" });
                if (l.success) u.token = l.data.token;
                tally("relogin:" + l.success);
            }
            else { const b = bills.filter((b) => b.by === u.name && b.items && b.items.length).pop(); if (b) tally("return:" + (await call(u.name, "returnItems", { sale_id: b.id, items: [{ sale_item_id: b.items[0].id, qty: 1, restock: true }], refund_method: "cash", reason: "stress" }, u.token, team.b.id)).success); }
        }
    };
    const managerWorker = async (u, team) => {
        while (Date.now() < deadline) {
            await think();
            if (Date.now() >= deadline) break;
            const x = Math.random();
            if (x < 0.35) tally("sale:" + (await sale(u, team)).success);
            else if (x < 0.5) { const b = pick(recent(team, 8)); if (b) tally("void:" + (await call(u.name, "voidSale", { id: b.id, reason: "stress" }, u.token, team.b.id)).success); }
            else if (x < 0.6) { const b = pick(recent(team, 10)); if (b) tally("return:" + (await call(u.name, "returnItems", { sale_id: b.id, items: [{ sale_item_id: b.items[b.items.length - 1].id, qty: 1, restock: Math.random() < 0.8 }], refund_method: pick(["cash", "upi"]), reason: "stress" }, u.token, team.b.id)).success); }
            else if (x < 0.67) { const b = pick(recent(team, 10)); if (b) tally("exchange:" + (await call(u.name, "exchange", { client_ref: crypto.randomUUID(), sale_id: b.id, items: [{ sale_item_id: b.items[0].id, qty: 1, restock: true }], reason: "Wrong size", lines: [{ variant_id: pick(items).id, qty: 1 }], payments: [{ method: "cash", amount: 999999 }], refund_method: "cash" }, u.token, team.b.id)).success); }
            else if (x < 0.77) tally("stockIn:" + (await call(u.name, "stockIn", { lines: [{ variant_id: pick(items).id, qty: 1 + rnd(3), unit_cost: 100 }] }, u.token, team.b.id)).success);
            else if (x < 0.84) { const to = pick(branches.filter((b) => b.id !== team.b.id)); if (to) tally("transfer:" + (await call(u.name, "transferStock", { to_branch_id: to.id, lines: [{ variant_id: pick(items).id, qty: 1 }] }, u.token, team.b.id)).success); }
            else if (x < 0.92) tally("adjust:" + (await call(u.name, "adjustStock", { variant_id: pick(items).id, mode: pick(["add", "remove"]), qty: 1, reason: "count" }, u.token, team.b.id)).success);
            else tally("expense:" + (await call(u.name, "saveExpense", { amount: 10 + rnd(90), title: "stress", category: "Other", method: "cash" }, u.token, team.b.id)).success);
        }
    };
    const adminWorker = async (u, team) => {
        while (Date.now() < deadline) {
            await think();
            if (Date.now() >= deadline) break;
            const x = Math.random();
            if (x < 0.3) tally("sale:" + (await sale(u, team)).success);
            else if (x < 0.45) tally("dashboard:" + (await call(u.name, "dashboard", {}, u.token, pick([0, team.b.id]))).success);
            else if (x < 0.6) tally("listSales:" + (await call(u.name, "listSales", {}, u.token, pick([0, team.b.id]))).success);
            else if (x < 0.75) tally("report:" + (await call(u.name, "report", { type: pick(["day_close", "salesman_performance", "profit", "gst_summary", "product_sales", "sales_register"]) }, u.token, team.b.id)).success);
            else if (x < 0.9) tally("getStock:" + (await call(u.name, "getStock", {}, u.token, team.b.id)).success);
            else tally("customers:" + (await call(u.name, "listCustomers", {}, u.token, team.b.id)).success);
        }
    };

    // ---- deliberate collisions at 20%, 40%, 60%, 80% of the run ----
    const collisions = [];
    const A = teams[0], B = teams[1 % teams.length];
    const at = (f) => sleep(MINUTES * 60000 * f);
    const outcome = (r) => ({ ok: r.success, id: r.data && r.data.sale && r.data.sale.id, msg: r.message || r.err });
    const busyOnly = (rs) => rs.every((r) => !r.success && /busy|still saving/i.test(r.message || ""));
    const until = async (make) => { for (let i = 0; i < 8; i++) { const rs = await make(); if (!busyOnly(rs)) return rs; await sleep(3000 + rnd(5000)); } return make(); };
    const collide = async () => {
        await at(0.2);
        { const ls = lines(); await restock(A, ls); // the same sale from two phones at once
          const same = { client_ref: crypto.randomUUID(), lines: ls, payments: [{ method: "cash", amount: 999999 }] };
          const rs = await until(() => Promise.all([call(A.sp1.name, "completeSale", same, A.sp1.token, A.b.id), call(A.sp2.name, "completeSale", same, A.sp2.token, A.b.id)]));
          collisions.push({ kind: "same sale twice", client_ref: same.client_ref, results: rs.map(outcome) }); }
        { const ls = lines(); await restock(A, ls); // the same request retried
          const p = { client_ref: crypto.randomUUID(), lines: ls, payments: [{ method: "cash", amount: 999999 }] };
          const rs = await until(() => { const rid = crypto.randomUUID(); return Promise.all([call(A.sp1.name, "completeSale", p, A.sp1.token, A.b.id, rid), call(A.sp1.name, "completeSale", p, A.sp1.token, A.b.id, rid)]); });
          collisions.push({ kind: "same request twice", client_ref: p.client_ref, results: rs.map(outcome) }); }
        await at(0.2);
        { const v = await sale(A.sp2, A); // two voids of one bill (manager and admin)
          if (v.success) { const rs = await until(() => Promise.all([call(A.mg.name, "voidSale", { id: v.data.sale.id, reason: "race" }, A.mg.token, A.b.id), call(A.ad.name, "voidSale", { id: v.data.sale.id, reason: "race" }, A.ad.token, A.b.id)]));
            collisions.push({ kind: "two voids of one bill", sale_id: v.data.sale.id, results: rs.map(outcome) }); } }
        await at(0.2);
        { const set = await call(A.mg.name, "adjustStock", { variant_id: lastUnitItem.id, mode: "set", qty: 1, reason: "count" }, A.mg.token, A.b.id); // two sales of the last unit
          if (set.success) { const one = (u) => call(u.name, "completeSale", { client_ref: crypto.randomUUID(), lines: [{ variant_id: lastUnitItem.id, qty: 1 }], payments: [{ method: "cash", amount: 999999 }] }, u.token, A.b.id);
            const rs = await until(() => Promise.all([one(A.sp1), one(A.sp2)]));
            collisions.push({ kind: "two sales of the last unit", variant_id: lastUnitItem.id, results: rs.map(outcome) });
            rs.forEach((r) => r.success && bills.push({ id: r.data.sale.id, by: "race", branch: A.b.id, items: r.data.items })); } }
        await at(0.2);
        if (A !== B) { const v = pick(items); // two branches send each other the same item at once
          const rs = await until(() => Promise.all([call(A.mg.name, "transferStock", { to_branch_id: B.b.id, lines: [{ variant_id: v.id, qty: 1 }] }, A.mg.token, A.b.id), call(B.mg.name, "transferStock", { to_branch_id: A.b.id, lines: [{ variant_id: v.id, qty: 1 }] }, B.mg.token, B.b.id)]));
          collisions.push({ kind: "crossed transfers", variant_id: v.id, results: rs.map(outcome) }); }
    };

    console.log(`running ${MINUTES} min: ${teams.length * 4} people at ${teams.length} branches…`);
    const t0 = Date.now();
    await Promise.all([...teams.flatMap((t) => [salesWorker(t.sp1, t), salesWorker(t.sp2, t), managerWorker(t.mg, t), adminWorker(t.ad, t)]), collide()]);
    console.log(`done in ${Math.round((Date.now() - t0) / 1000)} s`, counts);

    // ---- read back and check what the app can show ----
    const log = fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const all = (await call("owner", "listSales", { from: istDay(snapshot.started), to: istDay() }, T, 0)).data.sales;
    const ids = [...new Set(log.filter((e) => e.success && /completeSale|exchange/.test(e.action) && e.data && e.data.sale).map((e) => e.data.sale.id))];
    const details = {};
    for (let i = 0; i < ids.length; i += 6) await Promise.all(ids.slice(i, i + 6).map(async (id) => { details[id] = (await call("owner", "getSale", { id }, T, 0)).data; }));
    fs.writeFileSync(path.join(OUT, "final-sales.json"), JSON.stringify({ all, details, collisions, counts }, null, 1));

    const problems = [];
    const check = (name, ok, extra) => { console.log((ok ? "PASS " : "FAIL ") + name + (ok || extra === undefined ? "" : " → " + JSON.stringify(extra).slice(0, 600))); if (!ok) problems.push(name); };
    const dup = (arr) => arr.filter((x, i) => arr.indexOf(x) !== i);
    const r2 = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
    check("bill ids unique", dup(all.map((s) => s.id)).length === 0, dup(all.map((s) => s.id)));
    check("invoice numbers unique", dup(all.map((s) => s.invoice_no)).length === 0, dup(all.map((s) => s.invoice_no)));
    const inList = new Set(all.map((s) => s.id));
    check("every saved sale is in the sales list", ids.every((id) => inList.has(id)), ids.filter((id) => !inList.has(id)));
    const byRef = {};
    Object.values(details).forEach((d) => d && d.sale && (byRef[d.sale.client_ref] = (byRef[d.sale.client_ref] || 0) + 1));
    check("one bill per sale reference", Object.values(byRef).every((n) => n === 1), Object.entries(byRef).filter(([, n]) => n > 1));
    const savedRefs = new Set(log.filter((e) => e.action === "completeSale" && e.success).map((e) => e.client_ref));
    const phantom = log.filter((e) => e.action === "completeSale" && !e.success && e.client_ref && !savedRefs.has(e.client_ref) && byRef[e.client_ref]);
    check("refused sales saved nothing", phantom.length === 0, phantom.map((e) => e.client_ref));
    const bad = Object.values(details).filter(Boolean).map((d) => ({ id: d.sale.id, paid: r2(d.payments.reduce((a, p) => a + p.amount, 0)), kept: r2(d.sale.grand_total - d.sale.refunded) })).filter((m) => Math.abs(m.paid - m.kept) > 0.01);
    check("payments add up for every bill", bad.length === 0, bad.slice(0, 10));
    check("no item returned more than sold", Object.values(details).filter(Boolean).every((d) => d.items.every((i) => i.returned_qty <= i.qty + 0.0001)));
    check("no bill refunded more than its total", Object.values(details).filter(Boolean).every((d) => d.sale.refunded <= d.sale.grand_total + 0.01));
    for (const c of collisions) {
        const okN = c.results.filter((r) => r.ok).length;
        if (/same (sale|request)/.test(c.kind)) { const got = c.results.filter((r) => r.ok).map((r) => r.id); check(c.kind + ": exactly one bill", got.length >= 1 && new Set(got).size === 1 && byRef[c.client_ref] === 1, c.results); }
        else if (c.kind === "two voids of one bill") check(c.kind + ": one voided, one refused", okN === 1, c.results);
        else if (c.kind === "two sales of the last unit") check(c.kind + ": one sold, one refused for stock", okN === 1 && c.results.some((r) => !r.ok && /stock/i.test(r.msg || "")), c.results);
        else if (c.kind === "crossed transfers") check(c.kind + ": both saved", okN === 2, c.results);
    }
    const serverErr = log.filter((e) => e.code === "SERVER");
    check("no unexpected server errors", serverErr.length === 0, serverErr.map((e) => [e.action, e.message]).slice(0, 10));

    // ---- access under load ----
    const busy = log.filter((e) => /busy/i.test(e.message || ""));
    const lost = log.filter((e) => !e.success && e.err);
    const saves = log.filter((e) => /completeSale|voidSale|returnItems|exchange|stockIn|transferStock|adjustStock|saveExpense|holdBill/.test(e.action));
    const pct = (arr, p) => { const s = arr.slice().sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };
    console.log(`\nrequests: ${log.length} (${saves.length} saves) | refused "Server busy": ${busy.length} | no reply after retries: ${lost.length}${lost.length ? " — e.g. " + lost[0].err : ""}`);
    console.log(`save time: median ${pct(saves.map((e) => e.ms), 0.5)} ms, 90% under ${pct(saves.map((e) => e.ms), 0.9)} ms, slowest ${pct(saves.map((e) => e.ms), 1)} ms`);
    const byAction = {};
    log.forEach((e) => (byAction[e.action] = byAction[e.action] || []).push(e.ms));
    console.log("median ms per action:", Object.fromEntries(Object.entries(byAction).map(([k, v]) => [k, pct(v, 0.5)])));
    console.log(problems.length ? `\n${problems.length} CHECK(S) FAILED: ${problems.join("; ")}` : "\nall app-level checks passed — now download the copy as .xlsx and run stress-check.js");
    for (const t of teams) for (const u of [t.sp1, t.sp2, t.mg, t.ad]) await call(u.name, "logout", {}, u.token, t.b.id);
    process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error("STOPPED:", e.message); process.exit(2); });

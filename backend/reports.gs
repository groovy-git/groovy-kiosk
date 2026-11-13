/**
 * Dashboard + reports. Sales count on their sale date; returns count on the return date.
 * Voided bills are excluded everywhere.
 */

function d10_(s) {
    return String(s || "").slice(0, 10);
}

function inRange_(dateStr, from, to) {
    const d = d10_(dateStr);
    return (!from || d >= from) && (!to || d <= to);
}

function rangeOf_(p) {
    const to = str_(p.to) || todayStr_();
    const from = str_(p.from) || to;
    if (from > to) fail_("From date is after To date");
    return { from, to };
}

/**
 * Scoped data for the caller (a salesperson sees only their own).
 *
 * `from`/`to` limit what is read off the sheet — a report about one day should not read five years
 * of bills. Leaving them out reads everything, as before.
 */
function scope_(ctx, from, to) {
    const own = ctx.user.role === "salesperson" ? ctx.user.id : 0;
    const saleRows = from || to ? windowRows_("Sales", "date", from || null, to || null) : rows_("Sales");
    const returnRows = from || to ? windowRows_("Returns", "at", from || null, to || null) : rows_("Returns");
    const sales = saleRows.filter((s) => s.status !== "voided" && (!own || s.salesman_id === own) && inBranch_(ctx, s.branch_id));
    const returns = returnRows.filter((r) => (!own || r.salesman_id === own) && inBranch_(ctx, r.branch_id));
    return { own, sales, returns };
}

function sumBy_(rows, f) {
    return r2_(rows.reduce((a, r) => a + (typeof f === "function" ? f(r) : r[f]), 0));
}

/** The lines of these credit notes — same idea as saleItemsFor_. */
function returnItemsFor_(returnIds) {
    if (!returnIds.length) return [];
    let lo = returnIds[0];
    let hi = returnIds[0];
    returnIds.forEach((id) => {
        if (id < lo) lo = id;
        if (id > hi) hi = id;
    });
    return windowRows_("Return_Items", "return_id", lo, hi);
}

/** The sale lines belonging to these bills — one block read instead of every line ever sold. */
function saleItemsFor_(saleIds) {
    if (!saleIds.length) return [];
    let lo = saleIds[0];
    let hi = saleIds[0];
    saleIds.forEach((id) => {
        if (id < lo) lo = id;
        if (id > hi) hi = id;
    });
    return windowRows_("Sale_Items", "sale_id", lo, hi);
}

/**
 * Who brought each customer in: the salesperson on their first bill ever. Returns {customer_id: sale id}.
 *
 * Built from EVERY bill, not the caller's scoped set, so a repeat customer is never counted as new
 * again and credit only goes to whoever billed them first — whichever branch or salesperson that was.
 * Walk-ins (no phone, so no customer record) and voided bills are skipped, so a customer whose first
 * bill was cancelled counts again on their next one. Earliest date wins, lowest id breaks a tie,
 * which keeps backdated rows (demo data) right.
 *
 * Costs no extra reading: every caller has already read the Sales sheet this request.
 */
function firstBillByCustomer_() {
    if (REQ_CACHE_.__firstBill) return REQ_CACHE_.__firstBill;
    const best = {};
    // this one genuinely needs every bill ever — but only four of the thirty columns, so it reads
    // those four rather than the whole sheet
    const id = columnValues_("Sales", "id");
    const date = columnValues_("Sales", "date");
    const customer = columnValues_("Sales", "customer_id");
    const status = columnValues_("Sales", "status");
    id.forEach((_, i) => {
        const s = { id: id[i], date: date[i], customer_id: customer[i], status: status[i] };
        if (!s.customer_id || s.status === "voided") return;
        const cur = best[s.customer_id];
        if (!cur || s.date < cur.date || (s.date === cur.date && s.id < cur.id)) best[s.customer_id] = { id: s.id, date: s.date };
    });
    const first = {};
    Object.keys(best).forEach((k) => (first[k] = best[k].id));
    return (REQ_CACHE_.__firstBill = first);
}

function isNewCustomer_(sale, first) {
    return !!sale.customer_id && first[sale.customer_id] === sale.id;
}

// items as billed (pcs count their qty, a loose-ml line counts as 1) — not reduced by later returns
function itemsOf_(sales) {
    return r3_(sales.reduce((a, s) => a + s.items, 0));
}

function newCustomersIn_(sales) {
    const first = firstBillByCustomer_();
    return sales.filter((s) => isNewCustomer_(s, first)).length;
}

/* ---------- dashboard ---------- */

function apiDashboard_(p, ctx) {
    const today = todayStr_();
    const monthStart = today.slice(0, 8) + "01";
    // everything on this screen looks back at most 30 days (the trend) or to the start of the month,
    // so that is all that is read
    const since = monthStart < daysAgoStr_(29) ? monthStart : daysAgoStr_(29);
    const { own, sales, returns } = scope_(ctx, since, today);
    const reviews = reviewsIn_(ctx, monthStart, today); // the leaderboard's Google reviews: this month at most
    const saleIds = {};
    sales.forEach((s) => (saleIds[s.id] = true));

    const tSales = sales.filter((s) => d10_(s.date) === today);
    const tRet = returns.filter((r) => d10_(r.at) === today);
    const todayGross = sumBy_(tSales, "grand_total");
    const todayReturns = sumBy_(tRet, "total");

    const payToday = {};
    PAYMENT_METHODS.forEach((m) => (payToday[m] = 0));
    windowRows_("Payments", "at", today, today).forEach((x) => {
        if (d10_(x.at) !== today) return;
        if (!saleIds[x.sale_id]) return; // other salesperson's, or a voided bill (payment + reversal both skipped)
        payToday[x.method] = r2_((payToday[x.method] || 0) + x.amount);
    });

    // 30-day trend
    const days = [];
    const byDay = {};
    for (let i = 29; i >= 0; i--) {
        const d = daysAgoStr_(i);
        days.push(d);
        byDay[d] = 0;
    }
    sales.forEach((s) => {
        const d = d10_(s.date);
        if (byDay[d] !== undefined) byDay[d] += s.grand_total;
    });
    returns.forEach((r) => {
        const d = d10_(r.at);
        if (byDay[d] !== undefined) byDay[d] -= r.total;
    });

    // top products this month (net of returned qty)
    const mSaleIds = {};
    sales.filter((s) => d10_(s.date) >= monthStart).forEach((s) => (mSaleIds[s.id] = true));
    const top = {};
    // the lines of this month's bills, found by their bill numbers instead of reading every line ever
    // (kept: the month's profit below works from the same lines)
    const mLines = saleItemsFor_(Object.keys(mSaleIds).map(Number));
    mLines.forEach((i) => {
        if (!mSaleIds[i.sale_id]) return;
        const q = i.qty - i.returned_qty;
        if (q <= 0) return;
        const k = i.variant_id;
        top[k] = top[k] || { name: i.product_name, size: i.size, unit: i.unit, qty: 0, amount: 0 };
        top[k].qty = r3_(top[k].qty + q);
        top[k].amount = r2_(top[k].amount + (i.line_total * q) / i.qty);
    });

    const lowStock = [];
    const branchStock = stockMap_(ctx.branch_id);
    const pmap = indexBy_(rows_("Products"), "id");
    rows_("Variants").forEach((v) => {
        const prod = pmap[v.product_id];
        if (!v.active || !prod || !prod.active) return;
        const q = branchStock[v.id] || 0;
        if (q <= 0 || (v.reorder_level > 0 && q <= v.reorder_level))
            lowStock.push({ variant_id: v.id, name: prod.name, size: v.size_label, unit: v.unit, stock_qty: q, reorder_level: v.reorder_level });
    });
    lowStock.sort((a, b) => a.stock_qty - b.stock_qty);

    const data = {
        today: {
            bills: tSales.length,
            items: itemsOf_(tSales),
            new_customers: newCustomersIn_(tSales),
            sales: todayGross,
            returns: todayReturns,
            net: r2_(todayGross - todayReturns),
            avg_bill: tSales.length ? r2_(todayGross / tSales.length) : 0,
            payments: payToday,
            // counted Google reviews taken today (a salesperson's: their own), from the list read for the leaderboard
            reviews: reviews.filter((v) => d10_(v.at) === today).length,
            samples: reviews.filter((v) => d10_(v.at) === today && v.sample).length,
        },
        trend: days.map((d) => ({ date: d, net: r2_(byDay[d]) })),
        top_products: Object.keys(top)
            .map((k) => top[k])
            .sort((a, b) => b.amount - a.amount)
            .slice(0, 8),
        low_stock: lowStock.slice(0, 15),
        low_stock_count: lowStock.length,
        leaderboard: {
            today: leaderboard_(sales, returns, today, today, reviews),
            month: leaderboard_(sales, returns, monthStart, today, reviews),
        },
    };
    if (!ctx.branch_id) data.by_branch = branchBreakdown_(sales, returns, today, today, monthStart);
    if (!own) {
        const mSales = sales.filter((s) => d10_(s.date) >= monthStart);
        const mReturns = returns.filter((r) => d10_(r.at) >= monthStart);
        data.month_expenses = expensesIn_(ctx, monthStart, today);
        data.month_net = r2_(sumBy_(mSales, "grand_total") - sumBy_(mReturns, "total"));
        // the same figure as Reports → Profit for this month; only the month's credit-note lines are new reading
        data.month_profit = profitOf_(mSales, mReturns, data.month_expenses, mLines).net;
        data.month_reviews = reviews.length; // the list is this month's counted reviews
        data.month_samples = reviews.filter((v) => v.sample).length;
    }
    return { data };
}

// `reviews`: counted Google reviews in scope (reviewsIn_, reviews.gs) — someone who only took reviews is listed too
function leaderboard_(sales, returns, from, to, reviews) {
    const m = {};
    const row = (id, name) =>
        (m[id] = m[id] || { salesman_id: id, name: name || "", bills: 0, items: 0, new_customers: 0, sales: 0, returns: 0, net: 0, reviews: 0, samples: 0 });
    const first = firstBillByCustomer_();
    sales.forEach((s) => {
        if (!inRange_(s.date, from, to)) return;
        const r = row(s.salesman_id, s.salesman_name);
        r.bills++;
        r.items = r3_(r.items + s.items);
        if (isNewCustomer_(s, first)) r.new_customers++;
        r.sales = r2_(r.sales + s.grand_total);
    });
    const users = indexBy_(rows_("Users"), "id");
    returns.forEach((x) => {
        if (!inRange_(x.at, from, to)) return;
        const r = row(x.salesman_id, users[x.salesman_id] ? users[x.salesman_id].name : "");
        r.returns = r2_(r.returns + x.total);
    });
    (reviews || []).forEach((v) => {
        if (!inRange_(v.at, from, to)) return;
        const r = row(v.salesman_id, v.salesman_name);
        r.reviews++;
        if (v.sample) r.samples++;
    });
    return Object.keys(m)
        .map((k) => {
            const r = m[k];
            r.net = r2_(r.sales - r.returns);
            r.avg_bill = r.bills ? r2_(r.sales / r.bills) : 0;
            return r;
        })
        .sort((a, b) => b.net - a.net);
}

/* ---------- reports ---------- */

function apiReport_(p, ctx) {
    const type = str_(p.type);
    const isSalesman = ctx.user.role === "salesperson";
    if (isSalesman && ["day_close", "salesman_performance"].indexOf(type) < 0) fail_("Access denied");
    const fns = {
        day_close: reportDayClose_,
        salesman_performance: reportSalesmen_,
        sales_register: reportRegister_,
        gst_summary: reportGst_,
        product_sales: reportProducts_,
        profit: reportProfit_,
        performance: reportPerformance_,
        stock_valuation: reportStock_,
        expenses: reportExpenses_,
        google_reviews: reportReviews_,
    };
    if (!fns[type]) fail_("Unknown report");
    return { data: fns[type](p, ctx) };
}

/**
 * What left the shelf on these bills — one row per product size, qty net of returns,
 * with current stock so the owner knows what to refill. Items needing a refill come first.
 */
function daySoldItems_(daySales, branchId) {
    const ids = {};
    daySales.forEach((s) => (ids[s.id] = true));
    const agg = {};
    saleItemsFor_(daySales.map((s) => s.id)).forEach((i) => {
        if (!ids[i.sale_id]) return;
        const q = r3_(i.qty - i.returned_qty);
        if (q <= 0) return;
        const a = (agg[i.variant_id] = agg[i.variant_id] || {
            variant_id: i.variant_id, name: i.product_name, brand: i.brand, size: i.size, unit: i.unit, qty: 0, amount: 0,
        });
        a.qty = r3_(a.qty + q);
        a.amount = r2_(a.amount + (i.line_total * q) / i.qty);
    });
    const vmap = indexBy_(rows_("Variants"), "id");
    const stock = stockMap_(branchId || 0);
    return Object.keys(agg)
        .map((k) => {
            const a = agg[k];
            const v = vmap[a.variant_id];
            a.stock_left = stock[a.variant_id] || 0;
            a.reorder_level = v ? v.reorder_level : 0;
            a.refill = v ? a.stock_left <= 0 || (v.reorder_level > 0 && a.stock_left <= v.reorder_level) : false;
            return a;
        })
        .sort((x, y) => (y.refill ? 1 : 0) - (x.refill ? 1 : 0) || y.qty - x.qty || x.name.localeCompare(y.name));
}

function reportDayClose_(p, ctx) {
    const date = str_(p.date) || todayStr_();
    const { own, sales, returns } = scope_(ctx, date, date);
    const daySales = sales.filter((s) => d10_(s.date) === date);
    const dayRets = returns.filter((r) => d10_(r.at) === date);

    // money taken today can belong to an older bill (a refund on last week's sale), so the bills
    // behind today's payments are read by id — still a block, not the whole book
    const dayPays = windowRows_("Payments", "at", date, date);
    let lo = 0;
    let hi = 0;
    dayPays.forEach((x) => {
        if (!x.sale_id) return;
        lo = lo ? Math.min(lo, x.sale_id) : x.sale_id;
        hi = Math.max(hi, x.sale_id);
    });
    const saleMap = lo ? indexBy_(windowRows_("Sales", "id", lo, hi), "id") : {};

    const methods = {};
    PAYMENT_METHODS.forEach((m) => (methods[m] = { in: 0, out: 0, net: 0 }));
    dayPays.forEach((x) => {
        if (d10_(x.at) !== date) return;
        const s = saleMap[x.sale_id];
        if (!s) return;
        if (own && s.salesman_id !== own) return;
        if (!inBranch_(ctx, s.branch_id)) return; // other branch's money
        if (x.reference === "VOID" || s.status === "voided") return; // voids cancel out and are excluded
        const m = (methods[x.method] = methods[x.method] || { in: 0, out: 0, net: 0 });
        if (x.amount >= 0) m.in = r2_(m.in + x.amount);
        else m.out = r2_(m.out - x.amount);
        m.net = r2_(m.in - m.out);
    });
    const cashExpenses = own
        ? 0
        : sumBy_(rows_("Expenses").filter((e) => e.date === date && e.method === "cash" && inBranch_(ctx, e.branch_id)), "amount");
    const voided = windowRows_("Sales", "date", date, date).filter(
        (s) => s.status === "voided" && (!own || s.salesman_id === own) && inBranch_(ctx, s.branch_id),
    );
    return {
        date,
        bills: daySales.length,
        sales: sumBy_(daySales, "grand_total"),
        discounts: sumBy_(daySales, (s) => s.item_disc + s.bill_disc),
        returns: sumBy_(dayRets, "total"),
        net: r2_(sumBy_(daySales, "grand_total") - sumBy_(dayRets, "total")),
        methods,
        cash_expenses: cashExpenses,
        expected_cash: r2_((methods.cash ? methods.cash.net : 0) - cashExpenses),
        by_salesman: leaderboard_(sales, returns, date, date, reviewsIn_(ctx, date, date)),
        voided: voided.map((s) => ({ invoice_no: s.invoice_no, amount: s.grand_total, salesman_name: s.salesman_name, notes: s.notes })),
        credit_notes: dayRets.map((r) => ({ credit_note_no: r.credit_note_no, invoice_no: r.invoice_no, total: r.total, method: r.refund_method, reason: r.reason })),
        items: daySoldItems_(daySales, ctx.branch_id),
        branch_id: ctx.branch_id,
        branch_name: ctx.branch_id ? branchName_(ctx.branch_id) : "All branches",
        by_branch: ctx.branch_id ? [] : branchBreakdown_(sales, returns, date, date),
    };
}

function reportSalesmen_(p, ctx) {
    const { from, to } = rangeOf_(p);
    const { sales, returns } = scope_(ctx, from, to);
    const rs = sales.filter((s) => inRange_(s.date, from, to));
    const base = leaderboard_(sales, returns, from, to, reviewsIn_(ctx, from, to));
    // items and new customers come from leaderboard_ already; this adds what only this report shows
    const extra = {};
    rs.forEach((s) => {
        const e = (extra[s.salesman_id] = extra[s.salesman_id] || { discount: 0, gross: 0 });
        e.discount = r2_(e.discount + s.item_disc + s.bill_disc);
        e.gross = r2_(e.gross + s.gross);
    });
    return {
        from, to,
        rows: base.map((r) => Object.assign(r, extra[r.salesman_id] || { discount: 0, gross: 0 })),
    };
}

function reportRegister_(p, ctx) {
    const { from, to } = rangeOf_(p);
    const { sales, returns } = scope_(ctx, from, to);
    const rows = sales
        .filter((s) => inRange_(s.date, from, to))
        .map((s) => ({
            invoice_no: s.invoice_no, date: s.date, customer: s.customer_name || "Walk-in", phone: phoneFor_(s.customer_phone, ctx),
            gstin: s.customer_gstin, salesperson: s.salesman_name, taxable: s.taxable, cgst: s.cgst, sgst: s.sgst,
            round_off: s.round_off, total: s.grand_total, refunded: s.refunded, status: s.status, offer: s.offer || "",
        }));
    const cns = returns
        .filter((r) => inRange_(r.at, from, to))
        .map((r) => ({ credit_note_no: r.credit_note_no, invoice_no: r.invoice_no, date: r.at, taxable: r.taxable, tax: r.tax, total: r.total, reason: r.reason }));
    return {
        from, to, rows, credit_notes: cns,
        totals: {
            bills: rows.length, taxable: sumBy_(rows, "taxable"), cgst: sumBy_(rows, "cgst"), sgst: sumBy_(rows, "sgst"),
            total: sumBy_(rows, "total"), returns: sumBy_(cns, "total"),
        },
    };
}

function reportGst_(p, ctx) {
    const { from, to } = rangeOf_(p);
    const { sales, returns } = scope_(ctx, from, to);
    // bills made at a branch without GST aren't GST supplies: left out, and so are their credit notes
    const rs = sales.filter((s) => inRange_(s.date, from, to) && s.gst_hidden !== GST_OFF_BRANCH_);
    const ids = indexBy_(rs, "id");
    const items = saleItemsFor_(rs.map((s) => s.id)).filter((i) => ids[i.sale_id]);
    const byRate = {};
    const byHsn = {};
    items.forEach((i) => {
        const r = (byRate[i.gst_rate] = byRate[i.gst_rate] || { rate: i.gst_rate, taxable: 0, cgst: 0, sgst: 0, total: 0 });
        r.taxable = r2_(r.taxable + i.taxable);
        r.cgst = r2_(r.cgst + r2_(i.tax / 2));
        r.sgst = r2_(r.sgst + r2_(i.tax - r2_(i.tax / 2)));
        r.total = r2_(r.total + i.line_total);
        const hk = (i.hsn || "—") + "@" + i.gst_rate;
        const h = (byHsn[hk] = byHsn[hk] || { hsn: i.hsn || "—", rate: i.gst_rate, qty: 0, taxable: 0, tax: 0, total: 0 });
        h.qty = r3_(h.qty + (i.unit === "pcs" ? i.qty : 0));
        h.taxable = r2_(h.taxable + i.taxable);
        h.tax = r2_(h.tax + i.tax);
        h.total = r2_(h.total + i.line_total);
    });
    // credit notes (returns) in range by rate — not those against a no-GST branch bill (marked when made)
    const rets = returns.filter((r) => inRange_(r.at, from, to) && !r.gst_off);
    const rIds = indexBy_(rets, "id");
    const siMap = indexBy_(saleItemsFor_(rets.map((r) => r.sale_id)), "id");
    const cnByRate = {};
    returnItemsFor_(rets.map((r) => r.id)).forEach((ri) => {
        if (!rIds[ri.return_id]) return;
        const si = siMap[ri.sale_item_id];
        const rate = si ? si.gst_rate : 0;
        const c = (cnByRate[rate] = cnByRate[rate] || { rate, taxable: 0, tax: 0, total: 0 });
        c.taxable = r2_(c.taxable + ri.taxable);
        c.tax = r2_(c.tax + ri.tax);
        c.total = r2_(c.total + ri.amount);
    });
    const b2b = rs
        .filter((s) => s.customer_gstin)
        .map((s) => ({ invoice_no: s.invoice_no, date: d10_(s.date), gstin: s.customer_gstin, name: s.customer_name, taxable: s.taxable, cgst: s.cgst, sgst: s.sgst, total: s.grand_total }));
    const b2cRows = rs.filter((s) => !s.customer_gstin);
    return {
        from, to,
        by_rate: Object.keys(byRate).map((k) => byRate[k]).sort((a, b) => a.rate - b.rate),
        by_hsn: Object.keys(byHsn).map((k) => byHsn[k]).sort((a, b) => a.hsn.localeCompare(b.hsn)),
        credit_notes_by_rate: Object.keys(cnByRate).map((k) => cnByRate[k]),
        b2b,
        b2c: { bills: b2cRows.length, taxable: sumBy_(b2cRows, "taxable"), cgst: sumBy_(b2cRows, "cgst"), sgst: sumBy_(b2cRows, "sgst"), total: sumBy_(b2cRows, "grand_total") },
        totals: { taxable: sumBy_(rs, "taxable"), cgst: sumBy_(rs, "cgst"), sgst: sumBy_(rs, "sgst"), round_off: sumBy_(rs, "round_off"), total: sumBy_(rs, "grand_total") },
    };
}

function reportProducts_(p, ctx) {
    const { from, to } = rangeOf_(p);
    const group = ["product", "brand", "category", "variant"].indexOf(p.group) >= 0 ? p.group : "variant";
    const { sales } = scope_(ctx, from, to);
    const ids = indexBy_(sales.filter((s) => inRange_(s.date, from, to)), "id");
    const vmap = indexBy_(rows_("Variants"), "id");
    const pmap = indexBy_(rows_("Products"), "id");
    const cmap = indexBy_(rows_("Categories"), "id");
    const out = {};
    saleItemsFor_(Object.keys(ids).map(Number)).forEach((i) => {
        if (!ids[i.sale_id]) return;
        const q = r3_(i.qty - i.returned_qty);
        if (q <= 0) return;
        const v = vmap[i.variant_id];
        const prod = v ? pmap[v.product_id] : null;
        let key, label;
        if (group === "variant") (key = i.variant_id), (label = i.product_name + " " + i.size);
        else if (group === "product") (key = prod ? prod.id : i.product_name), (label = i.product_name);
        else if (group === "brand") (key = i.brand || "—"), (label = i.brand || "No brand");
        else (key = prod ? prod.category_id : 0), (label = prod && cmap[prod.category_id] ? cmap[prod.category_id].name : "—");
        const r = (out[key] = out[key] || { label, pcs: 0, ml: 0, amount: 0, cost: 0, profit: 0 });
        if (i.unit === "ml") r.ml = r3_(r.ml + q);
        else r.pcs = r3_(r.pcs + q);
        const amt = r2_((i.taxable * q) / i.qty); // ex-GST revenue
        r.amount = r2_(r.amount + (i.line_total * q) / i.qty);
        r.cost = r2_(r.cost + i.unit_cost * q);
        r.profit = r2_(r.profit + amt - i.unit_cost * q);
    });
    const rows = Object.keys(out).map((k) => out[k]).sort((a, b) => b.amount - a.amount);
    return { from, to, group, rows, totals: { amount: sumBy_(rows, "amount"), cost: sumBy_(rows, "cost"), profit: sumBy_(rows, "profit") } };
}

/**
 * Profit on these bills and credit notes: revenue without GST, less what the goods cost (a restocked
 * return gives its cost back; one not restocked stays a loss), less the expenses.
 *
 * `saleLines` / `returnLines` are the lines when the caller has already read them (the dashboard has, for
 * top sellers; Performance reads a whole span once and asks month by month); otherwise they are read
 * here. Lines of other bills are ignored. Shared by the Profit report, Home and Performance, so all agree.
 */
function profitOf_(sales, returns, expenses, saleLines, returnLines) {
    const ids = indexBy_(sales, "id");
    let cogs = 0;
    (saleLines || saleItemsFor_(sales.map((s) => s.id))).forEach((i) => {
        if (ids[i.sale_id]) cogs += i.unit_cost * i.qty;
    });
    const rIds = indexBy_(returns, "id");
    let retCost = 0;
    (returnLines || returnItemsFor_(returns.map((r) => r.id))).forEach((ri) => {
        if (rIds[ri.return_id] && ri.restock) retCost += ri.unit_cost * ri.qty; // non-restocked goods stay a loss
    });
    const revenue = r2_(sumBy_(sales, "taxable") - sumBy_(returns, "taxable"));
    const cost = r2_(cogs - retCost);
    const gross = r2_(revenue - cost);
    return { revenue, cost, gross, expenses, net: r2_(gross - expenses) };
}

function expensesIn_(ctx, from, to) {
    return sumBy_(rows_("Expenses").filter((e) => e.date >= from && e.date <= to && inBranch_(ctx, e.branch_id)), "amount");
}

function reportProfit_(p, ctx) {
    const { from, to } = rangeOf_(p);
    const { sales, returns } = scope_(ctx, from, to);
    const rs = sales.filter((s) => inRange_(s.date, from, to));
    const rets = returns.filter((r) => inRange_(r.at, from, to));
    const pr = profitOf_(rs, rets, expensesIn_(ctx, from, to));
    return {
        from, to,
        sales_incl_gst: sumBy_(rs, "grand_total"),
        returns_incl_gst: sumBy_(rets, "total"),
        gst_collected: r2_(sumBy_(rs, (s) => s.cgst + s.sgst) - sumBy_(rets, "tax")),
        revenue_ex_gst: pr.revenue,
        cost_of_goods: pr.cost,
        gross_profit: pr.gross,
        expenses: pr.expenses,
        net_profit: pr.net,
        margin_pct: pr.revenue ? r2_((pr.gross / pr.revenue) * 100) : 0,
    };
}

/* ---------- Performance: Home's figures for any dates, month by month (owner and managers) ---------- */

// kept month totals in Script Properties: mt1_<branch id, 0 = all>_<yyyy-mm>. A change to what is kept
// or how it is worked out takes a new prefix, so old values are never read again.
const MONTH_KEEP_ = "mt1_";
const MONTH_FIELDS_ = ["bills", "items", "new_customers", "sales", "returns", "gst", "revenue", "cost"];
// how far back months are kept: the most a report can show (24 months, this one included). The store is
// shared with the app's own settings and capped by Google, so older ones are let go.
const MONTH_KEEP_SPAN_ = 24;

// "yyyy-mm" n months before ym
function monthsBefore_(ym, n) {
    const k = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 - n;
    return Math.floor(k / 12) + "-" + pad_((k % 12) + 1, 2);
}

function monthEnd_(ym) {
    const y = Number(ym.slice(0, 4));
    const m = Number(ym.slice(5, 7));
    return ym + "-" + pad_(new Date(Date.UTC(y, m, 0)).getUTCDate(), 2);
}

function nextMonth_(ym) {
    const y = Number(ym.slice(0, 4));
    const m = Number(ym.slice(5, 7));
    return m === 12 ? y + 1 + "-01" : y + "-" + pad_(m + 1, 2);
}

/**
 * The calendar months between from and to, each cut to the range. A month can be kept once it is whole
 * and over by more than a day: nothing in the app changes an older bill's month after that (a void is
 * same-day only, a return counts on the day it is made, a request can't date a bill — fromPhone_), and
 * the spare day covers a bill saved across midnight. Only the last MONTH_KEEP_SPAN_ months are kept.
 */
function monthPieces_(from, to) {
    const settled = daysAgoStr_(1);
    const oldest = oldestKeptMonth_();
    const out = [];
    for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = nextMonth_(m)) {
        const first = m + "-01";
        const last = monthEnd_(m);
        const pFrom = from > first ? from : first;
        const pTo = to < last ? to : last;
        const whole = pFrom === first && pTo === last;
        out.push({ month: m, from: pFrom, to: pTo, partial: !whole, keep: whole && last < settled && m >= oldest });
    }
    return out;
}

function oldestKeptMonth_() {
    return monthsBefore_(todayStr_().slice(0, 7), MONTH_KEEP_SPAN_ - 1);
}

/**
 * The sales side of each month from `from` to `to`: one read of the bills, their lines and credit notes
 * for the whole span, then sorted into months. Expenses are not in here; they can be backdated, so they
 * are always added fresh (reportPerformance_).
 */
function monthFigures_(ctx, from, to) {
    const { sales, returns } = scope_(ctx, from, to);
    const rs = sales.filter((s) => inRange_(s.date, from, to));
    const rets = returns.filter((r) => inRange_(r.at, from, to));
    const saleLines = saleItemsFor_(rs.map((s) => s.id));
    const returnLines = returnItemsFor_(rets.map((r) => r.id));
    const first = firstBillByCustomer_();
    // each bill, credit note and line into its month, in one pass
    const by = {};
    const bucket = (m) => (by[m] = by[m] || { sales: [], returns: [], saleLines: [], returnLines: [] });
    const saleMonth = {};
    const returnMonth = {};
    rs.forEach((s) => bucket((saleMonth[s.id] = d10_(s.date).slice(0, 7))).sales.push(s));
    rets.forEach((r) => bucket((returnMonth[r.id] = d10_(r.at).slice(0, 7))).returns.push(r));
    saleLines.forEach((i) => saleMonth[i.sale_id] && by[saleMonth[i.sale_id]].saleLines.push(i));
    returnLines.forEach((i) => returnMonth[i.return_id] && by[returnMonth[i.return_id]].returnLines.push(i));
    const out = {};
    Object.keys(by).forEach((m) => {
        const b = by[m];
        const pr = profitOf_(b.sales, b.returns, 0, b.saleLines, b.returnLines);
        out[m] = {
            bills: b.sales.length,
            items: itemsOf_(b.sales),
            new_customers: b.sales.filter((s) => isNewCustomer_(s, first)).length,
            sales: sumBy_(b.sales, "grand_total"),
            returns: sumBy_(b.returns, "total"),
            gst: r2_(sumBy_(b.sales, (s) => s.cgst + s.sgst) - sumBy_(b.returns, "tax")),
            revenue: pr.revenue,
            cost: pr.cost,
            // the month's leaderboard, kept short: [id, name, bills, items, new customers, sales, returns].
            // Google reviews are not in it — they are counted fresh (one can be marked "Doesn't count" later)
            people: leaderboard_(b.sales, b.returns, null, null, []).map((r) => [r.salesman_id, r.name, r.bills, r.items, r.new_customers, r.sales, r.returns]),
        };
    });
    return out;
}

// the leaderboard for the whole range: each month's people added up (the latest month's name wins), then the
// counted Google reviews; rows shaped like leaderboard_'s, so Reports → Salespeople and this agree
function performancePeople_(monthsPeople, reviews) {
    const m = {};
    const row = (id, name) =>
        (m[id] = m[id] || { salesman_id: id, name: name || "", bills: 0, items: 0, new_customers: 0, sales: 0, returns: 0, reviews: 0, samples: 0 });
    monthsPeople.forEach((list) =>
        list.forEach((x) => {
            const r = row(x[0], x[1]);
            if (x[1]) r.name = x[1];
            r.bills += x[2];
            r.items = r3_(r.items + x[3]);
            r.new_customers += x[4];
            r.sales = r2_(r.sales + x[5]);
            r.returns = r2_(r.returns + x[6]);
        }),
    );
    reviews.forEach((v) => {
        const r = row(v.salesman_id, v.salesman_name);
        r.reviews++;
        if (v.sample) r.samples++;
    });
    return Object.keys(m)
        .map((k) => {
            const r = m[k];
            r.net = r2_(r.sales - r.returns);
            r.avg_bill = r.bills ? r2_(r.sales / r.bills) : 0;
            return r;
        })
        .sort((a, b) => b.net - a.net);
}

// what every month and the total show, worked out the same way as profitOf_
function performanceRow_(f, expenses) {
    const gross = r2_(f.revenue - f.cost);
    return Object.assign({}, f, {
        expenses,
        net: r2_(f.sales - f.returns),
        avg_bill: f.bills ? r2_(f.sales / f.bills) : 0,
        gross,
        profit: r2_(gross - expenses),
        margin: f.revenue ? r2_((gross / f.revenue) * 100) : 0,
    });
}

// this view's kept month totals that can be used as they are: { "yyyy-mm": figures }. Marks those pieces
// `kept`. A value that can't be read, or lacks a field, is simply worked out again.
function readKeptMonths_(kept, keyOf, pieces) {
    const figures = {};
    pieces.forEach((pc) => {
        const raw = pc.keep && kept[keyOf(pc.month)];
        if (!raw) return;
        try {
            const v = JSON.parse(raw);
            if (MONTH_FIELDS_.every((k) => typeof v[k] === "number") && Array.isArray(v.people)) {
                figures[pc.month] = v;
                pc.kept = true;
            }
        } catch (e) {
            /* worked out again */
        }
    });
    return figures;
}

/**
 * Keeps the months just worked out, in one write, and lets go of any kept month (any view) older than
 * MONTH_KEEP_SPAN_. The store is shared with the app's own settings and capped by Google, so a write that
 * fails is logged and the report still answers: those months are worked out again next time.
 */
function keepMonths_(props, kept, entries) {
    try {
        const oldest = oldestKeptMonth_();
        Object.keys(kept)
            .filter((k) => k.indexOf(MONTH_KEEP_) === 0 && k.slice(-7) < oldest)
            .forEach((k) => props.deleteProperty(k));
        if (Object.keys(entries).length) props.setProperties(entries);
    } catch (e) {
        console.error("keepMonths_", e);
    }
}

// the range's totals: the months added up (expenses, reviews and the derived figures are added by the caller)
function sumMonths_(months) {
    const add = (k) => months.reduce((a, m) => a + m[k], 0);
    return {
        bills: add("bills"), items: r3_(add("items")), new_customers: add("new_customers"),
        sales: r2_(add("sales")), returns: r2_(add("returns")), gst: r2_(add("gst")), revenue: r2_(add("revenue")), cost: r2_(add("cost")),
    };
}

function reportPerformance_(p, ctx) {
    // the whole shop's (or branch's) figures, and they are kept as such: never worked out for one person
    if (ctx.user.role !== "owner" && ctx.user.role !== "manager") fail_("Access denied");
    const { from, to } = rangeOf_(p);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) fail_("Pick the dates again");
    const monthNo = (d) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7));
    if (monthNo(to) - monthNo(from) + 1 > 24) fail_("Pick at most 24 months");
    const pieces = monthPieces_(from, to);
    // only the owner can have the kept months worked out again (after a hand edit of the Google Sheet):
    // every branch view's are let go, so none of them keeps showing the old figures
    if (p.recalc && ctx.user.role === "owner") clearMonthTotals_();
    const props = PropertiesService.getScriptProperties();
    const kept = props.getProperties();
    const keyOf = (m) => MONTH_KEEP_ + (ctx.branch_id || 0) + "_" + m;
    const figures = readKeptMonths_(kept, keyOf, pieces);
    // the rest, read in as few spans as possible (at most a cut month at each end around kept ones)
    let run = null;
    const runs = [];
    pieces.forEach((pc) => {
        if (pc.kept) return (run = null);
        if (run) run.to = pc.to;
        else runs.push((run = { from: pc.from, to: pc.to }));
    });
    runs.forEach((r) => Object.assign(figures, monthFigures_(ctx, r.from, r.to)));
    // expenses: always fresh, a backdated or edited one shows at once
    const exp = {};
    rows_("Expenses").forEach((e) => {
        if (e.date < from || e.date > to || !inBranch_(ctx, e.branch_id)) return;
        const m = String(e.date).slice(0, 7);
        exp[m] = r2_((exp[m] || 0) + e.amount);
    });
    // counted Google reviews: always fresh too (the owner can say one doesn't count, months later)
    const reviews = reviewsIn_(ctx, from, to);
    const rv = {};
    reviews.forEach((v) => {
        const m = d10_(v.at).slice(0, 7);
        const r = (rv[m] = rv[m] || { reviews: 0, samples: 0 });
        r.reviews++;
        if (v.sample) r.samples++;
    });
    const zero = { people: [] };
    MONTH_FIELDS_.forEach((k) => (zero[k] = 0));
    const toKeep = {};
    const months = pieces.map((pc) => {
        const f = Object.assign({}, zero, figures[pc.month] || {});
        if (pc.keep && !pc.kept) toKeep[keyOf(pc.month)] = JSON.stringify(MONTH_FIELDS_.reduce((o, k) => ((o[k] = f[k]), o), { people: f.people }));
        const row = Object.assign({ month: pc.month, from: pc.from, to: pc.to, partial: pc.partial }, performanceRow_(f, exp[pc.month] || 0), rv[pc.month] || { reviews: 0, samples: 0 });
        delete row.people; // the range's leaderboard is sent once, below
        return row;
    });
    keepMonths_(props, kept, toKeep);
    return {
        from, to,
        branch_name: ctx.branch_id ? branchName_(ctx.branch_id) : "All branches",
        months,
        totals: Object.assign(performanceRow_(sumMonths_(months), r2_(months.reduce((a, m) => a + m.expenses, 0))), {
            reviews: reviews.length,
            samples: reviews.filter((v) => v.sample).length,
        }),
        people: performancePeople_(pieces.map((pc) => (figures[pc.month] || zero).people), reviews),
        kept: pieces.filter((pc) => pc.kept).length,
    };
}

// every kept month total (Reset test data, the owner's Recalculate); the next Performance report works them out again
function clearMonthTotals_() {
    const props = PropertiesService.getScriptProperties();
    const keys = Object.keys(props.getProperties()).filter((k) => k.indexOf(MONTH_KEEP_) === 0);
    keys.forEach((k) => props.deleteProperty(k));
    return keys.length;
}

function reportStock_(p, ctx) {
    const branchStock = stockMap_(ctx.branch_id);
    const pmap = indexBy_(rows_("Products"), "id");
    const bmap = indexBy_(rows_("Brands"), "id");
    const cmap = indexBy_(rows_("Categories"), "id");
    const byCat = {};
    const items = [];
    rows_("Variants").forEach((v) => {
        const prod = pmap[v.product_id];
        if (!prod || !v.active) return;
        const cat = cmap[prod.category_id] ? cmap[prod.category_id].name : "—";
        const qty = Math.max(0, branchStock[v.id] || 0);
        const cost = r2_(qty * v.avg_cost);
        const retail = r2_(qty * v.sell_price);
        const c = (byCat[cat] = byCat[cat] || { category: cat, pcs: 0, ml: 0, cost: 0, retail: 0 });
        if (v.unit === "ml") c.ml = r3_(c.ml + qty);
        else c.pcs = r3_(c.pcs + qty);
        c.cost = r2_(c.cost + cost);
        c.retail = r2_(c.retail + retail);
        items.push({
            name: prod.name, brand: bmap[prod.brand_id] ? bmap[prod.brand_id].name : "", size: v.size_label, unit: v.unit,
            barcode: v.barcode, stock_qty: branchStock[v.id] || 0, avg_cost: v.avg_cost, sell_price: v.sell_price, cost, retail, category: cat,
        });
    });
    const cats = Object.keys(byCat).map((k) => byCat[k]).sort((a, b) => b.retail - a.retail);
    return { categories: cats, items, totals: { cost: sumBy_(cats, "cost"), retail: sumBy_(cats, "retail") } };
}

function reportExpenses_(p, ctx) {
    const { from, to } = rangeOf_(p);
    const rows = rows_("Expenses").filter((e) => e.date >= from && e.date <= to && inBranch_(ctx, e.branch_id));
    const byCat = {};
    rows.forEach((e) => (byCat[e.category] = r2_((byCat[e.category] || 0) + e.amount)));
    return {
        from, to,
        by_category: Object.keys(byCat).map((k) => ({ category: k, amount: byCat[k] })).sort((a, b) => b.amount - a.amount),
        rows: rows.map((e) => ({ date: e.date, category: e.category, title: e.title, amount: e.amount, method: e.method })),
        total: sumBy_(rows, "amount"),
    };
}

// totals per branch for the owner's "All branches" view
function branchBreakdown_(sales, returns, from, to, monthFrom) {
    return activeBranches_().map((b) => {
        const mine = (v) => bid_(v) === b.id;
        const bs = sales.filter((s) => mine(s.branch_id) && inRange_(s.date, from, to));
        const br = returns.filter((r) => mine(r.branch_id) && inRange_(r.at, from, to));
        const row = {
            branch_id: b.id, name: b.name, bills: bs.length,
            items: itemsOf_(bs),
            // customers whose FIRST bill anywhere was here, so each one is counted at one branch only
            // and the branches add up to the shop's total
            new_customers: newCustomersIn_(bs),
            sales: sumBy_(bs, "grand_total"), returns: sumBy_(br, "total"),
        };
        row.net = r2_(row.sales - row.returns);
        if (monthFrom) {
            row.month_net = r2_(
                sumBy_(sales.filter((s) => mine(s.branch_id) && inRange_(s.date, monthFrom, to)), "grand_total") -
                    sumBy_(returns.filter((r) => mine(r.branch_id) && inRange_(r.at, monthFrom, to)), "total"),
            );
        }
        return row;
    });
}

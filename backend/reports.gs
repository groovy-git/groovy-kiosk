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
    saleItemsFor_(Object.keys(mSaleIds).map(Number)).forEach((i) => {
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
        },
        trend: days.map((d) => ({ date: d, net: r2_(byDay[d]) })),
        top_products: Object.keys(top)
            .map((k) => top[k])
            .sort((a, b) => b.amount - a.amount)
            .slice(0, 8),
        low_stock: lowStock.slice(0, 15),
        low_stock_count: lowStock.length,
        leaderboard: {
            today: leaderboard_(sales, returns, today, today),
            month: leaderboard_(sales, returns, monthStart, today),
        },
    };
    if (!ctx.branch_id) data.by_branch = branchBreakdown_(sales, returns, today, today, monthStart);
    if (!own) {
        data.month_expenses = sumBy_(rows_("Expenses").filter((e) => e.date >= monthStart && inBranch_(ctx, e.branch_id)), "amount");
        data.month_net = r2_(
            sumBy_(sales.filter((s) => d10_(s.date) >= monthStart), "grand_total") -
                sumBy_(returns.filter((r) => d10_(r.at) >= monthStart), "total"),
        );
    }
    return { data };
}

function leaderboard_(sales, returns, from, to) {
    const m = {};
    const row = (id, name) =>
        (m[id] = m[id] || { salesman_id: id, name: name || "", bills: 0, items: 0, new_customers: 0, sales: 0, returns: 0, net: 0 });
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
        stock_valuation: reportStock_,
        expenses: reportExpenses_,
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
        by_salesman: leaderboard_(sales, returns, date, date),
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
    const base = leaderboard_(sales, returns, from, to);
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
            invoice_no: s.invoice_no, date: s.date, customer: s.customer_name || "Walk-in", phone: s.customer_phone,
            gstin: s.customer_gstin, salesperson: s.salesman_name, taxable: s.taxable, cgst: s.cgst, sgst: s.sgst,
            round_off: s.round_off, total: s.grand_total, refunded: s.refunded, status: s.status,
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

function reportProfit_(p, ctx) {
    const { from, to } = rangeOf_(p);
    const { sales, returns } = scope_(ctx, from, to);
    const rs = sales.filter((s) => inRange_(s.date, from, to));
    const ids = indexBy_(rs, "id");
    let cogs = 0;
    saleItemsFor_(rs.map((s) => s.id)).forEach((i) => {
        if (ids[i.sale_id]) cogs += i.unit_cost * i.qty;
    });
    const rets = returns.filter((r) => inRange_(r.at, from, to));
    const rIds = indexBy_(rets, "id");
    let retCost = 0;
    returnItemsFor_(rets.map((r) => r.id)).forEach((ri) => {
        if (rIds[ri.return_id] && ri.restock) retCost += ri.unit_cost * ri.qty; // non-restocked goods stay a loss
    });
    const revenue = r2_(sumBy_(rs, "taxable") - sumBy_(rets, "taxable"));
    const netCogs = r2_(cogs - retCost);
    const expenses = sumBy_(rows_("Expenses").filter((e) => e.date >= from && e.date <= to && inBranch_(ctx, e.branch_id)), "amount");
    const gross = r2_(revenue - netCogs);
    return {
        from, to,
        sales_incl_gst: sumBy_(rs, "grand_total"),
        returns_incl_gst: sumBy_(rets, "total"),
        gst_collected: r2_(sumBy_(rs, (s) => s.cgst + s.sgst) - sumBy_(rets, "tax")),
        revenue_ex_gst: revenue,
        cost_of_goods: netCogs,
        gross_profit: gross,
        expenses,
        net_profit: r2_(gross - expenses),
        margin_pct: revenue ? r2_((gross / revenue) * 100) : 0,
    };
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

/** Sales: checkout, held bills, list/detail, void, returns (credit notes). */

function canSeeSale_(ctx, s) {
    if (ctx.user.role === "owner") return true;
    if (ctx.user.role === "salesperson") return s.salesman_id === ctx.user.id || s.created_by === ctx.user.id;
    return allowedBranchIds_(ctx.user).indexOf(bid_(s.branch_id)) >= 0; // manager: branches they work at
}

// `pre` = the bill's rows when the caller already has them in hand (a bill it has just written),
// so they aren't read back off the sheet
function saleDetail_(s, ctx, pre) {
    const hideCost = !ctx || ctx.user.role === "salesperson"; // cost prices are for managers only
    // one bill's lines, not every line ever sold: both tables are written in bill order, so the
    // rows for this bill sit together and can be read as a small block
    const items = pre ? pre.items : windowRows_("Sale_Items", "sale_id", s.id, s.id);
    const pays = pre ? pre.payments : windowRows_("Payments", "sale_id", s.id, s.id);
    const rets = pre ? pre.returns : windowRows_("Returns", "sale_id", s.id, s.id);
    const retItems = pre ? pre.retItems : rets.length ? windowRows_("Return_Items", "return_id", rets[0].id, rets[rets.length - 1].id) : [];
    const strip = (o) => {
        const c = Object.assign({}, o);
        delete c._r;
        if (hideCost) delete c.unit_cost;
        return c;
    };
    const b = branchById_(bid_(s.branch_id));
    return {
        sale: Object.assign(strip(s), { branch_id: bid_(s.branch_id) }),
        branch: b ? branchOut_(b) : null,
        items: items.map(strip),
        payments: pays.map(strip),
        returns: rets.map((r) =>
            Object.assign(strip(r), { items: retItems.filter((ri) => ri.return_id === r.id).map(strip) }),
        ),
    };
}

/* ---------- checkout ---------- */

/**
 * p = {client_ref, lines:[{variant_id, qty, discount}], bill_disc,
 *      customer:{phone, name, gstin}, salesman_id, payments:[{method, amount, reference}], notes, held_id}
 * Prices, tax and totals are always computed here from the sheet — never taken from the client.
 */
function apiCompleteSale_(p, ctx) {
    const clientRef = str_(p.client_ref);
    if (!clientRef || clientRef.length > 64) fail_("Missing sale reference, please retry");
    const lines = mergeLines_(p.lines);
    if (!lines.length) fail_("Cart is empty");

    const branch = requireBranch_(ctx);
    return withLock_(() => completeSaleLocked_(p, ctx, clientRef, lines, branch));
}

/**
 * The body of a sale, for a caller that already holds the lock (see apiExchange_).
 * opts, used by an exchange: `extraStock` counts items coming back in the same breath as this sale,
 * `credit` settles part of the bill with a credit note, and `preview` works the bill out and checks
 * everything without writing a thing.
 */
function completeSaleLocked_(p, ctx, clientRef, lines, branch, opts) {
    // idempotency: a retried/double-tapped request returns the sale already saved
    const existing = findBy_("Sales", "client_ref", clientRef);
    if (existing) return { message: "Sale already saved", data: saleDetail_(existing, ctx) };

    const role = ctx.user.role;
    const sellerId = Number(p.salesman_id || ctx.user.id);
    if (role === "salesperson" && sellerId !== ctx.user.id) fail_("A salesperson can only bill under their own name");
    const seller = findBy_("Users", "id", sellerId);
    if (!seller || !seller.active) fail_("Selected salesperson is not active");
    if (allowedBranchIds_(seller).indexOf(branch) < 0) fail_(seller.name + " does not work at " + branchName_(branch));

    const s = settingsMap_();
    const vmap = indexBy_(rows_("Variants"), "id");
    const pmap = indexBy_(rows_("Products"), "id");
    const bmap = indexBy_(rows_("Brands"), "id");
    const allowNeg = s.allow_negative_stock === "yes";

    // a branch without GST bills at 0%: prices include GST, so the customer pays the same — the whole line
    // is the taxable value, no CGST/SGST (and the bill is left out of GST reports)
    const gstOff = branchGstOff_(branch);
    const priced = lines.map((l) => {
        const v = vmap[l.variant_id];
        const prod = v && pmap[v.product_id];
        if (!v || !prod) fail_("An item in the cart no longer exists");
        const label = prod.name + " " + v.size_label;
        if (!v.active || !prod.active) fail_(label + " is not available for sale");
        if (l.qty <= 0) fail_("Quantity must be above 0 for " + label);
        if (v.unit === "pcs" && Math.floor(l.qty) !== l.qty) fail_("Quantity must be a whole number for " + label);
        const have = r3_(stockOf_(v.id, branch) + ((opts && opts.extraStock && opts.extraStock[v.id]) || 0));
        if (!allowNeg && l.qty > have) fail_("Only " + have + " " + (v.unit === "ml" ? "ml" : "pcs") + " of " + label + " in stock at " + branchName_(branch));
        return {
            variant_id: v.id, qty: l.qty, discount: l.discount, price: v.sell_price, gst_rate: gstOff ? 0 : prod.gst_rate,
            _v: v, _prod: prod, _brand: bmap[prod.brand_id] ? bmap[prod.brand_id].name : "",
        };
    });

    const bill = computeBill_(priced, p.bill_disc, s.round_off !== "no");

    if (role === "salesperson") {
        const cap = num_(s.salesman_max_disc_pct, 10);
        const disc = bill.item_disc + bill.bill_disc;
        if (bill.gross > 0 && (disc / bill.gross) * 100 > cap + 0.001)
            fail_("Discount limit for a salesperson is " + cap + "%. Ask a manager.");
    }

    // payments
    const pays = (p.payments || [])
        .map((x) => ({ method: str_(x.method).toLowerCase(), amount: r2_(num_(x.amount)), reference: str_(x.reference).slice(0, 60) }))
        .filter((x) => x.amount !== 0);
    pays.forEach((x) => {
        if (PAYMENT_METHODS.indexOf(x.method) < 0) fail_("Unknown payment method " + x.method);
        if (x.amount < 0) fail_("Payment amount cannot be negative");
    });

    // an exchange settles part of this bill with the credit note for what came back
    if (opts && opts.credit && opts.credit.amount > 0)
        pays.unshift({ method: EXCHANGE_METHOD_, amount: r2_(Math.min(opts.credit.amount, bill.grand_total)), reference: str_(opts.credit.reference).slice(0, 60) });
    const tendered = r2_(pays.reduce((a, x) => a + x.amount, 0));
    const cashIn = r2_(pays.filter((x) => x.method === "cash").reduce((a, x) => a + x.amount, 0));
    const nonCash = r2_(tendered - cashIn);
    if (tendered + 0.001 < bill.grand_total) fail_("Payment is short by ₹" + r2_(bill.grand_total - tendered));
    if (nonCash > bill.grand_total + 0.001) fail_("UPI/Card amount is more than the bill");
    const change = r2_(tendered - bill.grand_total);
    if (change > cashIn + 0.001) fail_("Change can only be returned from cash");

    // Every rule above has held and nothing has been written yet — not the bill number, not the
    // customer row. An exchange stops here on its first pass to learn what the replacement costs.
    if (opts && opts.preview) return { preview: true, grand_total: bill.grand_total, tendered, change };

    const now = p._at || nowStr_(); // _at only used by demo seeding
    const fy = fyOf_(now);
    const cust = upsertSaleCustomer_(p.customer, bill.grand_total, now);
    const custGstin = str_(p.customer && p.customer.gstin).toUpperCase();

    const saleId = nextId_("Sales");
    const code = branchCode_(branch); // each branch has its own bill series
    const invNo = invoiceNo_(s.invoice_prefix, fy, nextCounter_(code ? "inv_seq_" + code + "_" + fy : "inv_seq_" + fy), code);
    const sale = {
        id: saleId, client_ref: clientRef, invoice_no: invNo, fy, date: now,
        customer_id: cust ? cust.id : 0,
        customer_name: cust ? cust.name : str_(p.customer && p.customer.name),
        customer_phone: cust ? cust.phone : "",
        customer_gstin: cust ? cust.gstin : custGstin,
        salesman_id: seller.id, salesman_name: seller.name, created_by: ctx.user.id,
        items: r3_(priced.reduce((a, l) => a + (l._v.unit === "pcs" ? l.qty : 1), 0)),
        gross: bill.gross, item_disc: bill.item_disc, bill_disc: bill.bill_disc, taxable: bill.taxable,
        cgst: bill.cgst, sgst: bill.sgst, round_off: bill.round_off, grand_total: bill.grand_total,
        tendered, change, refunded: 0, status: "completed", notes: str_(p.notes).slice(0, 300), updated_at: now,
        gst_hidden: gstOff ? GST_OFF_BRANCH_ : p.gst_hidden ? 1 : 0, // decided here, whatever the app sent
        branch_id: branch,
    };

    let siId = nextId_("Sale_Items");
    const bal = addStock_(priced.map((l) => ({ variant_id: l._v.id, branch_id: branch, delta: -l.qty })));
    let mId = nextId_("Stock_Movements");
    const saleItems = [];
    const moves = [];
    bill.lines.forEach((l, i) => {
        const pl = priced[i];
        const v = pl._v;
        saleItems.push({
            id: siId++, sale_id: saleId, variant_id: v.id, product_name: pl._prod.name, brand: pl._brand,
            size: v.size_label, barcode: v.barcode, hsn: pl._prod.hsn, qty: l.qty, unit: v.unit, mrp: v.mrp,
            price: l.price, discount: l.discount, bill_disc_share: l.bill_disc_share, line_total: l.line_total,
            gst_rate: l.gst_rate, taxable: l.taxable, tax: l.tax, unit_cost: v.avg_cost, returned_qty: 0,
        });
        moves.push({
            id: mId++, variant_id: v.id, type: "sale", qty: -l.qty, unit_cost: v.avg_cost, balance: bal[v.id + "|" + branch],
            ref_type: "sale", ref_id: String(saleId), note: invNo, user_id: ctx.user.id, at: now, branch_id: branch,
        });
    });

    let payId = nextId_("Payments");
    const payRows = [];
    pays.forEach((x) => {
        const amt = x.method === "cash" ? r2_(x.amount - change) : x.amount; // record cash net of change
        if (amt <= 0) return;
        payRows.push({ id: payId++, sale_id: saleId, return_id: 0, method: x.method, amount: amt, reference: x.reference, user_id: ctx.user.id, at: now });
    });

    appendRows_("Sales", [sale]);
    delete REQ_CACHE_.__firstBill; // this bill may be a customer's first — don't answer from a map built before it
    appendRows_("Sale_Items", saleItems);
    appendRows_("Payments", payRows);
    appendRows_("Stock_Movements", moves);
    bumpStockVersion_();

    if (p.held_id) {
        const h = findBy_("Held_Bills", "id", Number(p.held_id));
        if (h) deleteRow_("Held_Bills", h);
    }
    log_(ctx, "SALE", "Sales", saleId, invNo + " ₹" + sale.grand_total + " by " + seller.name);
    // answered from the rows just written rather than reading them back — a new bill has no returns
    const pre = {
        items: saleItems.map((o) => asStored_("Sale_Items", o)),
        payments: payRows.map((o) => asStored_("Payments", o)),
        returns: [],
        retItems: [],
    };
    return { message: "Sale completed", data: saleDetail_(asStored_("Sales", sale), ctx, pre) };
}

/* ---------- list / detail ---------- */

function apiListSales_(p, ctx) {
    const from = str_(p.from) || todayStr_();
    const to = str_(p.to) || todayStr_();
    // only the bills in the range are read off the sheet, not the whole history
    let rows = windowRows_("Sales", "date", from, to);
    if (ctx.user.role === "salesperson") rows = rows.filter((s) => s.salesman_id === ctx.user.id);
    else {
        rows = rows.filter((s) => inBranch_(ctx, s.branch_id));
        if (p.salesman_id) rows = rows.filter((s) => s.salesman_id === Number(p.salesman_id));
    }
    if (p.status) rows = rows.filter((s) => s.status === p.status);
    const q = str_(p.q).toLowerCase();
    if (q)
        rows = rows.filter(
            (s) => s.invoice_no.toLowerCase().indexOf(q) >= 0 || s.customer_phone.indexOf(q) >= 0 || s.customer_name.toLowerCase().indexOf(q) >= 0,
        );
    const ids = {};
    rows.forEach((s) => (ids[s.id] = true));
    const methods = {};
    // payments are written bill by bill, so the ones for these bills sit in one block
    const payRows = rows.length ? windowRows_("Payments", "sale_id", rows[0].id, rows[rows.length - 1].id) : [];
    payRows.forEach((x) => {
        if (!ids[x.sale_id] || x.amount <= 0) return;
        methods[x.sale_id] = methods[x.sale_id] || {};
        methods[x.sale_id][x.method] = true;
    });
    const list = rows
        .slice()
        .reverse()
        .map((s) => ({
            id: s.id, invoice_no: s.invoice_no, date: s.date, customer_name: s.customer_name, customer_phone: s.customer_phone,
            salesman_id: s.salesman_id, salesman_name: s.salesman_name, items: s.items, grand_total: s.grand_total,
            refunded: s.refunded, status: s.status, methods: Object.keys(methods[s.id] || {}),
            branch_id: bid_(s.branch_id), branch_name: branchName_(bid_(s.branch_id)),
        }));
    const valid = list.filter((s) => s.status !== "voided");
    const total = r2_(valid.reduce((a, s) => a + s.grand_total - s.refunded, 0));
    // the same bills again, as sheet rows — they carry customer_id, which the list above leaves out
    const validRows = rows.filter((s) => s.status !== "voided");
    return {
        data: {
            sales: list,
            summary: { bills: valid.length, net: total, items: itemsOf_(validRows), new_customers: newCustomersIn_(validRows) },
        },
    };
}

function apiGetSale_(p, ctx) {
    const s = p.id ? findById_("Sales", p.id) : findBy_("Sales", "invoice_no", str_(p.invoice_no));
    if (!s) fail_("Bill not found");
    if (!canSeeSale_(ctx, s)) fail_("You can only view your own bills");
    return { data: saleDetail_(s, ctx) };
}

/* ---------- void (same day, full reversal) ---------- */

function apiVoidSale_(p, ctx) {
    const reason = str_(p.reason);
    if (!reason) fail_("Please give a reason");
    const branch = requireBranch_(ctx);
    return withLock_(() => {
        const s = findBy_("Sales", "id", Number(p.id));
        if (!s) fail_("Bill not found");
        if (bid_(s.branch_id) !== branch) fail_("This bill was made at " + branchName_(bid_(s.branch_id)) + ". Void it from that branch.");
        if (s.status !== "completed") fail_("Only a completed bill without returns can be voided");
        if (s.date.slice(0, 10) !== todayStr_()) fail_("Only today's bills can be voided. Use Return instead.");
        // an exchange paid for part of this bill; reversing the bill alone would leave that credit
        // note paying for nothing, so it goes back the same way any sold item does
        if (windowRows_("Payments", "sale_id", s.id, s.id).some((x) => x.method === EXCHANGE_METHOD_ && x.amount > 0))
            fail_("This bill was part paid by an exchange. Use Return items instead of voiding it.");
        const now = nowStr_();
        const vmap = indexBy_(rows_("Variants"), "id");
        const items = rows_("Sale_Items").filter((i) => i.sale_id === s.id);
        let mId = nextId_("Stock_Movements");
        const moves = [];
        const back = items.filter((i) => vmap[i.variant_id]);
        const bal = addStock_(back.map((i) => ({ variant_id: i.variant_id, branch_id: branch, delta: i.qty })));
        back.forEach((i) => {
            moves.push({
                id: mId++, variant_id: i.variant_id, type: "void", qty: i.qty, unit_cost: i.unit_cost, balance: bal[i.variant_id + "|" + branch],
                ref_type: "sale", ref_id: String(s.id), note: "Void " + s.invoice_no, user_id: ctx.user.id, at: now, branch_id: branch,
            });
        });
        let payId = nextId_("Payments");
        const refunds = rows_("Payments")
            .filter((x) => x.sale_id === s.id && x.amount > 0)
            .map((x) => ({ id: payId++, sale_id: s.id, return_id: 0, method: x.method, amount: -x.amount, reference: "VOID", user_id: ctx.user.id, at: now }));
        appendRows_("Stock_Movements", moves);
        appendRows_("Payments", refunds);
        s.status = "voided";
        s.refunded = s.grand_total;
        s.notes = (s.notes ? s.notes + " | " : "") + "VOID: " + reason;
        s.updated_at = now;
        updateRows_("Sales", [s]);
        adjustCustomerTotals_(s.customer_id, -s.grand_total, -1);
        bumpStockVersion_();
        log_(ctx, "VOID", "Sales", s.id, s.invoice_no + " — " + reason);
        return { message: "Bill voided, stock restored", data: saleDetail_(s, ctx) };
    });
}

/* ---------- returns → credit note ---------- */

/**
 * p = {sale_id, items:[{sale_item_id, qty, restock}], refund_method, reason, override}
 */
function apiReturnItems_(p, ctx) {
    const method = str_(p.refund_method).toLowerCase();
    if (PAYMENT_METHODS.indexOf(method) < 0) fail_("Choose how the refund is paid");
    const reason = str_(p.reason);
    if (!reason) fail_("Please give a reason");
    const req = (p.items || []).filter((x) => num_(x.qty) > 0);
    if (!req.length) fail_("Select items to return");
    const branch = requireBranch_(ctx);

    return withLock_(() => returnItemsLocked_(p, ctx, method, reason, req, branch));
}

/**
 * The body of a return, for a caller that already holds the lock (see apiExchange_).
 * opts, used by an exchange: `payOut` spells out the refund rows (left out, the whole refund goes
 * out by `method`, as it always has), `forExchange` leaves the cash limit to the caller, and `preview`
 * works out what the items are worth and checks every rule without writing.
 */
function returnItemsLocked_(p, ctx, method, reason, req, branch, opts) {
    const s = findBy_("Sales", "id", Number(p.sale_id));
    if (!s) fail_("Bill not found");
    if (bid_(s.branch_id) !== branch) fail_("This bill was made at " + branchName_(bid_(s.branch_id)) + ". Returns are accepted only at that branch.");
    if (s.status === "voided" || s.status === "returned") fail_("Nothing left to return on this bill");
    const days = num_(setting_("return_days"), 3);
    const ageDays = Math.floor((new Date(todayStr_()).getTime() - new Date(s.date.slice(0, 10)).getTime()) / 86400000);
    if (ageDays > days && !(p.override && ctx.user.role === "owner"))
        fail_("Return window of " + days + " days is over (bill is " + ageDays + " days old). Only the owner can override.");

    const now = nowStr_();
    const allItems = rows_("Sale_Items").filter((i) => i.sale_id === s.id);
    const byId = indexBy_(allItems, "id");
    const vmap = indexBy_(rows_("Variants"), "id");
    const retId = nextId_("Returns");
    let riId = nextId_("Return_Items");
    let mId = nextId_("Stock_Movements");
    const retItems = [];
    const moves = [];
    const restocks = [];
    const touchedSI = [];
    let total = 0;
    let taxable = 0;

    req.forEach((x) => {
        const si = byId[Number(x.sale_item_id)];
        if (!si) fail_("Item is not on this bill");
        const qty = r3_(num_(x.qty));
        const avail = r3_(si.qty - si.returned_qty);
        if (qty > avail + 0.0001) fail_("Only " + avail + " of " + si.product_name + " can be returned");
        if (si.unit === "pcs" && Math.floor(qty) !== qty) fail_("Return quantity must be whole for " + si.product_name);
        const amount = r2_((si.line_total * qty) / si.qty);
        const tx = r2_((si.taxable * qty) / si.qty);
        total += amount;
        taxable += tx;
        si.returned_qty = r3_(si.returned_qty + qty);
        touchedSI.push(si);
        const restock = x.restock === false || x.restock === 0 ? 0 : 1;
        retItems.push({
            id: riId++, return_id: retId, sale_item_id: si.id, variant_id: si.variant_id, qty, amount,
            taxable: tx, tax: r2_(amount - tx), unit_cost: si.unit_cost, restock,
        });
        if (restock && vmap[si.variant_id]) restocks.push({ variant_id: si.variant_id, qty, unit_cost: si.unit_cost });
    });
    const fullyReturned = allItems.every((i) => i.returned_qty >= i.qty - 0.0001);
    // last return settles the rupee round-off exactly
    total = fullyReturned ? r2_(s.grand_total - s.refunded) : r2_(total);
    taxable = r2_(taxable);

    // What a salesperson may hand back. Checked here, before the first write, so a refused
    // return leaves nothing behind; and counted across the whole bill, because a bill can be
    // returned a few items at a time and four small refunds must not add up past the limit.
    if (ctx.user.role === "salesperson" && !(opts && opts.forExchange)) {
        const cap = num_(setting_("salesperson_max_return"), 2000);
        if (!cap) fail_("Only a manager can accept a return. Ask a manager.");
        if (r2_(s.refunded + total) > cap + 0.001) {
            const had = s.refunded > 0 ? " (₹" + r2_(s.refunded) + " already refunded on it)" : "";
            fail_("Refund limit for a salesperson is ₹" + cap + " per bill" + had + ". Ask a manager.");
        }
    }

    // an exchange asks first what this is worth, and writes only once the whole swap adds up
    if (opts && opts.preview) return { preview: true, total, taxable, fullyReturned };

    const bal = addStock_(restocks.map((r) => ({ variant_id: r.variant_id, branch_id: branch, delta: r.qty })));
    restocks.forEach((r) =>
        moves.push({
            id: mId++, variant_id: r.variant_id, type: "return", qty: r.qty, unit_cost: r.unit_cost, balance: bal[r.variant_id + "|" + branch],
            ref_type: "return", ref_id: String(retId), note: s.invoice_no, user_id: ctx.user.id, at: now, branch_id: branch,
        }),
    );

    const fy = fyOf_(now);
    const code = branchCode_(branch);
    const cn = creditNoteNo_(setting_("invoice_prefix"), fy, nextCounter_(code ? "cn_seq_" + code + "_" + fy : "cn_seq_" + fy), code);

    appendRows_("Returns", [
        {
            id: retId, credit_note_no: cn, fy, sale_id: s.id, invoice_no: s.invoice_no, salesman_id: s.salesman_id,
            total, taxable, tax: r2_(total - taxable), refund_method: method, reason, user_id: ctx.user.id, at: now,
            branch_id: branch,
            gst_off: s.gst_hidden === GST_OFF_BRANCH_ ? 1 : 0, // follows its bill (no GST there, none here)
        },
    ]);
    appendRows_("Return_Items", retItems);
    // one refund row by default; an exchange passes the breakdown — part settled by the new bill,
    // the rest handed back
    let outId = nextId_("Payments");
    const outRows = (opts && opts.payOut && opts.payOut.length ? opts.payOut : [{ method: method, amount: total }])
        .filter((x) => r2_(num_(x.amount)) > 0)
        .map((x) => ({
            id: outId++, sale_id: s.id, return_id: retId, method: str_(x.method), amount: -r2_(num_(x.amount)),
            reference: str_(x.reference || cn).slice(0, 60), user_id: ctx.user.id, at: now,
        }));
    appendRows_("Payments", outRows);
    appendRows_("Stock_Movements", moves);
    writeColumn_("Sale_Items", touchedSI, "returned_qty");
    s.refunded = r2_(s.refunded + total);
    s.status = fullyReturned ? "returned" : "part_returned";
    s.updated_at = now;
    updateRows_("Sales", [s]);
    adjustCustomerTotals_(s.customer_id, -total, 0);
    if (restocks.length) bumpStockVersion_();
    log_(ctx, "RETURN", "Sales", s.id, cn + " for " + s.invoice_no + " ₹" + total + " — " + reason);
    return { message: "Return saved. Refund ₹" + total + " (" + cn + ")", data: saleDetail_(s, ctx) };
}

/* ---------- held bills ---------- */

function apiHoldBill_(p, ctx) {
    const cart = p.cart;
    if (!cart || !cart.lines || !cart.lines.length) fail_("Cart is empty");
    const branch = requireBranch_(ctx);
    return withLock_(() => {
        const id = nextId_("Held_Bills");
        appendRows_("Held_Bills", [
            {
                id, label: str_(p.label).slice(0, 60) || "Bill " + id, cart_json: cart,
                salesman_id: Number(cart.salesman_id || ctx.user.id), user_id: ctx.user.id, at: nowStr_(), branch_id: branch,
            },
        ]);
        return { message: "Bill held", data: { id } };
    });
}

function apiListHeld_(p, ctx) {
    let rows = rows_("Held_Bills").filter((h) => inBranch_(ctx, h.branch_id));
    if (ctx.user.role === "salesperson") rows = rows.filter((h) => h.user_id === ctx.user.id || h.salesman_id === ctx.user.id);
    const users = indexBy_(rows_("Users"), "id");
    return {
        data: rows
            .slice()
            .reverse()
            .map((h) => ({
                id: h.id, label: h.label, cart: h.cart_json, at: h.at, user_name: users[h.user_id] ? users[h.user_id].name : "",
                branch_id: bid_(h.branch_id), branch_name: branchName_(bid_(h.branch_id)),
            })),
    };
}

function apiDeleteHeld_(p, ctx) {
    return withLock_(() => {
        const h = findBy_("Held_Bills", "id", Number(p.id));
        if (!h) return { message: "Already removed" };
        if (ctx.user.role === "salesperson" && h.user_id !== ctx.user.id) fail_("Not your held bill");
        if (ctx.user.role !== "owner" && allowedBranchIds_(ctx.user).indexOf(bid_(h.branch_id)) < 0) fail_("This held bill belongs to another branch");
        deleteRow_("Held_Bills", h);
        return { message: "Held bill removed" };
    });
}

/* ---------- exchange: items back and a replacement, in one go ---------- */

/**
 * Two documents as always — a credit note and a bill — but only the difference crosses the counter,
 * and the bill's payment row names the credit note that paid for it.
 *
 * Both halves are worked out and checked first and written afterwards, so an exchange refused for any
 * reason (out of stock, short payment, a salesperson over their cash limit, a bill too old) leaves
 * neither document behind and skips no number in either series.
 *
 * p = {client_ref, sale_id, items:[{sale_item_id, qty, restock}], reason, override,
 *      lines, bill_disc, customer, salesman_id, notes, gst_hidden, payments, refund_method}
 */
function apiExchange_(p, ctx) {
    const clientRef = str_(p.client_ref);
    if (!clientRef || clientRef.length > 64) fail_("Missing exchange reference, please retry");
    const refundMethod = str_(p.refund_method || "cash").toLowerCase();
    if (PAYMENT_METHODS.indexOf(refundMethod) < 0) fail_("Choose how a difference is paid back");
    const reason = str_(p.reason);
    if (!reason) fail_("Please give a reason");
    const req = (p.items || []).filter((x) => num_(x.qty) > 0);
    if (!req.length) fail_("Select the items coming back");
    const lines = mergeLines_(p.lines);
    if (!lines.length) fail_("Choose the replacement");
    const branch = requireBranch_(ctx);

    return withLock_(() => {
        // idempotency: a retried or double-tapped exchange returns the one already saved
        const already = findBy_("Sales", "client_ref", clientRef);
        if (already) return { message: "Exchange already saved", data: exchangeOut_(already, ctx) };

        // 1. what is coming back is worth this much — and every return rule holds (branch, window, quantities)
        const back = returnItemsLocked_(p, ctx, EXCHANGE_METHOD_, reason, req, branch, { preview: true, forExchange: true });
        const credit = back.total;

        // 2. the replacement prices up, pays and fits in stock. What is coming back counts as available,
        //    so a leaked bottle can be swapped for the same perfume even when it was the last one.
        const coming = {};
        const origItems = windowRows_("Sale_Items", "sale_id", Number(p.sale_id), Number(p.sale_id));
        const origById = indexBy_(origItems, "id");
        req.forEach((x) => {
            const si = origById[Number(x.sale_item_id)];
            const keep = x.restock === false || x.restock === 0 ? 0 : 1;
            if (si && keep) coming[si.variant_id] = r3_((coming[si.variant_id] || 0) + num_(x.qty));
        });
        const plan = completeSaleLocked_(p, ctx, clientRef, lines, branch, {
            preview: true, extraStock: coming, credit: { amount: credit, reference: "" },
        });
        const consumed = r2_(Math.min(credit, plan.grand_total));
        const leftover = r2_(credit - consumed);

        // 3. a salesperson is limited on money leaving the drawer, not on the size of a swap
        if (leftover > 0 && ctx.user.role === "salesperson") {
            const cap = num_(setting_("salesperson_max_return"), 2000);
            if (!cap) fail_("Only a manager can hand money back. Ask a manager.");
            const paidBack = windowRows_("Payments", "sale_id", Number(p.sale_id), Number(p.sale_id))
                .filter((x) => x.amount < 0 && x.method !== EXCHANGE_METHOD_ && x.reference !== "VOID")
                .reduce((a, x) => r2_(a - x.amount), 0);
            if (r2_(paidBack + leftover) > cap + 0.001)
                fail_("A salesperson can hand back at most ₹" + cap + " on one bill" +
                    (paidBack > 0 ? " (₹" + paidBack + " already given back on it)" : "") + ". Ask a manager.");
        }

        // the two passes above marked rows in memory as they counted; start from what is really there
        rereadRows_();

        // 4. the credit note first, so what came back is on the shelf before it is sold again
        const payOut = [{ method: EXCHANGE_METHOD_, amount: consumed }];
        if (leftover > 0) payOut.push({ method: refundMethod, amount: leftover });
        const done = returnItemsLocked_(p, ctx, EXCHANGE_METHOD_, reason, req, branch, { forExchange: true, payOut });
        const rets = done.data.returns;
        const cn = rets[rets.length - 1].credit_note_no;

        // 5. then the replacement bill, its payment row naming that credit note
        const sale = completeSaleLocked_(p, ctx, clientRef, lines, branch, { credit: { amount: consumed, reference: cn } }).data;

        log_(ctx, "EXCHANGE", "Sales", sale.sale.id,
            cn + " → " + sale.sale.invoice_no + " · credit ₹" + credit +
                (leftover > 0 ? ", ₹" + leftover + " back by " + refundMethod : "") +
                (r2_(sale.sale.grand_total - consumed) > 0 ? ", ₹" + r2_(sale.sale.grand_total - consumed) + " collected" : ""));
        return {
            message: leftover > 0 ? "Exchange saved. ₹" + leftover + " back to the customer" : "Exchange saved (" + sale.sale.invoice_no + ")",
            data: Object.assign({}, sale, { exchange: { credit_note_no: cn, credit, refunded: leftover, from_sale_id: Number(p.sale_id), from_invoice_no: str_(done.data.sale.invoice_no) } }),
        };
    });
}

/** A saved exchange, rebuilt for a retried request: the bill, plus the credit note that paid for it. */
function exchangeOut_(sale, ctx) {
    const d = saleDetail_(sale, ctx);
    const row = d.payments.filter((x) => x.method === EXCHANGE_METHOD_ && x.amount > 0)[0];
    const cn = row ? str_(row.reference) : "";
    const ret = cn ? lastMatchingRows_("Returns", "credit_note_no", cn, 1)[0] : null;
    return Object.assign({}, d, {
        exchange: {
            credit_note_no: cn, credit: ret ? ret.total : row ? row.amount : 0,
            refunded: 0, from_sale_id: ret ? Number(ret.sale_id) : 0, from_invoice_no: ret ? str_(ret.invoice_no) : "",
        },
    });
}

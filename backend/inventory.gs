/**
 * Inventory per branch: stock in (batched, weighted-average cost), adjustments,
 * transfers between branches, movement history.
 */

// repeat lines for the same variant (repeat scans) → one line each
function mergeQtyLines_(lines, withCost) {
    const merged = {};
    const order = [];
    (lines || []).forEach((l) => {
        const id = Number(l.variant_id);
        const qty = num_(l.qty);
        if (!id || qty <= 0) fail_("Every line needs an item and a quantity above 0");
        if (!merged[id]) {
            merged[id] = { variant_id: id, qty: 0, cost_total: 0, cost_qty: 0 };
            order.push(id);
        }
        merged[id].qty = r3_(merged[id].qty + qty);
        const c = withCost ? num_(l.unit_cost) : 0;
        if (c > 0) {
            merged[id].cost_total += c * qty;
            merged[id].cost_qty += qty;
        }
    });
    if (!order.length) fail_("Scan or add at least one item");
    return order.map((id) => merged[id]);
}

/**
 * p = {supplier_note, bill_ref, lines:[{variant_id, qty, unit_cost}]} — received at the current branch.
 * Average cost is shared by all branches (weighted by total stock).
 */
function apiStockIn_(p, ctx) {
    const branch = requireBranch_(ctx);
    const lines = mergeQtyLines_(p.lines, true);

    return withLock_(() => {
        const vmap = indexBy_(rows_("Variants"), "id");
        const now = nowStr_();
        const batchId = nextId_("Stock_In_Batches");
        const costed = [];
        let totalQty = 0;
        let totalCost = 0;
        // every line is checked before anything is worked out or written
        lines.forEach((m) => {
            const v = vmap[m.variant_id];
            if (!v) fail_("Item not found (id " + m.variant_id + ")");
            // only a branch that sells the size takes it in (the product's name is read only to say so)
            assertSoldAt_(v, branch, () => {
                const prod = findBy_("Products", "id", v.product_id);
                return (prod ? prod.name + " " : "") + v.size_label;
            });
        });
        lines.forEach((m) => {
            const v = vmap[m.variant_id];
            const unitCost = m.cost_qty > 0 ? r2_(m.cost_total / m.cost_qty) : v.avg_cost;
            const oldQty = Math.max(0, v.stock_qty); // all branches
            if (m.cost_qty > 0) v.avg_cost = oldQty + m.qty > 0 ? r2_((oldQty * v.avg_cost + m.qty * unitCost) / (oldQty + m.qty)) : unitCost;
            totalQty += m.qty;
            totalCost += m.qty * unitCost;
            costed.push({ v, m, unitCost });
        });
        writeColumn_("Variants", costed.map((c) => c.v), "avg_cost");
        const bal = addStock_(lines.map((m) => ({ variant_id: m.variant_id, branch_id: branch, delta: m.qty })));

        let mid = nextId_("Stock_Movements");
        appendRows_(
            "Stock_Movements",
            costed.map((c) => ({
                id: mid++, variant_id: c.v.id, type: "stock_in", qty: c.m.qty, unit_cost: c.unitCost,
                balance: bal[c.v.id + "|" + branch], ref_type: "stock_in", ref_id: String(batchId),
                note: str_(p.supplier_note), user_id: ctx.user.id, at: now, branch_id: branch,
            })),
        );
        appendRows_("Stock_In_Batches", [
            {
                id: batchId, supplier_note: str_(p.supplier_note), bill_ref: str_(p.bill_ref), lines: lines.length,
                total_qty: r3_(totalQty), total_cost: r2_(totalCost), user_id: ctx.user.id, at: now, branch_id: branch,
            },
        ]);
        bumpCatalogVersion_(); // stock-in moves the average cost, which rides with the catalogue
        log_(ctx, "STOCK_IN", "Stock_In_Batches", batchId, branchName_(branch) + ": " + lines.length + " items, qty " + r3_(totalQty) + (p.supplier_note ? " — " + p.supplier_note : ""));
        return {
            message: "Stock added: " + r3_(totalQty) + " units in " + lines.length + " items",
            data: { batch_id: batchId, stock: lines.map((m) => ({ id: m.variant_id, stock_qty: bal[m.variant_id + "|" + branch] })) },
        };
    });
}

/**
 * p = {variant_id, mode: 'set'|'add'|'remove', qty, reason: 'count'|'damage'|'tester'|'other', note}
 * Adjusts stock at the current branch.
 */
function apiAdjustStock_(p, ctx) {
    const branch = requireBranch_(ctx);
    const mode = str_(p.mode);
    const qty = num_(p.qty);
    if (["set", "add", "remove"].indexOf(mode) < 0) fail_("Invalid adjustment");
    if (qty < 0 || (mode !== "set" && qty === 0)) fail_("Enter a valid quantity");
    const reason = ["count", "damage", "tester", "other"].indexOf(p.reason) >= 0 ? p.reason : "other";

    return withLock_(() => {
        const v = findBy_("Variants", "id", Number(p.variant_id));
        if (!v) fail_("Item not found");
        const now = stockOf_(v.id, branch);
        let delta;
        if (mode === "set") delta = r3_(qty - now);
        else if (mode === "add") delta = qty;
        else delta = -qty;
        if (delta === 0) fail_("Stock is already " + now);
        if (now + delta < 0 && setting_("allow_negative_stock") !== "yes") fail_("Stock cannot go below 0 (now " + now + ")");
        const bal = addStock_([{ variant_id: v.id, branch_id: branch, delta }])[v.id + "|" + branch];
        const type = reason === "damage" ? "damage" : reason === "tester" ? "tester" : "adjust";
        appendRows_("Stock_Movements", [
            {
                id: nextId_("Stock_Movements"), variant_id: v.id, type, qty: delta, unit_cost: v.avg_cost, balance: bal,
                ref_type: "adjust", ref_id: "", note: (reason === "count" ? "Stock count. " : "") + str_(p.note),
                user_id: ctx.user.id, at: nowStr_(), branch_id: branch,
            },
        ]);
        bumpStockVersion_();
        log_(ctx, "ADJUST", "Variants", v.id, branchName_(branch) + ": " + type + " " + (delta > 0 ? "+" : "") + delta + " → " + bal);
        return { message: "Stock updated to " + bal, data: { id: v.id, stock_qty: bal } };
    });
}

/* ---------- transfers between branches ---------- */

/**
 * p = {to_branch_id, lines:[{variant_id, qty}], note}
 * Moves stock from the branch you're working at to another branch, in one step.
 */
function apiTransferStock_(p, ctx) {
    const from = requireBranch_(ctx);
    const to = Number(p.to_branch_id);
    if (!to) fail_("Choose the branch to send stock to");
    if (to === from) fail_("Choose a different branch to send to");
    const lines = mergeQtyLines_(p.lines, false);

    return withLock_(() => {
        const toB = branchById_(to);
        if (!toB || !toB.active) fail_("That branch is not active");
        const vmap = indexBy_(rows_("Variants"), "id");
        const pmap = indexBy_(rows_("Products"), "id");
        lines.forEach((m) => {
            const v = vmap[m.variant_id];
            if (!v) fail_("Item not found (id " + m.variant_id + ")");
            const label = (pmap[v.product_id] ? pmap[v.product_id].name + " " : "") + v.size_label;
            if (v.unit === "pcs" && Math.floor(m.qty) !== m.qty) fail_("Quantity must be a whole number for " + label);
            const have = stockOf_(v.id, from);
            if (m.qty > have) fail_("Only " + have + (v.unit === "ml" ? " ml" : "") + " of " + label + " at " + branchName_(from));
            // sent only to a branch that sells it; out of one that doesn't, always (that is how leftovers go back)
            assertSoldAt_(v, to, label);
        });
        const bal = addStock_(
            lines.reduce(
                (a, m) => a.concat([
                    { variant_id: m.variant_id, branch_id: from, delta: -m.qty },
                    { variant_id: m.variant_id, branch_id: to, delta: m.qty },
                ]),
                [],
            ),
        );
        const now = nowStr_();
        const id = nextId_("Transfers");
        const no = "TR" + pad_(id, 5);
        let mid = nextId_("Stock_Movements");
        const moves = [];
        lines.forEach((m) => {
            const v = vmap[m.variant_id];
            moves.push(
                { id: mid++, variant_id: v.id, type: "transfer_out", qty: -m.qty, unit_cost: v.avg_cost, balance: bal[v.id + "|" + from],
                  ref_type: "transfer", ref_id: String(id), note: "To " + toB.name, user_id: ctx.user.id, at: now, branch_id: from },
                { id: mid++, variant_id: v.id, type: "transfer_in", qty: m.qty, unit_cost: v.avg_cost, balance: bal[v.id + "|" + to],
                  ref_type: "transfer", ref_id: String(id), note: "From " + branchName_(from), user_id: ctx.user.id, at: now, branch_id: to },
            );
        });
        const totalQty = r3_(lines.reduce((a, m) => a + m.qty, 0));
        appendRows_("Transfers", [
            { id, transfer_no: no, from_branch_id: from, to_branch_id: to, lines: lines.length, total_qty: totalQty, note: str_(p.note), user_id: ctx.user.id, at: now },
        ]);
        appendRows_("Stock_Movements", moves);
        bumpStockVersion_();
        log_(ctx, "TRANSFER", "Transfers", id, no + ": " + totalQty + " units " + branchName_(from) + " → " + toB.name);
        return {
            message: "Sent " + totalQty + (totalQty === 1 ? " unit" : " units") + " to " + toB.name + " (" + no + ")",
            data: { id, transfer_no: no, stock: lines.map((m) => ({ id: m.variant_id, stock_qty: bal[m.variant_id + "|" + from] })) },
        };
    });
}

function apiListTransfers_(p, ctx) {
    const users = indexBy_(rows_("Users"), "id");
    const list = tailRows_("Transfers", 1000)
        .filter((t) => !ctx.branch_id || t.from_branch_id === ctx.branch_id || t.to_branch_id === ctx.branch_id)
        .slice(-200);
    // what moved on each one: only the movements written since the oldest transfer shown, instead of
    // every stock movement the shop has ever recorded
    const out = {};
    (list.length ? windowRows_("Stock_Movements", "at", String(list[0].at).slice(0, 10), null) : []).forEach((m) => {
        if (m.ref_type !== "transfer" || m.type !== "transfer_out") return;
        (out[m.ref_id] = out[m.ref_id] || []).push({ variant_id: m.variant_id, qty: -m.qty });
    });
    return {
        data: list
            .reverse()
            .map((t) => ({
                id: t.id, transfer_no: t.transfer_no, from_branch_id: t.from_branch_id, to_branch_id: t.to_branch_id,
                from_name: branchName_(t.from_branch_id), to_name: branchName_(t.to_branch_id),
                lines: t.lines, total_qty: t.total_qty, note: t.note, at: t.at,
                user_name: users[t.user_id] ? users[t.user_id].name : "", items: out[String(t.id)] || [],
            })),
    };
}

/* ---------- history ---------- */

function apiMovements_(p, ctx) {
    const vid = Number(p.variant_id || 0);
    const users = indexBy_(rows_("Users"), "id");
    const lim = num_(p.limit, 300);
    let rows = vid ? lastMatchingRows_("Stock_Movements", "variant_id", vid, lim, 1500) : tailRows_("Stock_Movements", lim * 4);
    rows = rows.filter((m) => inBranch_(ctx, m.branch_id));
    if (p.from) rows = rows.filter((m) => m.at.slice(0, 10) >= p.from);
    if (p.to) rows = rows.filter((m) => m.at.slice(0, 10) <= p.to);
    if (p.type) rows = rows.filter((m) => m.type === p.type);
    const showCost = isStaffManager_(ctx);
    return {
        data: rows
            .slice(-lim)
            .reverse()
            .map((m) => ({
                id: m.id, variant_id: m.variant_id, type: m.type, qty: m.qty, balance: m.balance,
                unit_cost: showCost ? m.unit_cost : undefined, ref_type: m.ref_type, ref_id: m.ref_id,
                note: m.note, user_name: users[m.user_id] ? users[m.user_id].name : "", at: m.at,
                branch_id: bid_(m.branch_id), branch_name: branchName_(bid_(m.branch_id)),
            })),
    };
}

function apiStockInBatches_(p, ctx) {
    const users = indexBy_(rows_("Users"), "id");
    return {
        data: tailRows_("Stock_In_Batches", 1000)
            .filter((b) => inBranch_(ctx, b.branch_id))
            .slice(-200)
            .reverse()
            .map((b) =>
                Object.assign({}, b, {
                    _r: undefined, user_name: users[b.user_id] ? users[b.user_id].name : "", branch_name: branchName_(bid_(b.branch_id)),
                }),
            ),
    };
}

/**
 * Cash at the kiosk. UPI and card money goes straight to the bank; cash stays in the branch's drawer until
 * the owner comes by, counts it, takes some and leaves the rest as change. The Cash_Book tab keeps those
 * visits, and the cash expected in the drawer now is worked out from the latest one:
 *
 *   what was left in the drawer at the latest entry
 *   + cash taken in since (sales net of change; refunds, cash handed back on an exchange and voids are
 *     negative Payments rows)
 *   − cash expenses paid from the drawer, entered since, dated on or after the entry's day
 *
 * "Since" goes by row, not by time. Times are to the second, so a sale in the same second as a count could
 * fall on either side; Payments rows only ever grow (nothing deletes one), so every row after the entry's
 * `pay_id` came after it. An expense can be deleted — its row is emptied and its id may be handed out
 * again — so expenses go by when they were entered (`created_at`), with `exp_id` settling the same second.
 * An expense dated before the entry's day but typed in after it is left out: the count already found that
 * cash gone.
 *
 * Taking cash is not an expense. It moves the shop's money, it doesn't spend it, so Profit never sees it.
 */

const CASH_TYPES_ = ["count", "take", "add"];
const CASH_MAX_ = 10000000; // ₹1 crore: a typing slip, not a drawer
const CASH_OLD_BILLS_ = 15; // cash refunds on bills from before the count: looked up one by one, up to this many

/**
 * The cash expected in each of these branches' drawers now:
 * {branch_id: {started, now, since_at, left, cash_in, cash_out, expenses}} — `started` false until the
 * branch's drawer has been counted once. All branches are worked out from one read of each table.
 * withList: also `expense_list`, the cash expenses taken off since the count, for the owner to check.
 */
function cashNow_(branchIds, withList) {
    const out = {};
    branchIds.forEach((b) => (out[b] = { started: false }));
    const latest = {};
    rows_("Cash_Book").forEach((e) => {
        const b = bid_(e.branch_id);
        if (out[b] && (!latest[b] || e.id > latest[b].id)) latest[b] = e;
    });
    const tips = Object.keys(latest).map((b) => latest[b]);
    if (!tips.length) return out;

    // cash moved after the oldest of those entries, read from the end of the sheet: just the rows since the
    // owner's last visit
    const pays = rowsFromId_("Payments", Math.min.apply(null, tips.map((e) => e.pay_id)) + 1).filter((x) => x.method === "cash" && x.sale_id);
    // The bill behind each payment says whose drawer the cash went into. Bills made since the count are the
    // last rows of Sales, read from the end too. A cash refund on an older bill names a bill further back:
    // those are looked up one by one, so one refund doesn't stretch the read back to its bill.
    const wanted = {};
    let loNew = 0;
    pays.forEach((x) => {
        wanted[x.sale_id] = true;
        if (x.amount > 0) loNew = loNew ? Math.min(loNew, x.sale_id) : x.sale_id;
    });
    const ids = Object.keys(wanted).map(Number);
    const older = ids.filter((id) => !loNew || id < loNew);
    const saleBranch = {};
    const keep = (s) => s && (saleBranch[s.id] = bid_(s.branch_id));
    if (older.length > CASH_OLD_BILLS_) rowsFromId_("Sales", Math.min.apply(null, ids)).forEach(keep); // many: one read from the oldest
    else {
        if (loNew) rowsFromId_("Sales", loNew).forEach(keep);
        older.forEach((id) => keep(rowIfId_("Sales", id + 1, id) || findById_("Sales", id))); // row = id + 1 unless the sheet was changed by hand
    }
    const firstDay = tips.map((e) => d10_(e.at)).sort()[0];
    const exps = windowRows_("Expenses", "date", firstDay, null).filter(fromDrawer_); // not cash from the owner's pocket
    const users = withList ? indexBy_(rows_("Users"), "id") : null;

    tips.forEach((e) => {
        const b = bid_(e.branch_id);
        const day = d10_(e.at);
        let cashIn = 0;
        let cashOut = 0;
        let spent = 0;
        const list = [];
        pays.forEach((x) => {
            if (x.id <= e.pay_id || saleBranch[x.sale_id] !== b) return;
            if (x.amount >= 0) cashIn = r2_(cashIn + x.amount);
            else cashOut = r2_(cashOut - x.amount);
        });
        exps.forEach((x) => {
            if (bid_(x.branch_id) !== b || x.date < day) return;
            const at = String(x.created_at);
            if (at < e.at || (at === e.at && x.id <= e.exp_id)) return; // there before the entry: its cash was already gone
            spent = r2_(spent + x.amount);
            if (withList) list.push({ id: x.id, date: x.date, title: x.title, category: x.category, amount: x.amount, user_name: users[x.user_id] ? users[x.user_id].name : "", at });
        });
        out[b] = {
            started: true,
            now: r2_(e.balance + cashIn - cashOut - spent),
            since_at: e.at,
            left: e.balance,
            cash_in: cashIn,
            cash_out: cashOut,
            expenses: spent,
        };
        if (withList) out[b].expense_list = list.sort((p, q) => q.at.localeCompare(p.at));
    });
    return out;
}

/**
 * Home's "Cash in drawer" card. Asked for alongside Home's own figures (not inside them), so Home is never
 * held up by it. A salesperson gets the one number; "All branches" (the owner) a line per branch.
 */
function apiCashNow_(p, ctx) {
    if (ctx.branch_id) {
        const c = cashNow_([ctx.branch_id])[ctx.branch_id];
        if (!c.started) return { data: { started: false } };
        return { data: ctx.user.role === "salesperson" ? { started: true, now: c.now } : { started: true, now: c.now, since_at: c.since_at } };
    }
    const ids = activeBranches_().map((b) => b.id);
    const all = cashNow_(ids);
    return { data: { branches: ids.map((b) => ({ branch_id: b, name: branchName_(b), started: all[b].started, now: all[b].now || 0, since_at: all[b].since_at || "" })) } };
}

function cashEntryOut_(e, firstId, lastId) {
    const b = bid_(e.branch_id);
    return {
        id: e.id, at: e.at, branch_id: b, branch_name: branchName_(b), type: e.type,
        expected: e.expected, counted: e.counted, difference: e.difference, amount: e.amount, balance: e.balance,
        handed_by: e.handed_by, notes: e.notes, user_name: e.user_name,
        first: e.id === firstId[b], // the branch's first count: the app starts from it, nothing was expected
        latest: e.id === lastId[b], // the only one that can be undone
    };
}

/** What the Cash screen shows: each branch's drawer now, and the latest entries (newest first). */
function cashBookData_(ctx) {
    const ids = ctx.branch_id ? [ctx.branch_id] : activeBranches_().map((b) => b.id);
    const now = cashNow_(ids, true);
    const entries = rows_("Cash_Book").filter((e) => now[bid_(e.branch_id)]);
    const firstId = {};
    const lastId = {};
    entries.forEach((e) => {
        const b = bid_(e.branch_id);
        if (!firstId[b] || e.id < firstId[b]) firstId[b] = e.id;
        if (!lastId[b] || e.id > lastId[b]) lastId[b] = e.id;
    });
    return {
        branches: ids.map((b) => Object.assign({ branch_id: b, branch_name: branchName_(b) }, now[b])),
        entries: entries
            .slice()
            .sort((a, b) => b.id - a.id)
            .slice(0, 40)
            .map((e) => cashEntryOut_(e, firstId, lastId)),
        can_edit: ctx.user.role === "owner",
    };
}

function apiCashBook_(p, ctx) {
    return { data: cashBookData_(ctx) };
}

// "₹50 short" / "₹20 extra" / "" — for messages and the log
function cashDiffText_(d) {
    return d < 0 ? inrText_(-d) + " short" : d > 0 ? inrText_(d) + " extra" : "";
}

/**
 * The owner at the drawer. p = {type, counted, amount, handed_by, notes}
 *  count — counted only: the drawer starts again from what is really there
 *  take  — counted, and the cash taken away: what is left stays as change
 *  add   — cash put in (change brought along); no count
 * A count against what was expected is kept as short or extra. The very first entry of a branch has nothing
 * to be set against: what is counted is where the app starts.
 */
function apiCashEntry_(p, ctx) {
    const branch = requireBranch_(ctx);
    const type = str_(p.type);
    if (CASH_TYPES_.indexOf(type) < 0) fail_("Choose what you are doing: count, take or put in cash");
    const blank = (v) => v === "" || v === null || v === undefined;
    const money = (v, what) => {
        const n = r2_(num_(v, 0));
        if (n < 0) fail_(what + " cannot be negative");
        if (n >= CASH_MAX_) fail_("Check the " + what.toLowerCase() + ": " + inrText_(n) + " is more than a drawer holds");
        return n;
    };
    if (type !== "add" && blank(p.counted)) fail_("Count the cash in the drawer and enter it");
    const counted = type === "add" ? 0 : money(p.counted, "Counted cash");
    const amount = type === "count" ? 0 : money(p.amount, type === "take" ? "Cash taken" : "Cash put in");
    if (type === "take" && !(amount > 0)) fail_("Enter the cash you are taking");
    if (type === "take" && amount > counted + 0.001) fail_("You can't take more than the " + inrText_(counted) + " in the drawer");
    if (type === "add" && !(amount > 0)) fail_("Enter the cash you are putting in");
    const handedBy = str_(p.handed_by);
    if (handedBy.length > 60) fail_("Keep the name to 60 letters");
    const notes = str_(p.notes);
    if (notes.length > 200) fail_("Keep the note to 200 letters");

    return withLock_(() => {
        // inside the lock: no sale, refund or expense can land between working out what is expected and
        // marking where the next count starts from
        const was = cashNow_([branch])[branch];
        if (!was.started && type === "add") fail_("Count the drawer first, so the app knows what is in it");
        const expected = was.started ? was.now : counted;
        const e = {
            id: nextId_("Cash_Book"),
            at: nowStr_(),
            branch_id: branch,
            type,
            expected,
            counted,
            difference: type === "add" ? 0 : r2_(counted - expected),
            amount,
            balance: type === "add" ? r2_(expected + amount) : r2_(counted - amount),
            handed_by: handedBy,
            notes,
            pay_id: nextId_("Payments") - 1,
            exp_id: nextId_("Expenses") - 1,
            user_id: ctx.user.id,
            user_name: ctx.user.name,
        };
        appendRows_("Cash_Book", [e]);
        const diff = cashDiffText_(e.difference);
        const what =
            type === "take" ? inrText_(amount) + " taken, " + inrText_(e.balance) + " left in the drawer"
                : type === "add" ? inrText_(amount) + " put in, " + inrText_(e.balance) + " in the drawer"
                    : "Counted " + inrText_(counted);
        log_(ctx, "CASH", "Cash_Book", e.id, branchName_(branch) + ": " + what + (diff ? " (" + diff + ")" : "") + (handedBy ? ", handed over by " + handedBy : ""));
        const message =
            type === "take" ? inrText_(amount) + " taken. " + inrText_(e.balance) + " stays at the kiosk"
                : type === "add" ? inrText_(amount) + " put in. " + inrText_(e.balance) + " in the drawer"
                    : was.started ? "Counted " + inrText_(counted) : "Counted. The app starts from " + inrText_(counted);
        return { message: message + (diff ? " (" + diff + ")" : ""), data: cashBookData_(ctx) };
    });
}

/**
 * Undo a slip: only a branch's latest entry, since each one starts from the one before. `at` must match
 * as well — once an entry is undone its id can be handed to the next one, and an old request must not
 * take that one away instead.
 */
function apiUndoCash_(p, ctx) {
    return withLock_(() => {
        const e = rows_("Cash_Book").filter((x) => x.id === Number(p.id) && (!p.at || x.at === String(p.at)))[0];
        if (!e) fail_("This entry is already gone");
        const b = bid_(e.branch_id);
        if (rows_("Cash_Book").some((x) => bid_(x.branch_id) === b && x.id > e.id)) fail_("Only the latest entry can be undone");
        deleteRow_("Cash_Book", e);
        log_(ctx, "CASH", "Cash_Book", e.id, branchName_(b) + ": undone — " + e.type + " of " + e.at + (e.amount ? ", " + inrText_(e.amount) : "") + ", left " + inrText_(e.balance));
        return { message: "Undone", data: cashBookData_(ctx) };
    });
}

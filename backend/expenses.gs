/**
 * Shop expenses (rent, salary, tea, packaging…).
 * A salesperson may add cash they paid from the drawer today, at the branch they work at, and sees only
 * those; anything else — another day, UPI or card, changing or deleting one — stays with a manager or the
 * owner. Without this, tea bought from the drawer showed up as cash missing at the owner's count.
 */

function apiListExpenses_(p, ctx) {
    const seller = ctx.user.role === "salesperson";
    const from = seller ? todayStr_() : str_(p.from) || todayStr_().slice(0, 8) + "01";
    const to = seller ? todayStr_() : str_(p.to) || todayStr_();
    const users = indexBy_(rows_("Users"), "id");
    let rows = rows_("Expenses").filter((e) => e.date >= from && e.date <= to && inBranch_(ctx, e.branch_id) && (!seller || e.user_id === ctx.user.id));
    if (p.category) rows = rows.filter((e) => e.category === p.category);
    const list = rows
        .slice()
        .sort((a, b) => (b.date + pad_(b.id, 8)).localeCompare(a.date + pad_(a.id, 8)))
        .map((e) => ({
            id: e.id, date: e.date, category: e.category, title: e.title, amount: e.amount, method: e.method,
            notes: e.notes, user_name: users[e.user_id] ? users[e.user_id].name : "", branch_name: branchName_(bid_(e.branch_id)),
            from_drawer: fromDrawer_(e),
        }));
    return { data: { expenses: list, total: r2_(list.reduce((a, e) => a + e.amount, 0)) } };
}

function apiSaveExpense_(p, ctx) {
    const title = str_(p.title);
    const amount = r2_(num_(p.amount));
    const date = str_(p.date) || todayStr_();
    if (!title) fail_("What was the expense for?");
    if (amount <= 0) fail_("Enter the amount");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail_("Invalid date");
    if (date > todayStr_()) fail_("Date cannot be in the future");
    const method = PAYMENT_METHODS.indexOf(p.method) >= 0 ? p.method : "cash";
    if (ctx.user.role === "salesperson") {
        if (p.id) fail_("Only a manager can change an expense. Ask a manager.");
        if (method !== "cash") fail_("You can add cash paid from the drawer only. Ask a manager to add a UPI or card expense.");
        if (date !== todayStr_()) fail_("You can add today's expenses only. Ask a manager to add an older one.");
    }
    if (!p.id) requireBranch_(ctx); // new expenses belong to the branch you are working at
    // Cash paid from the owner's pocket, not the drawer: the owner or a manager unticks "Paid from the kiosk
    // drawer". A salesperson's is always the drawer's. Nothing sent (an app from before the tick): a new
    // expense is the drawer's, as every cash expense used to be, and an edited one keeps what it was.
    const notDrawer = (was) =>
        method !== "cash" || ctx.user.role === "salesperson" ? 0 : p.from_drawer === false ? 1 : p.from_drawer === true ? 0 : was;
    return withLock_(() => {
        if (p.id) {
            const e = findBy_("Expenses", "id", Number(p.id));
            if (!e) fail_("Expense not found");
            assertExpenseBranch_(ctx, e);
            Object.assign(e, { date, category: str_(p.category) || "Other", title, amount, method, notes: str_(p.notes), not_drawer: notDrawer(e.not_drawer ? 1 : 0) });
            updateRows_("Expenses", [e]);
            log_(ctx, "UPDATE", "Expenses", e.id, title + " ₹" + amount);
            return { message: "Expense saved" };
        }
        const id = nextId_("Expenses");
        appendRows_("Expenses", [
            { id, date, category: str_(p.category) || "Other", title, amount, method, notes: str_(p.notes), user_id: ctx.user.id, created_at: nowStr_(), branch_id: ctx.branch_id, not_drawer: notDrawer(0) },
        ]);
        log_(ctx, "CREATE", "Expenses", id, title + " ₹" + amount);
        return { message: "Expense added", data: { id } };
    });
}

function apiDeleteExpense_(p, ctx) {
    return withLock_(() => {
        const e = findBy_("Expenses", "id", Number(p.id));
        if (!e) fail_("Expense not found");
        assertExpenseBranch_(ctx, e);
        deleteRow_("Expenses", e);
        log_(ctx, "DELETE", "Expenses", e.id, e.title + " ₹" + e.amount);
        return { message: "Expense deleted" };
    });
}

// cash that came out of the kiosk drawer: what the drawer (cash.gs) and the day close take off
function fromDrawer_(e) {
    return e.method === "cash" && !e.not_drawer;
}

function assertExpenseBranch_(ctx, e) {
    if (ctx.user.role !== "owner" && allowedBranchIds_(ctx.user).indexOf(bid_(e.branch_id)) < 0) fail_("This expense belongs to another branch");
}

/**
 * Branches: shops sharing one product list and price list. Stock, bills (own invoice series),
 * expenses and reports are per branch. Staff may work at any branch in their "works at" list;
 * the owner can also use branch 0 = "All branches" for reading and reports.
 */

// rows written before branches existed belong to branch 1
function bid_(v) {
    return Number(v) || 1;
}

function activeBranches_() {
    return rows_("Branches").filter((b) => b.active);
}

function branchById_(id) {
    return findBy_("Branches", "id", Number(id));
}

function branchName_(id) {
    const b = branchById_(id);
    return b ? b.name : "";
}

function branchOut_(b) {
    return { id: b.id, name: b.name, code: b.code, address: b.address, phone: b.phone, active: b.active, gst_off: b.gst_off ? 1 : 0 };
}

// a branch that isn't GST-registered: its bills are recorded with no GST (and left out of GST reports)
function branchGstOff_(id) {
    const b = branchById_(id);
    return !!(b && b.gst_off);
}

// sale.gst_hidden: 0 = GST shown, 1 = "Show GST on bill" unticked, 2 = billed at a branch without GST
const GST_OFF_BRANCH_ = 2;

function parseIdList_(s) {
    return String(s || "")
        .split(",")
        .map((x) => Number(x))
        .filter(Boolean);
}

// active branches this user may work at (the owner: all)
function allowedBranchIds_(user) {
    const active = activeBranches_().map((b) => b.id);
    if (user.role === "owner") return active;
    const list = parseIdList_(user.branch_ids);
    return list.length ? active.filter((id) => list.indexOf(id) >= 0) : active;
}

function homeBranch_(user) {
    const allowed = allowedBranchIds_(user);
    const h = Number(user.branch_id);
    return allowed.indexOf(h) >= 0 ? h : allowed[0] || 0;
}

/**
 * Branch for this request. Never trusts the phone blindly: staff can only use branches they
 * work at. With a single active branch everyone simply works there (same as a one-shop setup).
 */
function resolveBranch_(user, requested) {
    const active = activeBranches_();
    if (!active.length) fail_("No active branch. Run Setup from the Groovy POS menu.", "BRANCH");
    if (active.length === 1) {
        if (user.role !== "owner" && allowedBranchIds_(user).indexOf(active[0].id) < 0) fail_("You are not assigned to any active branch", "BRANCH");
        return active[0].id;
    }
    const r = Number(requested) || 0;
    if (user.role !== "owner" && !allowedBranchIds_(user).length) fail_("You are not assigned to any active branch. Ask the owner.", "BRANCH");
    if (!r) return user.role === "owner" ? 0 : homeBranch_(user);
    if (allowedBranchIds_(user).indexOf(r) < 0) fail_("You don't work at this branch. Choose another branch.", "BRANCH");
    return r;
}

// actions that change stock or money must happen at one real branch
function requireBranch_(ctx) {
    if (!ctx.branch_id) fail_("Choose a branch first (tap the branch name at the top).", "BRANCH");
    return ctx.branch_id;
}

// report scope: 0 = all branches (owner only)
function inBranch_(ctx, v) {
    return !ctx.branch_id || bid_(v) === ctx.branch_id;
}

/* ---------- stock per branch ---------- */

function stockIndex_() {
    if (!REQ_CACHE_.__stockIdx) {
        const m = {};
        rows_("Branch_Stock").forEach((r) => (m[r.variant_id + "|" + r.branch_id] = r));
        REQ_CACHE_.__stockIdx = m;
    }
    return REQ_CACHE_.__stockIdx;
}

function stockOf_(vid, branchId) {
    const r = stockIndex_()[vid + "|" + branchId];
    return r ? r.qty : 0;
}

// {variant_id: qty} for one branch, or totals for all branches (branchId 0)
function stockMap_(branchId) {
    const m = {};
    rows_("Branch_Stock").forEach((r) => {
        if (branchId && r.branch_id !== branchId) return;
        m[r.variant_id] = r3_((m[r.variant_id] || 0) + r.qty);
    });
    return m;
}

// {variant_id: {branch_id: qty}}
function stockByBranch_() {
    const m = {};
    rows_("Branch_Stock").forEach((r) => {
        (m[r.variant_id] = m[r.variant_id] || {})[r.branch_id] = r.qty;
    });
    return m;
}

/**
 * Apply stock changes [{variant_id, branch_id, delta}] (call inside withLock_).
 * Returns {"vid|bid": newQty}. Also keeps Variants.stock_qty = total across branches.
 */
function addStock_(changes) {
    const idx = stockIndex_();
    const touched = [];
    const fresh = [];
    const result = {};
    changes.forEach((c) => {
        if (!c.delta) return;
        const k = c.variant_id + "|" + c.branch_id;
        let r = idx[k];
        if (!r) {
            r = { variant_id: c.variant_id, branch_id: c.branch_id, qty: 0 };
            idx[k] = r;
            fresh.push(r);
        }
        r.qty = r3_(r.qty + c.delta);
        if (r._r && touched.indexOf(r) < 0) touched.push(r);
        result[k] = r.qty;
    });
    // totals per variant from the (updated) index
    const vids = {};
    changes.forEach((c) => (vids[c.variant_id] = 0));
    Object.keys(idx).forEach((k) => {
        const r = idx[k];
        if (vids[r.variant_id] !== undefined) vids[r.variant_id] = r3_(vids[r.variant_id] + r.qty);
    });
    writeColumn_("Branch_Stock", touched, "qty");
    if (fresh.length) {
        appendRows_("Branch_Stock", fresh);
        delete REQ_CACHE_.__stockIdx; // appended rows now carry sheet row numbers
    }
    const vmap = indexBy_(rows_("Variants"), "id");
    const now = nowStr_();
    const vs = Object.keys(vids)
        .map((id) => vmap[id])
        .filter(Boolean)
        .map((v) => {
            v.stock_qty = vids[v.id];
            v.updated_at = now;
            return v;
        });
    writeColumn_("Variants", vs, "stock_qty");
    writeColumn_("Variants", vs, "updated_at");
    return result;
}

/* ---------- invoice series per branch ---------- */

function branchCode_(branchId) {
    const b = branchById_(branchId);
    return b ? str_(b.code) : "";
}

/* ---------- branch management (owner) ---------- */

function apiListBranches_(p, ctx) {
    // one column instead of every bill ever written, 30 columns wide
    const sold = {};
    columnValues_("Sales", "branch_id").forEach((v) => (sold[bid_(v)] = true));
    return {
        data: rows_("Branches").map((b) =>
            Object.assign(branchOut_(b), { report_emails: b.report_emails, has_sales: !!sold[b.id] }),
        ),
    };
}

function apiSaveBranch_(p, ctx) {
    const name = str_(p.name);
    const code = str_(p.code).toUpperCase();
    if (!name) fail_("Branch name is required");
    if (!/^[A-Z0-9]{0,3}$/.test(code)) fail_("Code must be up to 3 letters/digits (used in bill numbers)");
    const prefix = str_(setting_("invoice_prefix")) || "GF";
    if (prefix.length + code.length > 4) fail_("Invoice prefix + branch code must be at most 4 characters, e.g. GF + KN (GST bill numbers are limited to 16)");
    const emails = splitEmails_(p.report_emails);
    const bad = emails.filter((e) => !EMAIL_RE_.test(e));
    if (bad.length) fail_("Not a valid email: " + bad.join(", "));

    return withLock_(() => {
        const all = rows_("Branches");
        if (all.some((b) => b.name.toLowerCase() === name.toLowerCase() && b.id !== Number(p.id || 0))) fail_("A branch with this name exists");
        if (all.some((b) => str_(b.code) === code && b.id !== Number(p.id || 0)))
            fail_(code ? "Code " + code + " is used by another branch" : "Only one branch can have a blank code. Give this branch a code, e.g. KN.");
        const now = nowStr_();
        if (p.id) {
            const b = findBy_("Branches", "id", Number(p.id));
            if (!b) fail_("Branch not found");
            if (str_(b.code) !== code && columnValues_("Sales", "branch_id").some((v) => bid_(v) === b.id))
                fail_("This branch already has bills — its code (bill number series) can't change");
            const active = p.active === undefined ? b.active : p.active ? 1 : 0;
            if (!active && all.filter((x) => x.active && x.id !== b.id).length === 0) fail_("At least one branch must stay active");
            const gstOff = p.gst_off === undefined ? (b.gst_off ? 1 : 0) : p.gst_off ? 1 : 0; // an older app doesn't send it: kept
            Object.assign(b, { name, code, address: str_(p.address), phone: str_(p.phone), report_emails: emails.join(", "), active, gst_off: gstOff });
            updateRows_("Branches", [b]);
            log_(ctx, "UPDATE", "Branches", b.id, name);
            return { message: "Branch saved", data: branchOut_(b) };
        }
        const b = { id: nextId_("Branches"), name, code, address: str_(p.address), phone: str_(p.phone), report_emails: emails.join(", "), active: 1, created_at: now, gst_off: p.gst_off ? 1 : 0 };
        appendRows_("Branches", [b]);
        log_(ctx, "CREATE", "Branches", b.id, name + (code ? " (" + code + ")" : ""));
        return { message: "Branch added", data: branchOut_(b) };
    });
}

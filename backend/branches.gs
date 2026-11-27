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
    return { id: b.id, name: b.name, code: b.code, address: b.address, phone: b.phone, active: b.active, gst_off: b.gst_off ? 1 : 0, review_link: b.review_link || "", upi_id: b.upi_id || "" };
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
    if (!active.length) fail_("No active branch. Run Setup from the Groovy Kiosk menu.", "BRANCH");
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

/* ---------- which branches sell a size ("Sold at") — mirrored by soldAt in the app's lib/catalog.js ---------- */

// Does this branch sell the size? Blank = every branch. "All branches" (0) is every shop, so yes. With
// one branch open the shop is one shop again and sells everything (the form shows no ticks then, so a
// size left to a closed branch could not be put back) — asked only of a size not listed for the branch.
function soldAt_(v, branchId) {
    const list = parseIdList_(v && v.sold_at);
    if (!list.length || !num_(branchId) || list.indexOf(Number(branchId)) >= 0) return true;
    return activeBranches_().length <= 1;
}

// Bringing stock into a branch that doesn't sell the size (Stock In, a transfer to it, opening stock)
// is refused: the owner or a manager ticks the branch in the product first. `label` is the size's name,
// or a function giving it — only worked out when refusing, so a request that passes reads nothing more.
function assertSoldAt_(v, branchId, label) {
    if (soldAt_(v, branchId)) return;
    const name = branchName_(branchId);
    fail_((typeof label === "function" ? label() : label) + " is not sold at " + name + ". Tick " + name + " for it in the product first.");
}

/**
 * The "Sold at" ticks for one size → what is stored. `ids`: branch ids, as a list or "1,2".
 * Every open branch ticked is stored blank — "every branch" — so a branch opened later sells it too.
 * Closed branches are left out (the form shows only open ones). At least one must be ticked: a size
 * sold nowhere is a hidden one, and hiding is what the eye icon is for.
 */
function cleanSoldAt_(ids, label) {
    const list = parseIdList_(ids);
    list.forEach((id) => {
        if (!branchById_(id)) fail_("Unknown branch (id " + id + ") in Sold at for " + label);
    });
    const open = activeBranches_().map((b) => b.id);
    const ticked = open.filter((id) => list.indexOf(id) >= 0);
    if (!ticked.length) fail_("Tick at least one branch that sells " + label + ". To stop selling it everywhere, hide it instead.");
    return ticked.length === open.length ? "" : ticked.join(",");
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
    const link = str_(p.review_link);
    if (link && (!/^https:\/\/\S+$/.test(link) || link.length > 300)) fail_("The Google review link must be a web address starting with https://");
    // null: not sent (an older app) — the saved UPI ID is kept
    const upi = p.upi_id === undefined || p.upi_id === null ? null : cleanUpiId_(p.upi_id);
    let upiChange = null; // the owners are told after the save is done, so an email can never hold it up

    const res = withLock_(() => {
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
            const reviewLink = p.review_link === undefined ? str_(b.review_link) : link; // likewise
            const wasUpi = str_(b.upi_id);
            const upiId = upi === null ? wasUpi : upi; // likewise
            Object.assign(b, { name, code, address: str_(p.address), phone: str_(p.phone), report_emails: emails.join(", "), active, gst_off: gstOff, review_link: reviewLink, upi_id: upiId });
            updateRows_("Branches", [b]);
            if (upiId !== wasUpi) upiChange = { branch: name, from: wasUpi, to: upiId };
            log_(ctx, "UPDATE", "Branches", b.id, name + (upiChange ? " · UPI ID: " + (wasUpi || "none") + " → " + (upiId || "none") : ""));
            return { message: "Branch saved", data: branchOut_(b) };
        }
        const b = { id: nextId_("Branches"), name, code, address: str_(p.address), phone: str_(p.phone), report_emails: emails.join(", "), active: 1, created_at: now, gst_off: p.gst_off ? 1 : 0, review_link: link, upi_id: upi || "" };
        appendRows_("Branches", [b]);
        if (b.upi_id) upiChange = { branch: name, from: "", to: b.upi_id };
        log_(ctx, "CREATE", "Branches", b.id, name + (code ? " (" + code + ")" : "") + (b.upi_id ? " · UPI ID: " + b.upi_id : ""));
        return { message: "Branch added", data: branchOut_(b) };
    });
    if (upiChange) alertUpiChange_(upiChange, ctx);
    return res;
}

/* ---------- the branch's UPI ID (the QR at checkout) ---------- */

// "groovy@okaxis": letters, digits and . _ - before the @, the bank's handle after it
const UPI_ID_RE_ = /^[a-z0-9._-]{2,256}@[a-z][a-z0-9.]{1,63}$/;

/**
 * A UPI ID as typed, or pasted as the text of the kiosk's own QR ("upi://pay?pa=groovy@okaxis&pn=…"), whose
 * pa= is taken. Lower-cased; blank = none. Mirrored by upiIdFrom in the app's lib/upi.js.
 */
function cleanUpiId_(v) {
    let s = str_(v);
    if (/^upi:/i.test(s)) {
        const m = /[?&]pa=([^&]+)/i.exec(s);
        if (!m) fail_("That QR text has no UPI ID in it (pa=…)");
        try {
            s = decodeURIComponent(m[1]);
        } catch (e) {
            s = m[1];
        }
    }
    s = s.trim().toLowerCase();
    if (s && !UPI_ID_RE_.test(s)) fail_("Not a valid UPI ID — it looks like name@bank, e.g. groovy@okaxis");
    return s;
}

/**
 * The UPI ID decides whose account the checkout QR pays into, so every Owner account is told of any change:
 * old → new, who, when — and so is the Google account that owns this script and its Sheet. An owner's login
 * email can be changed inside the app, so someone who got into the owner's login could point it at their own
 * address first; the Google account can't be changed from here. Never allowed to get in the way of the save
 * (already done when this runs).
 */
function alertUpiChange_(c, ctx) {
    try {
        const to = rows_("Users")
            .filter((u) => u.active && roleName_(u.role) === "owner" && u.email)
            .map((u) => String(u.email).toLowerCase());
        let google = "";
        try {
            google = String(Session.getEffectiveUser().getEmail() || "").toLowerCase();
        } catch (e) {
            /* not known here: the owners still get it */
        }
        if (google && to.indexOf(google) < 0) to.push(google);
        if (!to.length) return;
        const biz = setting_("business_name") || "Groovy Fragrances";
        const lines = [
            "The UPI ID that the checkout QR pays into at " + c.branch + " was " + (c.from ? "changed" : "set") + " by " + ctx.user.name + " (" + ctx.user.email + ") at " + nowStr_().slice(0, 16) + ".",
            "Before: " + (c.from || "none") + "\nNow: " + (c.to || "none — the QR button is off at this branch"),
            "If this was you: nothing to do. To check it, open Settings → Branches → " + c.branch + " → Test QR · ₹1 and pay ₹1 from your own phone.",
            "If it was not you: put the right UPI ID back in Settings → Branches now, and change your password.",
        ];
        sendMail_(
            to,
            {
                subject: biz + " Kiosk — UPI ID " + (c.from ? "changed" : "set") + " for " + c.branch,
                text: lines.join("\n\n") + "\n\n— " + biz,
                html:
                    '<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;background:#FAF7F2">' +
                    '<div style="background:#fff;border-radius:12px;padding:28px;border-top:5px solid #F5BF03">' +
                    '<h2 style="margin:0 0 8px;color:#654321;font-family:Georgia,serif">' + escHtml_(biz) + "</h2>" +
                    lines.map((l) => '<p style="color:#403B37">' + escHtml_(l).replace(/\n/g, "<br>") + "</p>").join("") +
                    "</div></div>",
            },
            {},
        );
    } catch (e) {
        console.error("alertUpiChange_", e);
    }
}

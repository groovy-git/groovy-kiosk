/**
 * Google reviews taken at the kiosk. Staff ask a customer — buying or not — to review the branch on Google,
 * and may give a sample perfume for it. Each review counts towards the salesperson who took it (their
 * incentive is kept out of the app; only the count is shown, beside items and new customers).
 *
 * Google gives no simple way to see that a review was posted, so the app keeps what staff report, and two
 * things keep the counts honest: a customer counts once per branch (Google takes one review per person
 * anyway), and the owner can mark a review "doesn't count" — it stays listed but leaves every count.
 */

function reviewOut_(r, ctx) {
    return {
        id: r.id, at: r.at, branch_id: bid_(r.branch_id), branch_name: branchName_(bid_(r.branch_id)),
        salesman_id: r.salesman_id, salesman_name: r.salesman_name, customer_id: r.customer_id,
        customer_name: r.customer_name, customer_phone: phoneFor_(r.customer_phone, ctx),
        google_name: r.google_name, sample: r.sample ? 1 : 0, sale_id: r.sale_id || 0, counted: r.counted ? 1 : 0,
    };
}

// a counted review of this customer at this branch, by the customer or by the number (a number corrected
// since still finds them), other than `exceptId`
function countedReviewOf_(customerId, phone, branch, exceptId) {
    return rows_("Reviews").filter((r) => r.counted && r.id !== exceptId && bid_(r.branch_id) === branch &&
        ((customerId && r.customer_id === customerId) || r.customer_phone === phone))[0] || null;
}

/**
 * p = {phone, google_name, sample, salesman_id, sale_id, from_sale_id}
 * `phone` may be masked when it came from a bill this person only sees masked: it is then that bill's
 * customer (unmaskCustomer_, customers.gs).
 */
function apiAddReview_(p, ctx) {
    const branch = requireBranch_(ctx);
    const cust = unmaskCustomer_({ phone: str_(p.phone), from_sale_id: p.from_sale_id }, ctx, p.sale_id);
    const phone = normPhone_(cust.phone);
    if (!validPhone_(phone)) fail_("Enter the customer's 10-digit mobile number");
    const googleName = str_(p.google_name);
    if (googleName.length > 60) fail_("Keep the name on Google to 60 letters");
    const sellerId = Number(p.salesman_id || ctx.user.id);
    if (ctx.user.role === "salesperson" && sellerId !== ctx.user.id) fail_("A salesperson can only record a review under their own name");
    const seller = findBy_("Users", "id", sellerId);
    if (!seller || !seller.active) fail_("Choose who took the review");
    if (roleName_(seller.role) === MOVER_) fail_(seller.name + " is a stock mover. Choose who took the review.");
    if (allowedBranchIds_(seller).indexOf(branch) < 0) fail_(seller.name + " does not work at " + branchName_(branch));
    const saleId = Number(p.sale_id) || 0;
    if (saleId) {
        const s = findById_("Sales", saleId);
        if (!s || !canSeeSale_(ctx, s)) fail_("Bill not found");
        if (bid_(s.branch_id) !== branch) fail_("This bill was made at " + branchName_(bid_(s.branch_id)) + ". Record the review there.");
    }
    return withLock_(() => {
        const c = findBy_("Customers", "phone", phone);
        // once per customer at a branch: two phones saving the same customer at once still make one
        const dup = countedReviewOf_(c ? c.id : 0, phone, branch, 0);
        if (dup) fail_("This customer has already given a review here, on " + dateNice_(d10_(dup.at)) + " (taken by " + dup.salesman_name + ")");
        const now = nowStr_();
        // a new reviewer becomes a customer with no bills (not a "new customer": that count is of first bills)
        const who = c || { id: nextId_("Customers"), name: googleName, phone, gstin: "", total_spent: 0, bills: 0, last_visit: "", created_at: now };
        if (!c) appendRows_("Customers", [who]);
        const r = {
            id: nextId_("Reviews"), at: now, branch_id: branch, salesman_id: seller.id, salesman_name: seller.name,
            customer_id: who.id, customer_name: who.name, customer_phone: phone, google_name: googleName,
            sample: p.sample ? 1 : 0, sale_id: saleId, counted: 1, checked_by: 0, checked_at: "", created_by: ctx.user.id,
        };
        appendRows_("Reviews", [r]);
        log_(ctx, "REVIEW", "Reviews", r.id, branchName_(branch) + ": taken by " + seller.name + (r.sample ? ", sample given" : ""));
        return { message: r.sample ? "Review recorded, sample given" : "Review recorded", data: reviewOut_(r, ctx) };
    });
}

/** The owner's say on one review: it counts, or it doesn't (not found on Google, recorded by mistake). */
function apiSetReviewCounted_(p, ctx) {
    const counted = p.counted ? 1 : 0;
    return withLock_(() => {
        const r = findById_("Reviews", p.id);
        if (!r) fail_("Review not found");
        if (counted && !r.counted) {
            const other = countedReviewOf_(r.customer_id, r.customer_phone, bid_(r.branch_id), r.id);
            if (other) fail_("Another review from this customer already counts at " + branchName_(bid_(r.branch_id)) + " (" + dateNice_(d10_(other.at)) + ")");
        }
        r.counted = counted;
        r.checked_by = ctx.user.id;
        r.checked_at = nowStr_();
        updateRows_("Reviews", [r]);
        log_(ctx, "REVIEW", "Reviews", r.id, counted ? "counts again" : "marked doesn't count");
        return { message: counted ? "Counts again" : "Marked doesn't count", data: reviewOut_(r, ctx) };
    });
}

// the counted reviews behind the salesperson counts: at the working branch, and a salesperson's own only
function reviewsIn_(ctx, from, to) {
    const own = ctx.user.role === "salesperson" ? ctx.user.id : 0;
    return windowRows_("Reviews", "at", from, to).filter((r) => r.counted && (!own || r.salesman_id === own) && inBranch_(ctx, r.branch_id));
}

// "yyyy-MM-dd" moved by n days
function addDays_(ymd, n) {
    const d = new Date(ymd + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

/**
 * Reports → Google reviews (owner and manager): every review in the range, counted or not, newest first;
 * and counted totals per branch for each whole week (Monday to Sunday) the range touches — whole weeks,
 * so they can be set beside the new reviews Google shows for those weeks.
 */
function reportReviews_(p, ctx) {
    const { from, to } = rangeOf_(p);
    const monday = (ymd) => addDays_(ymd, -((new Date(ymd + "T00:00:00Z").getUTCDay() + 6) % 7));
    const wkFrom = monday(from);
    const wkTo = addDays_(monday(to), 6);
    const all = windowRows_("Reviews", "at", wkFrom, wkTo).filter((r) => inBranch_(ctx, r.branch_id));
    const rows = all.filter((r) => inRange_(r.at, from, to));
    const weeks = {};
    all.forEach((r) => {
        if (!r.counted) return;
        const week = monday(d10_(r.at));
        const k = week + "|" + bid_(r.branch_id);
        weeks[k] = weeks[k] || { week, to: addDays_(week, 6), branch_id: bid_(r.branch_id), branch_name: branchName_(bid_(r.branch_id)), reviews: 0, samples: 0 };
        weeks[k].reviews++;
        if (r.sample) weeks[k].samples++;
    });
    return {
        from, to,
        rows: rows.slice().reverse().map((r) => reviewOut_(r, ctx)),
        weeks: Object.keys(weeks).map((k) => weeks[k]).sort((a, b) => (a.week === b.week ? a.branch_name.localeCompare(b.branch_name) : b.week.localeCompare(a.week))),
        totals: { reviews: rows.filter((r) => r.counted).length, samples: rows.filter((r) => r.counted && r.sample).length, not_counted: rows.filter((r) => !r.counted).length },
    };
}

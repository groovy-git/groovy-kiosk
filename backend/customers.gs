/** Customers — identified by 10-digit Indian mobile number. */

function normPhone_(p) {
    let d = String(p || "").replace(/\D/g, "");
    if (d.length === 12 && d.indexOf("91") === 0) d = d.slice(2);
    if (d.length === 11 && d.charAt(0) === "0") d = d.slice(1);
    return d;
}

function validPhone_(d) {
    return /^[6-9]\d{9}$/.test(d);
}

function validGstin_(g) {
    return /^[0-9]{2}[A-Z0-9]{13}$/.test(g);
}

/**
 * A customer's number is the owner's to see. Managers and salespeople get it masked, 77XX9XX667, in every
 * reply: the Customers screen and bills alike. No ctx means the server's own use (an invoice PDF), which
 * keeps the full number.
 */
function maskPhone_(d) {
    d = String(d || "");
    return d.length === 10 ? d.slice(0, 2) + "XX" + d.charAt(4) + "XX" + d.slice(7) : d.replace(/\d(?=\d{3})/g, "X");
}

function phoneFor_(phone, ctx) {
    return !phone || !ctx || ctx.user.role === "owner" ? phone : maskPhone_(phone);
}

// what a search matches on a number: the owner, any part of it; anyone else, only the whole number, so
// the hidden digits don't come out of trying parts of it. Returns a test for one stored number.
function phoneMatcher_(q, ctx) {
    if (!ctx || ctx.user.role === "owner") return (phone) => String(phone || "").indexOf(q) >= 0;
    const d = normPhone_(q);
    return d.length === 10 ? (phone) => phone === d : () => false;
}

// a held bill is someone's bill in progress: the owner, and whoever held it, see the number typed into
// it; anyone else gets it masked, in its label too (a bill held without a name is labelled with it)
function heldOut_(h, ctx) {
    const cart = h.cart_json;
    const cust = (cart && cart.customer) || {};
    if (ctx.user.role === "owner" || h.user_id === ctx.user.id || !cust.phone) return { label: h.label, cart };
    const phone = String(cust.phone).indexOf("X") >= 0 ? cust.phone : maskPhone_(normPhone_(cust.phone)); // held masked already: as it is
    return {
        label: String(h.label || "").replace(/\d{10}/g, maskPhone_),
        cart: Object.assign({}, cart, { customer: Object.assign({}, cust, { phone }) }),
    };
}

/**
 * A masked number sent back by a manager or salesperson stands for a customer the server already
 * knows, and the real number is taken from there:
 *  - the bill it came from (an exchange, or a bill that started as one): that bill's customer, at the
 *    number the owner keeps for them now (a number corrected since then is not brought back);
 *  - else the held bill being completed: the number typed into it.
 * The caller must be able to see that bill, and the mask must be the one it shows. Anything else masked
 * is refused, so a mask can never be made to stand for someone else.
 */
function unmaskCustomer_(cust, ctx, saleId, heldId) {
    const masked = str_(cust && cust.phone);
    if (masked.indexOf("X") < 0) return cust;
    const refuse = () => fail_("Enter the customer's mobile number again, or leave it empty");
    const fromSale = Number(cust.from_sale_id || saleId) || 0;
    if (fromSale) {
        const s = findById_("Sales", fromSale);
        if (!s || !canSeeSale_(ctx, s) || !s.customer_phone || maskPhone_(s.customer_phone) !== masked) refuse();
        const c = s.customer_id ? findBy_("Customers", "id", s.customer_id) : null;
        return Object.assign({}, cust, { phone: c ? c.phone : s.customer_phone });
    }
    // the held bills this caller is shown (apiListHeld_): at this branch, and a salesperson's own
    const h = Number(heldId) ? findBy_("Held_Bills", "id", Number(heldId)) : null;
    const seen = h && inBranch_(ctx, h.branch_id) && (ctx.user.role !== "salesperson" || h.user_id === ctx.user.id || h.salesman_id === ctx.user.id);
    const typed = seen ? (h.cart_json && h.cart_json.customer) || {} : {};
    if (str_(typed.phone).indexOf("X") >= 0) return unmaskCustomer_(Object.assign({}, cust, { from_sale_id: typed.from_sale_id }), ctx, 0, 0);
    const real = normPhone_(typed.phone);
    if (!real || maskPhone_(real) !== masked) refuse();
    return Object.assign({}, cust, { phone: real });
}

function customerOut_(c, ctx) {
    return {
        id: c.id, name: c.name, phone: phoneFor_(c.phone, ctx), gstin: c.gstin, total_spent: c.total_spent,
        bills: c.bills, last_visit: c.last_visit, created_at: c.created_at,
    };
}

function apiFindCustomer_(p, ctx) {
    const phone = normPhone_(p.phone);
    if (!validPhone_(phone)) return { data: null };
    const c = findBy_("Customers", "phone", phone);
    return { data: c ? customerOut_(c, ctx) : null };
}

function apiListCustomers_(p, ctx) {
    const q = str_(p.q).toLowerCase();
    let rows = q ? rows_("Customers") : tailRows_("Customers", 2000);
    const hit = phoneMatcher_(q, ctx);
    if (q) rows = rows.filter((c) => c.name.toLowerCase().indexOf(q) >= 0 || hit(c.phone));
    rows = rows.slice().sort((a, b) => (b.last_visit || "").localeCompare(a.last_visit || ""));
    return { data: rows.slice(0, num_(p.limit, 300)).map((c) => customerOut_(c, ctx)) };
}

function apiSaveCustomer_(p, ctx) {
    const phone = normPhone_(p.phone);
    if (!validPhone_(phone)) fail_("Enter a valid 10-digit mobile number");
    const gstin = str_(p.gstin).toUpperCase();
    if (gstin && !validGstin_(gstin)) fail_("GSTIN must be 15 characters");
    return withLock_(() => {
        const dup = findBy_("Customers", "phone", phone);
        if (p.id) {
            const c = findBy_("Customers", "id", Number(p.id));
            if (!c) fail_("Customer not found");
            if (dup && dup.id !== c.id) fail_("Another customer has this number");
            c.name = str_(p.name);
            c.phone = phone;
            c.gstin = gstin;
            updateRows_("Customers", [c]);
            log_(ctx, "UPDATE", "Customers", c.id, c.name + " " + phone);
            return { message: "Customer saved", data: customerOut_(c, ctx) };
        }
        if (dup) fail_("Customer with this number already exists");
        const c = {
            id: nextId_("Customers"), name: str_(p.name), phone, gstin, total_spent: 0, bills: 0,
            last_visit: "", created_at: nowStr_(),
        };
        appendRows_("Customers", [c]);
        log_(ctx, "CREATE", "Customers", c.id, c.name + " " + phone);
        return { message: "Customer added", data: customerOut_(c, ctx) };
    });
}

function apiCustomerHistory_(p, ctx) {
    const c = findById_("Customers", p.id);
    if (!c) fail_("Customer not found");
    let sales = windowRows_("Sales", "customer_id", c.id, c.id).filter((s) => s.customer_id === c.id);
    if (ctx.user.role === "salesperson") sales = sales.filter((s) => s.salesman_id === ctx.user.id);
    return {
        data: {
            customer: customerOut_(c, ctx),
            sales: sales
                .slice()
                .reverse()
                .map((s) => ({
                    id: s.id, invoice_no: s.invoice_no, date: s.date, grand_total: s.grand_total,
                    refunded: s.refunded, status: s.status, items: s.items, salesman_name: s.salesman_name,
                })),
        },
    };
}

// inside lock: create/update customer from a sale; returns the record or null (walk-in)
function upsertSaleCustomer_(cust, amount, now) {
    const phone = normPhone_(cust && cust.phone);
    if (!phone) return null;
    if (!validPhone_(phone)) fail_("Customer mobile number is not valid");
    const gstin = str_(cust.gstin).toUpperCase();
    if (gstin && !validGstin_(gstin)) fail_("Customer GSTIN must be 15 characters");
    let c = findBy_("Customers", "phone", phone);
    if (c) {
        if (str_(cust.name)) c.name = str_(cust.name);
        if (gstin) c.gstin = gstin;
        c.total_spent = r2_(c.total_spent + amount);
        c.bills += 1;
        c.last_visit = now;
        updateRows_("Customers", [c]);
        return c;
    }
    c = {
        id: nextId_("Customers"), name: str_(cust.name), phone, gstin, total_spent: r2_(amount), bills: 1,
        last_visit: now, created_at: now,
    };
    appendRows_("Customers", [c]);
    return c;
}

function adjustCustomerTotals_(customerId, amountDelta, billsDelta) {
    if (!customerId) return;
    const c = findBy_("Customers", "id", customerId);
    if (!c) return;
    c.total_spent = r2_(Math.max(0, c.total_spent + amountDelta));
    c.bills = Math.max(0, c.bills + billsDelta);
    updateRows_("Customers", [c]);
}

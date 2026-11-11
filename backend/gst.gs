/**
 * Pure pricing / GST helpers (no sheet access) — unit tested in tests.gs.
 * Prices are GST-inclusive. Intra-state sale → tax split equally into CGST + SGST.
 */

/**
 * @param lines [{price, qty, discount, gst_rate}]  discount = rupees off the whole line
 * @param billDisc rupees off the whole bill, spread across lines by value
 * @param roundToRupee boolean
 */
function computeBill_(lines, billDisc, roundToRupee) {
    const out = lines.map((l) => {
        const gross = r2_(num_(l.price) * num_(l.qty));
        const disc = r2_(num_(l.discount));
        if (disc < 0) fail_("Discount cannot be negative");
        if (disc > gross) fail_("Discount is more than the item price");
        return Object.assign({}, l, { gross, discount: disc, after: r2_(gross - disc) });
    });
    const sumAfter = r2_(out.reduce((s, l) => s + l.after, 0));
    const bd = r2_(num_(billDisc));
    if (bd < 0) fail_("Discount cannot be negative");
    if (bd > sumAfter) fail_("Bill discount is more than the bill total");

    // proportional bill discount; last line with value takes the rounding remainder
    let left = bd;
    let lastIdx = -1;
    out.forEach((l, i) => {
        if (l.after > 0) lastIdx = i;
    });
    out.forEach((l, i) => {
        let share = 0;
        if (bd > 0 && sumAfter > 0) share = i === lastIdx ? left : r2_((bd * l.after) / sumAfter);
        share = Math.min(share, l.after);
        left = r2_(left - share);
        l.bill_disc_share = r2_(share);
        l.line_total = r2_(l.after - share);
        const rate = num_(l.gst_rate);
        l.taxable = r2_((l.line_total * 100) / (100 + rate));
        l.tax = r2_(l.line_total - l.taxable);
        l.cgst = r2_(l.tax / 2);
        l.sgst = r2_(l.tax - l.cgst);
        delete l.after;
    });

    const sum = (f) => r2_(out.reduce((s, l) => s + l[f], 0));
    const net = sum("line_total");
    const grand = roundToRupee ? Math.round(net) : net;
    return {
        lines: out,
        gross: sum("gross"),
        item_disc: sum("discount"),
        bill_disc: bd,
        taxable: sum("taxable"),
        cgst: sum("cgst"),
        sgst: sum("sgst"),
        net,
        round_off: r2_(grand - net),
        grand_total: r2_(grand),
    };
}

/**
 * Offers the owner sets up (Settings → Billing → Offers), kept as JSON in the `offers` setting:
 *   {id, name, type: "pct", pct, active}        e.g. 10% off the bill
 *   {id, name, type: "buy", buy, pay, active}   e.g. buy 3, pay for 2
 * Unreadable JSON reads as no offers, so a damaged setting never stops billing.
 */
function offersOf_(raw) {
    try {
        const v = JSON.parse(raw || "[]");
        return Array.isArray(v) ? v : [];
    } catch (e) {
        return [];
    }
}

/**
 * What an offer takes off a bill, in rupees. The app works it out the same way (offerDiscount in
 * frontend/src/lib/cart.js) to fill the bill discount; the server works it out again to check it.
 * @param lines [{price, qty, discount, unit}]  discount = rupees off the whole line
 *  - % off: that share of the bill after item discounts.
 *  - Buy X, pay for Y: only pieces count (loose attar, sold by ml, doesn't). For every X pieces the
 *    cheapest X − Y go free, each at its price after its own line's discount: 6 pieces on "buy 3, pay
 *    for 2" free the 2 cheapest.
 */
function offerDiscount_(offer, lines) {
    if (!offer) return 0;
    if (offer.type === "pct") {
        const base = r2_(lines.reduce((s, l) => {
            const gross = r2_(num_(l.price) * num_(l.qty));
            return s + gross - Math.min(r2_(num_(l.discount)), gross);
        }, 0));
        return r2_((base * Math.min(Math.max(num_(offer.pct), 0), 100)) / 100);
    }
    if (offer.type === "buy") {
        const buy = Math.floor(num_(offer.buy));
        const pay = Math.floor(num_(offer.pay));
        if (!(pay >= 1 && buy > pay)) return 0;
        const units = [];
        lines.forEach((l) => {
            const n = Math.floor(num_(l.qty));
            if (l.unit !== "pcs" || n <= 0) return;
            const gross = r2_(num_(l.price) * n);
            const each = r2_((gross - Math.min(r2_(num_(l.discount)), gross)) / n);
            for (let i = 0; i < n; i++) units.push(each);
        });
        const free = Math.floor(units.length / buy) * (buy - pay);
        units.sort((a, b) => a - b);
        return r2_(units.slice(0, free).reduce((s, x) => s + x, 0));
    }
    return 0;
}

// Indian financial year label for a "yyyy-MM-dd..." string → "26-27"
function fyOf_(dateStr) {
    const y = parseInt(String(dateStr).slice(0, 4), 10);
    const m = parseInt(String(dateStr).slice(5, 7), 10);
    const start = m >= 4 ? y : y - 1;
    return pad_(start % 100, 2) + "-" + pad_((start + 1) % 100, 2);
}

// Branch code gives each branch its own series (GST allows several series, max 16 chars):
// GF/26-27/00001 (branch without code) · GFKN/26-27/00001 (branch KN)
function invoiceNo_(prefix, fy, seq, code) {
    return (prefix || "GF") + (code || "") + "/" + fy + "/" + pad_(seq, 5);
}

// GF/CN/26-27/0001 · GFKNC/26-27/0001
function creditNoteNo_(prefix, fy, seq, code) {
    return code ? (prefix || "GF") + code + "C/" + fy + "/" + pad_(seq, 4) : (prefix || "GF") + "/CN/" + fy + "/" + pad_(seq, 4);
}

// merge repeated variant lines (repeat scans) → one line per variant
function mergeLines_(lines) {
    const map = {};
    const order = [];
    (lines || []).forEach((l) => {
        const id = Number(l.variant_id);
        if (!id) fail_("Invalid item in cart");
        if (!map[id]) {
            map[id] = { variant_id: id, qty: 0, discount: 0 };
            order.push(id);
        }
        map[id].qty = r3_(map[id].qty + num_(l.qty));
        map[id].discount = r2_(map[id].discount + num_(l.discount));
    });
    return order.map((id) => map[id]);
}

function tolaToMl_(tola, tolaMl) {
    return r3_(num_(tola) * num_(tolaMl, 12));
}

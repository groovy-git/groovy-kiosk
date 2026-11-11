import { r2, r3 } from "./format";

// Cart line: {variant_id, qty, discount}. Repeat adds merge into the same line.
export function addLine(lines, variantId, qty = 1) {
  const i = lines.findIndex((l) => l.variant_id === variantId);
  if (i >= 0) {
    const next = lines.slice();
    next[i] = { ...next[i], qty: r3(next[i].qty + qty) };
    return next;
  }
  return [...lines, { variant_id: variantId, qty: r3(qty), discount: 0 }];
}

export function setLine(lines, variantId, patch) {
  return lines.map((l) => (l.variant_id === variantId ? { ...l, ...patch } : l));
}

export function removeLine(lines, variantId) {
  return lines.filter((l) => l.variant_id !== variantId);
}

export function qtyInCart(lines, variantId) {
  const l = lines.find((x) => x.variant_id === variantId);
  return l ? l.qty : 0;
}

/**
 * Same maths as the server's computeBill_ (GST-inclusive, bill discount spread by value,
 * round to rupee). Used for live preview only — the server re-prices on save.
 */
export function computeBill(lines, billDisc, roundToRupee = true) {
  const out = lines.map((l) => {
    const gross = r2(l.price * l.qty);
    const discount = Math.min(r2(l.discount || 0), gross);
    return { ...l, gross, discount, after: r2(gross - discount) };
  });
  const sumAfter = r2(out.reduce((s, l) => s + l.after, 0));
  const bd = Math.min(r2(billDisc || 0), sumAfter);
  let left = bd;
  let lastIdx = -1;
  out.forEach((l, i) => l.after > 0 && (lastIdx = i));
  out.forEach((l, i) => {
    let share = 0;
    if (bd > 0 && sumAfter > 0) share = i === lastIdx ? left : r2((bd * l.after) / sumAfter);
    share = Math.min(share, l.after);
    left = r2(left - share);
    l.line_total = r2(l.after - share);
    l.taxable = r2((l.line_total * 100) / (100 + (l.gst_rate || 0)));
    l.tax = r2(l.line_total - l.taxable);
  });
  const sum = (f) => r2(out.reduce((s, l) => s + l[f], 0));
  const net = sum("line_total");
  const grand = roundToRupee ? Math.round(net) : net;
  const tax = sum("tax");
  return {
    lines: out,
    gross: sum("gross"),
    item_disc: sum("discount"),
    bill_disc: bd,
    taxable: sum("taxable"),
    tax,
    net,
    round_off: r2(grand - net),
    grand_total: r2(grand),
  };
}

/** The owner's offers (the `offers` setting, JSON). Unreadable reads as none, as on the server. */
export function offersOf(settings) {
  try {
    const v = JSON.parse((settings && settings.offers) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * What an offer takes off, in rupees — same maths as the server's offerDiscount_ (backend/gst.gs), which
 * checks it again on save. lines: [{price, qty, discount, unit}], discount = rupees off the whole line.
 *  - % off: that share of the bill after item discounts.
 *  - Buy X, pay for Y: only pieces count (not loose attar by ml); for every X pieces the cheapest X − Y
 *    go free, each at its price after its own line's discount.
 */
export function offerDiscount(offer, lines) {
  if (!offer) return 0;
  if (offer.type === "pct") {
    const base = r2(
      lines.reduce((s, l) => {
        const gross = r2(Number(l.price) * Number(l.qty));
        return s + gross - Math.min(r2(Number(l.discount) || 0), gross);
      }, 0),
    );
    return r2((base * Math.min(Math.max(Number(offer.pct) || 0, 0), 100)) / 100);
  }
  if (offer.type === "buy") {
    const buy = Math.floor(Number(offer.buy) || 0);
    const pay = Math.floor(Number(offer.pay) || 0);
    if (!(pay >= 1 && buy > pay)) return 0;
    const units = [];
    lines.forEach((l) => {
      const n = Math.floor(Number(l.qty) || 0);
      if (l.unit !== "pcs" || n <= 0) return;
      const gross = r2(Number(l.price) * n);
      const each = r2((gross - Math.min(r2(Number(l.discount) || 0), gross)) / n);
      for (let i = 0; i < n; i++) units.push(each);
    });
    const free = Math.floor(units.length / buy) * (buy - pay);
    units.sort((a, b) => a - b);
    return r2(units.slice(0, free).reduce((s, x) => s + x, 0));
  }
  return 0;
}

/**
 * The most a salesperson may take off a bill with an offer: the bigger of their limit and the offer
 * counted at full prices, as the server checks it. Their limit is rounded down to the paisa, so an
 * amount filled in from it is never a hair over and refused.
 */
export function offerAllowance(offer, lines, capPct) {
  const gross = r2(lines.reduce((s, l) => s + r2(Number(l.price) * Number(l.qty)), 0));
  const atFull = offer ? offerDiscount(offer, lines.map((l) => ({ ...l, discount: 0 }))) : 0;
  return Math.max(Math.floor(gross * capPct + 1e-6) / 100, atFull);
}

/** The bill discount an offer fills in: what it is worth, and for a salesperson never past what they may give. */
export function offerFill(offer, lines, salesperson, capPct) {
  const full = offerDiscount(offer, lines);
  if (!salesperson) return full;
  const itemDisc = r2(lines.reduce((s, l) => s + Math.min(r2(Number(l.discount) || 0), r2(Number(l.price) * Number(l.qty))), 0));
  return Math.max(0, Math.min(full, r2(offerAllowance(offer, lines, capPct) - itemDisc)));
}

export function newClientRef() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

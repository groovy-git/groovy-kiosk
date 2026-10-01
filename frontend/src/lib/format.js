const inrFmt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 2 });

export const r2 = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
export const r3 = (x) => Math.round((Number(x) + Number.EPSILON) * 1000) / 1000;

// ₹1,23,456 (paise only when present)
export function inr(n, { paise = false } = {}) {
  const v = Number(n) || 0;
  const s = paise || Math.round(v) !== v ? inr2.format(Math.abs(v)) : inrFmt.format(Math.abs(v));
  return (v < 0 ? "−₹" : "₹") + s;
}

export function qtyLabel(q, unit) {
  const n = Number(q) || 0;
  return unit === "ml" ? `${inrFmt.format(n)} ml` : `${inrFmt.format(n)}`;
}

const TZ = "Asia/Kolkata";

// "yyyy-MM-dd" in IST, offset by days
export function istDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function monthStart() {
  return istDate().slice(0, 8) + "01";
}

// month names written out, so every device reads the same (browsers differ: "Sep" vs "Sept")
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// day / month / year of an IST timestamp
function istParts(d) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t) => Number(p.find((x) => x.type === t).value);
  return { day: get("day"), month: get("month"), year: get("year") };
}

// server timestamps are IST "yyyy-MM-dd HH:mm:ss"
function parseIst(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(" ", "T") + "+05:30");
  return isNaN(d) ? null : d;
}

export function fmtDateTime(s) {
  const d = parseIst(s);
  if (!d) return "";
  const { day, month } = istParts(d);
  const time = d.toLocaleTimeString("en-IN", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
  return `${day} ${MONTHS[month - 1]}, ${time}`;
}

export function fmtDate(s) {
  const d = parseIst(String(s).length === 10 ? s + " 00:00:00" : s);
  if (!d) return "";
  const { day, month, year } = istParts(d);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

// like fmtDateTime but with the year — an invoice must carry it
export function fmtDateTimeFull(s) {
  const d = parseIst(s);
  if (!d) return "";
  const { day, month, year } = istParts(d);
  const time = d.toLocaleTimeString("en-IN", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
  return `${day} ${MONTHS[month - 1]} ${year}, ${time}`;
}

export function fmtTime(s) {
  const d = parseIst(s);
  return d ? d.toLocaleTimeString("en-IN", { timeZone: TZ, hour: "numeric", minute: "2-digit" }) : "";
}

export function relDay(s) {
  const day = String(s).slice(0, 10);
  if (day === istDate()) return "Today";
  if (day === istDate(-1)) return "Yesterday";
  return fmtDate(day);
}

export function initials(name) {
  return (name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

// plural("bill", 1) → "1 bill", plural("bill", 3) → "3 bills"
export const plural = (word, n) => `${n} ${word}${Number(n) === 1 ? "" : "s"}`;

export const titleCase = (s) => String(s || "").replace(/\b\w/g, (c) => c.toUpperCase());

export const METHOD_LABEL = { cash: "Cash", upi: "UPI", card: "Card", exchange: "Exchange" };
// both keys: a phone that logged in before the rename still has "salesman" saved against the user
// old keys kept as well: a phone that logged in before a rename still has the old word cached
export const ROLE_LABEL = { owner: "Owner", admin: "Owner", manager: "Manager", salesperson: "Salesperson", salesman: "Salesperson", stock_mover: "Stock Mover" };

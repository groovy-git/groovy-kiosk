// UPI payment link (NPCI's UPI linking spec), shown as a QR on the kiosk phone at checkout: the customer's
// UPI app opens it with the payee and the amount filled in. Plain functions, no imports: a Node check loads
// this file as it is.

// "groovy@okaxis": letters, digits and . _ - before the @, the bank's handle after it.
// The same rule as cleanUpiId_ in backend/branches.gs.
export const UPI_ID_RE = /^[a-z0-9._-]{2,256}@[a-z][a-z0-9.]{1,63}$/;

// A UPI ID as typed, or the text of a UPI QR ("upi://pay?pa=…&pn=…") whose pa= is taken: {id, ok}.
// The id is trimmed and lower-cased; "" is none (ok). The server reads it the same way.
export function upiIdFrom(text) {
  let s = String(text || "").trim();
  if (/^upi:/i.test(s)) {
    const m = /[?&]pa=([^&]+)/i.exec(s);
    if (!m) return { id: "", ok: false };
    try {
      s = decodeURIComponent(m[1]);
    } catch {
      s = m[1];
    }
  }
  s = s.trim().toLowerCase();
  return { id: s, ok: !s || UPI_ID_RE.test(s) };
}

// upi://pay?pa=…&pn=…&am=…&cu=INR&tn=…
// The UPI ID goes as it is: it is checked above, and some apps can't read an encoded "@". The name and
// note are encoded with %20 for a space, which every app reads (a "+" some show as it is).
export function upiLink(id, name, amount, note) {
  const enc = (s) => encodeURIComponent(String(s || "").trim().slice(0, 50));
  const parts = [`pa=${id}`, `pn=${enc(name)}`];
  const am = Number(amount);
  if (am > 0) parts.push(`am=${am.toFixed(2)}`);
  parts.push("cu=INR");
  if (note) parts.push(`tn=${enc(note)}`);
  return "upi://pay?" + parts.join("&");
}

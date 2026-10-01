import { inr, fmtDateTime, fmtDateTimeFull, qtyLabel, METHOD_LABEL, r2 } from "./format";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function gstByRate(items) {
  const m = {};
  items.forEach((i) => {
    const r = (m[i.gst_rate] = m[i.gst_rate] || { rate: i.gst_rate, taxable: 0, tax: 0 });
    r.taxable = r2(r.taxable + i.taxable);
    r.tax = r2(r.tax + i.tax);
  });
  return Object.values(m).sort((a, b) => a.rate - b.rate);
}

function savings(d) {
  const mrpTotal = d.items.reduce((s, i) => s + (i.mrp || i.price) * i.qty, 0);
  return Math.max(0, r2(mrpTotal - d.sale.grand_total));
}

function payLines(d) {
  return d.payments.filter((p) => p.amount > 0 && !p.return_id);
}

// loose attar shows just the name; the ml quantity says the rest
// shop details for this bill: branch name, and the branch's own address/phone when set
function shopFor(d, s) {
  const b = d.branch;
  return {
    ...s,
    address: (b && b.address) || s.address,
    phone: (b && b.phone) || s.phone,
    branch_name: s.multi_branch && b ? b.name : "",
  };
}

const itemName = (i) => `${i.product_name}${i.size && i.unit !== "ml" ? " " + i.size : ""}`;

/* ---------- 80mm thermal receipt ---------- */
// a bill printed without GST names no GSTIN either — not the shop's (nor its State), not the customer's
const shopForBill = (s, showGst) => (showGst ? s : { ...s, gstin: "" });

export function receiptHtml(d, s) {
  const sale = d.sale;
  const showGst = !sale.gst_hidden; // GST breakup can be left off the customer's bill
  s = shopForBill(shopFor(d, s), showGst);
  const rates = gstByRate(d.items);
  const saved = savings(d);
  const rows = d.items
    .map(
      (i) => `
    <div class="it"><div class="nm">${esc(itemName(i))}</div>
      <div class="ln"><span>${qtyLabel(i.qty, i.unit)} × ${inr(i.price, { paise: i.unit === "ml" })}${i.discount ? ` <small>(-${inr(i.discount)})</small>` : ""}</span><b>${inr(r2(i.price * i.qty))}</b></div>
      ${showGst && i.hsn ? `<div class="hsn">HSN ${esc(i.hsn)} · GST ${i.gst_rate}%</div>` : ""}</div>`,
    )
    .join("");
  const pays = payLines(d)
    .map((p) => `<div class="kv"><span>${METHOD_LABEL[p.method] || p.method}${p.reference ? " (" + esc(p.reference) + ")" : ""}</span><span>${inr(p.amount)}</span></div>`)
    .join("");
  const returns = (d.returns || [])
    .map((r) => `<div class="kv"><span>Credit note ${esc(r.credit_note_no)}</span><span>-${inr(r.total)}</span></div>`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(sale.invoice_no)}</title><style>
    @page { size: 80mm auto; margin: 3mm; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: "Courier New", monospace; font-size: 12px; color: #000; width: 74mm; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .c { text-align: center; } .b { font-weight: 700; }
    h1 { font-family: Georgia, serif; font-size: 18px; letter-spacing: 1px; }
    .tag { font-style: italic; font-size: 11px; margin-bottom: 3px; }
    .sm { font-size: 10.5px; }
    hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
    .kv { display: flex; justify-content: space-between; gap: 6px; }
    .it { margin: 4px 0; } .nm { font-weight: 700; } .ln { display: flex; justify-content: space-between; }
    .hsn { font-size: 10px; color: #333; }
    .tot { font-size: 15px; font-weight: 700; border-top: 1px solid #000; border-bottom: 1px solid #000; padding: 3px 0; margin: 4px 0; }
    table { width: 100%; border-collapse: collapse; font-size: 10.5px; } td, th { text-align: right; padding: 1px 0; } td:first-child, th:first-child { text-align: left; }
    .save { border: 1px dashed #000; padding: 4px; margin: 6px 0; text-align: center; font-weight: 700; }
  </style></head><body>
    <div class="c"><h1>${esc(s.business_name || "Groovy Fragrances")}</h1>
      ${s.branch_name ? `<div class="b">${esc(s.branch_name)}</div>` : ""}
      ${s.tagline ? `<div class="tag">${esc(s.tagline)}</div>` : ""}
      <div class="sm">${esc(s.address || "")}</div>
      ${s.phone ? `<div class="sm">Ph: ${esc(s.phone)}</div>` : ""}
      ${s.gstin ? `<div class="sm b">GSTIN: ${esc(s.gstin)}</div>` : ""}
    </div><hr>
    <div class="c b">${showGst && s.gstin ? "TAX INVOICE" : "BILL"}</div>
    <div class="kv"><span>No: ${esc(sale.invoice_no)}</span></div>
    <div class="kv"><span>${esc(fmtDateTime(sale.date))}</span><span>Served by: ${esc(sale.salesman_name)}</span></div>
    ${sale.customer_name || sale.customer_phone ? `<div>Customer: ${esc(sale.customer_name || "")} ${esc(sale.customer_phone || "")}</div>` : ""}
    ${showGst && sale.customer_gstin ? `<div>Cust GSTIN: ${esc(sale.customer_gstin)}</div>` : ""}
    ${sale.status === "voided" ? `<div class="c b">*** VOIDED ***</div>` : ""}
    <hr>${rows}<hr>
    <div class="kv"><span>Items total</span><span>${inr(sale.gross)}</span></div>
    ${sale.item_disc + sale.bill_disc > 0 ? `<div class="kv"><span>Discount</span><span>-${inr(r2(sale.item_disc + sale.bill_disc))}</span></div>` : ""}
    ${sale.round_off ? `<div class="kv"><span>Round off</span><span>${sale.round_off > 0 ? "+" : ""}${inr(sale.round_off, { paise: true })}</span></div>` : ""}
    <div class="kv tot"><span>TOTAL</span><span>${inr(sale.grand_total)}</span></div>
    ${pays}
    ${sale.change ? `<div class="kv"><span>Change returned</span><span>${inr(sale.change)}</span></div>` : ""}
    ${returns}
    ${showGst ? `<hr><table><tr><th>GST</th><th>Taxable</th><th>CGST</th><th>SGST</th></tr>
      ${rates.map((r) => `<tr><td>${r.rate}%</td><td>${r.taxable.toFixed(2)}</td><td>${(r.tax / 2).toFixed(2)}</td><td>${(r.tax - r2(r.tax / 2)).toFixed(2)}</td></tr>`).join("")}
    </table><div class="sm">Prices include GST.</div>` : ""}
    ${saved > 0 ? `<div class="save">You saved ${inr(saved)} on MRP!</div>` : ""}
    <hr><div class="c sm">${esc(s.receipt_footer || "Thank you for shopping with us!")}</div>
    <div class="c sm" style="margin-top:4px">groovyfragrances.in</div>
  </body></html>`;
}

/* ---------- A4 tax invoice ----------
   Deliberately the same document as the PDF filed to Drive (backend/invoices.gs → pdfPage_ /
   invoicePdfHtml_): same letterhead, same strip, same table, same totals block. Keep the two in
   step when either changes. */

// the app logo, inline so a printed bill never waits for (or misses) a download
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="52" height="52">
  <circle cx="256" cy="256" r="256" fill="#F5BF03"/>
  <text x="252" y="268" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="90" fill="#141414">GROOVY</text>
  <circle cx="480" cy="192" r="13.5" fill="none" stroke="#141414" stroke-width="2.2"/>
  <text x="480" y="197" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="13.5" fill="#141414">TM</text>
  <line x1="150" y1="296" x2="354" y2="296" stroke="#141414" stroke-width="3"/>
  <text x="252" y="342" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-style="italic" font-size="38" fill="#141414">Fragrances</text>
</svg>`;

// shared page frame: letterhead, title band, body, notes + signature
function a4Page(s, title, stamp, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    @page { size: A4; margin: 14mm; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    /* without this Chrome prints no background colours unless the person ticks "Background graphics",
       so the brown band, the table header and the yellow total would come out blank on paper */
    body { font-family: Helvetica, Arial, sans-serif; font-size: 11px; color: #2b2520; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    table { border-collapse: collapse; width: 100%; } td, th { vertical-align: top; }
    .muted { color: #8a7f75; } .small { font-size: 10px; } .b { font-weight: bold; }
    .sub { font-size: 9px; color: #8a7f75; }
    .n { text-align: right; white-space: nowrap; }
    .lbl { font-size: 8.5px; letter-spacing: .6px; text-transform: uppercase; color: #8a7f75; }
    /* The converter that files the Drive copy paints text, borders and images — never a background. So
       headings are coloured text over a rule, and each fill is only a bonus where it does render: every
       one sits under dark text, which reads the same with or without it. Kept identical in both files. */
    .items td, .items th { border: 1px solid #e7ded2; padding: 4px 6px; font-size: 10px; }
    .items th { background: #f3ece2; color: #654321; border-bottom: 2px solid #654321; font-size: 8.5px; font-weight: bold; letter-spacing: .4px; text-transform: uppercase; text-align: left; }
    .items tbody tr { page-break-inside: avoid; } .items td.mid { vertical-align: middle; }
    .box { background: #faf7f2; }
    .gst td, .gst th { border: 1px solid #e7ded2; padding: 4px 6px; font-size: 10px; text-align: right; }
    .gst th { background: #f3ece2; font-size: 8.5px; letter-spacing: .4px; text-transform: uppercase; color: #6b6157; }
    .tot td { border: 1px solid #e7ded2; padding: 4px 6px; font-size: 10px; } .tot td.v { text-align: right; white-space: nowrap; }
    .grand td { background: #f5bf03; color: #2b2520; border-top: 2px solid #654321; border-bottom: 2px solid #654321; font-size: 11.5px; font-weight: bold; padding: 6px; }
  </style></head><body>
    <table><tr>
      <td style="width:52px;padding-right:10px">${LOGO_SVG}</td>
      <td>
        <div style="font-size:20px;font-weight:bold;color:#654321">${esc(s.business_name)}${s.branch_name ? " · " + esc(s.branch_name) : ""}</div>
        ${s.tagline ? `<div style="font-style:italic;color:#8a7f75">${esc(s.tagline)}</div>` : ""}
        <div class="small" style="margin-top:3px">${esc(s.address || "")}</div>
        <div class="small">${esc([s.phone, s.email].filter(Boolean).join(" · "))}</div>
        ${s.gstin ? `<div class="small b">GSTIN: ${esc(s.gstin)} · State: ${esc(s.state_name || "")} (${esc(s.state_code || "")})</div>` : ""}
      </td>
    </tr></table>
    <div style="border-bottom:3px solid #f5bf03;margin:10px 0 12px"></div>
    <!-- the document's name heads the page: brown bold text between two rules, which is the strongest
         the PDF converter can render — a filled band would come out blank there -->
    <table style="margin-bottom:12px"><tr><td style="border-top:2px solid #654321;border-bottom:2px solid #654321;color:#654321;font-size:13px;font-weight:bold;letter-spacing:3px;padding:7px;text-align:center">${esc(title)}</td></tr></table>
    ${stamp ? `<div style="color:#c62828;font-weight:bold;font-size:14px;text-align:center;margin:-6px 0 12px">${esc(stamp)}</div>` : ""}
    ${body}
    <table style="margin-top:18px"><tr>
      <td class="small muted">${esc(s.receipt_footer || "")}<br>This is a computer generated document.</td>
      <td style="width:210px;text-align:center;padding-left:16px">
        <div class="small" style="margin-bottom:34px">For ${esc(s.business_name)}</div>
        <div style="border-top:1px solid #8a7f75;padding-top:4px" class="small muted">Authorised Signatory</div>
      </td>
    </tr></table>
  </body></html>`;
}

// four label/value cells in a bordered strip
const a4Meta = (cells) =>
  `<table class="box"><tr>${cells
    .map((c) => `<td style="width:25%;padding:4px 6px;border:1px solid #e7ded2;font-size:10px"><div class="lbl">${esc(c[0])}</div>${c[1]}</td>`)
    .join("")}</tr></table>`;

export function a4InvoiceHtml(d, s) {
  const sale = d.sale;
  const showGst = !sale.gst_hidden; // GST breakup can be left off the customer's bill
  s = shopForBill(shopFor(d, s), showGst);
  const rates = gstByRate(d.items);
  const money = (v, i) => inr(v, { paise: i && i.unit === "ml" });
  const rows = d.items
    .map((i, n) => {
      const disc = r2(i.discount + (i.bill_disc_share || 0));
      return `<tr${n % 2 ? ' style="background:#faf7f2"' : ""}><td class="muted">${n + 1}</td>
      <td><b>${esc(itemName(i))}</b>${i.brand ? `<div class="sub">${esc(i.brand)}</div>` : ""}</td>
      ${showGst ? `<td class="small mid">${esc(i.hsn || "")}</td>` : ""}
      <td class="n mid">${qtyLabel(i.qty, i.unit)}</td><td class="n mid muted">${money(i.mrp, i)}</td><td class="n mid">${money(i.price, i)}</td>
      <td class="n mid">${disc > 0 ? "-" + inr(disc) : "—"}</td>
      ${showGst ? `<td class="n mid">${i.gst_rate}%</td><td class="n mid">${i.taxable.toFixed(2)}</td>` : ""}
      <td class="n mid b">${inr(i.line_total)}</td></tr>`;
    })
    .join("");
  const th = (w, label, right) => `<th${right ? ' class="n"' : ""}${w ? ` style="width:${w}"` : ""}>${label}</th>`;
  const head = `<tr>${th("22px", "#")}${th("", "Item")}${showGst ? th("52px", "HSN") : ""}
    ${th("38px", "Qty", 1)}${th("54px", "MRP", 1)}${th("54px", "Rate", 1)}${th("50px", "Disc", 1)}
    ${showGst ? th("38px", "GST", 1) + th("62px", "Taxable", 1) : ""}${th("70px", "Amount", 1)}</tr>`;
  const gstTable = showGst
    ? `<div class="lbl" style="margin-bottom:4px">GST summary (prices include GST)</div>
       <table class="gst" style="width:auto"><tr><th>Rate</th><th>Taxable</th><th>CGST</th><th>SGST</th><th>Total tax</th></tr>
       ${rates.map((r) => `<tr><td>${r.rate}%</td><td>${r.taxable.toFixed(2)}</td><td>${(r.tax / 2).toFixed(2)}</td><td>${(r.tax - r2(r.tax / 2)).toFixed(2)}</td><td>${r.tax.toFixed(2)}</td></tr>`).join("")}</table>`
    : "";
  const line = (l, v, cls) => `<tr class="${cls || ""}"><td>${l}</td><td class="v">${v}</td></tr>`;
  const disc = r2(sale.item_disc + sale.bill_disc);
  const pays = payLines(d);
  const paid = r2(pays.reduce((a, p) => a + p.amount, 0));
  const balance = r2(sale.grand_total - paid);
  const saved = savings(d);
  // one table, not three: separate tables size their own columns, which left Grand Total's divider
  // sitting at a different place from the CGST/SGST rows above it
  const totals = `<table class="tot">${line("Items total", inr(sale.gross))}
      ${disc > 0 ? line("Discount", "-" + inr(disc)) : ""}
      ${showGst ? line("Taxable value", inr(sale.taxable, { paise: true })) + line("CGST", inr(sale.cgst, { paise: true })) + line("SGST", inr(sale.sgst, { paise: true })) : ""}
      ${sale.round_off ? line("Round off", inr(sale.round_off, { paise: true })) : ""}
      ${line("Grand Total", inr(sale.grand_total), "grand")}
      ${pays.map((p) => line("Paid · " + (METHOD_LABEL[p.method] || esc(p.method)), inr(p.amount))).join("")}
      ${balance > 0 ? line("<b>Balance due</b>", "<b>" + inr(balance) + "</b>") : balance < 0 ? line("Change given", inr(-balance)) : ""}
      ${(d.returns || []).map((r) => line("Credit note " + esc(r.credit_note_no), "-" + inr(r.total))).join("")}
    </table>
    ${saved > 0 ? `<div style="margin-top:6px;text-align:right;color:#2e7d32;font-weight:bold">You saved ${inr(saved)} on MRP!</div>` : ""}`;
  const body = `${a4Meta([
    ["Invoice No", `<b>${esc(sale.invoice_no)}</b>`],
    ["Date", `<span style="white-space:nowrap">${esc(fmtDateTimeFull(sale.date))}</span>`],
    ["Bill To", esc(sale.customer_name || "Walk-in customer") + (sale.customer_phone ? "<br>" + esc(sale.customer_phone) : "") + (showGst && sale.customer_gstin ? "<br>GSTIN: " + esc(sale.customer_gstin) : "")],
    ["Served By", esc(sale.salesman_name)],
  ])}
    <table class="items" style="margin-top:12px"><thead>${head}</thead><tbody>${rows}</tbody></table>
    <table style="margin-top:14px"><tr><td style="padding-right:16px">${gstTable}</td><td style="width:265px">${totals}</td></tr></table>`;
  return a4Page(s, showGst && s.gstin ? "TAX INVOICE" : "INVOICE", sale.status === "voided" ? "VOIDED" : "", body);
}

// An iPhone/iPad *browser tab* (every browser there is Apple's WebKit, Chrome too) ignores printing a
// hidden frame and prints the app screen instead, so there the bill opens as a page of its own and prints
// itself. The installed app, Android and computers keep the hidden frame, which prints the bill there.
const isInstalledApp = () => window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
const isIPhoneOrIPad = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

export function printHtml(html) {
  if (isIPhoneOrIPad() && !isInstalledApp() && printInNewTab(html)) return;
  printInFrame(html);
}

// on the screen only, never on paper: a way back to the app once the print sheet is closed
const BACK_BAR = `<style>
    #gp-bar { position: sticky; top: 0; z-index: 9; display: flex; gap: 8px; align-items: center; padding: 8px; margin: 0 0 10px; background: #654321; font: 14px/1.2 Helvetica, Arial, sans-serif; }
    #gp-bar button { padding: 9px 12px; border: 0; border-radius: 8px; background: #f5bf03; color: #2b2520; font: bold 14px Helvetica, Arial, sans-serif; }
    #gp-bar #gp-print { background: #fff; }
    #gp-bar span { color: #fff; }
    @media print { #gp-bar { display: none !important; } }
  </style><div id="gp-bar"><button id="gp-back" type="button">← Back to app</button><button id="gp-print" type="button">Print again</button><span id="gp-hint"></span></div>`;

// opened right inside the tap, so the browser doesn't block it; false if it was blocked anyway
function printInNewTab(html) {
  const w = window.open("", "_blank");
  if (!w) return false;
  const doc = w.document;
  doc.open();
  doc.write(html.replace(/<body[^>]*>/, (b) => b + BACK_BAR));
  doc.close();
  const back = doc.getElementById("gp-back");
  const again = doc.getElementById("gp-print");
  if (back) back.addEventListener("click", () => {
    w.close();
    // a browser that won't close the tab: say where the app is
    setTimeout(() => {
      const hint = !w.closed && doc.getElementById("gp-hint");
      if (hint) hint.textContent = "Switch to the Groovy Kiosk tab";
    }, 400);
  });
  if (again) again.addEventListener("click", () => w.print());
  setTimeout(() => {
    w.focus();
    w.print();
  }, 350);
  return true;
}

function printInFrame(html) {
  const f = document.createElement("iframe");
  f.setAttribute("aria-hidden", "true");
  f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  document.body.appendChild(f);
  const doc = f.contentWindow.document;
  doc.open();
  doc.write(html);
  doc.close();
  setTimeout(() => {
    f.contentWindow.focus();
    f.contentWindow.print();
    setTimeout(() => f.remove(), 60000);
  }, 350);
}

/* ---------- WhatsApp / share ---------- */
export function billText(d, s) {
  s = shopFor(d, s);
  const sale = d.sale;
  const showGst = !sale.gst_hidden; // GST breakup can be left off the customer's bill
  const lines = d.items.map((i) => `• ${itemName(i)} × ${qtyLabel(i.qty, i.unit)} = ${inr(r2(i.price * i.qty))}`);
  const disc = r2(sale.item_disc + sale.bill_disc);
  const saved = savings(d);
  const pays = payLines(d).map((p) => `${METHOD_LABEL[p.method] || p.method} ${inr(p.amount)}`).join(", ");
  return [
    `*${s.business_name || "Groovy Fragrances"}${s.branch_name ? " · " + s.branch_name : ""}*`,
    s.tagline ? `_${s.tagline}_` : "",
    "",
    `Bill: ${sale.invoice_no}`,
    `Date: ${fmtDateTime(sale.date)}`,
    `Served by: ${sale.salesman_name}`,
    "",
    ...lines,
    "",
    disc > 0 ? `Discount: -${inr(disc)}` : "",
    `*Total: ${inr(sale.grand_total)}*${showGst ? " (incl. GST)" : ""}`,
    pays ? `Paid: ${pays}` : "",
    saved > 0 ? `You saved ${inr(saved)} on MRP! 🎉` : "",
    "",
    s.receipt_footer || "Thank you for shopping with us!",
    "groovyfragrances.in",
  ]
    .filter((l, i, a) => l !== "" || (a[i - 1] !== "" && i > 0))
    .join("\n");
}

export function whatsappLink(phone, text) {
  const p = String(phone || "").replace(/\D/g, "");
  const to = p.length === 10 ? "91" + p : p;
  return `https://wa.me/${to}?text=${encodeURIComponent(text)}`;
}

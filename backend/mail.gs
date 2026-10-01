/**
 * Day-close emails.
 *  A) apiEmailDayClose_ — any staff member emails the day close from the app
 *     (a salesperson gets their own figures only; manager and owner: whole shop).
 *  B) sendNightlyReport — time-driven trigger that emails the whole-shop day close every night.
 *     Switched on/off from Settings; syncNightlyTrigger_ installs or removes the trigger.
 * Emails are sent from the Google account that owns this script.
 */

const NIGHTLY_FN_ = "sendNightlyReport";
const EMAIL_RE_ = /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/;
const MAX_MANUAL_EMAILS_PER_DAY_ = 5;

function splitEmails_(s) {
    return String(s || "")
        .split(/[,;\s]+/)
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean);
}

// a branch's own recipients + the owner list (Settings → Email, or every Owner account)
function recipientsFor_(branchId) {
    const own = branchId ? splitEmails_((branchById_(branchId) || {}).report_emails) : [];
    return own.concat(reportRecipients_().filter((e) => own.indexOf(e) < 0));
}

// Settings list, or every active Owner account when the list is empty
function reportRecipients_() {
    const list = splitEmails_(setting_("report_emails"));
    if (list.length) return list;
    return rows_("Users")
        .filter((u) => u.active && roleName_(u.role) === "owner" && u.email)
        .map((u) => u.email);
}

function inrText_(n) {
    const neg = n < 0;
    const parts = Math.abs(r2_(n)).toFixed(2).split(".");
    const i = parts[0];
    let rest = i.slice(0, -3);
    if (rest) rest = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + ",";
    return (neg ? "-" : "") + "₹" + rest + i.slice(-3) + (parts[1] === "00" ? "" : "." + parts[1]);
}

function dateNice_(ymd) {
    const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const p = String(ymd).split("-");
    return parseInt(p[2], 10) + " " + m[parseInt(p[1], 10) - 1] + " " + p[0];
}

const METHOD_NAME_ = { cash: "Cash", upi: "UPI", card: "Card", exchange: "Exchange" };

/** Builds subject + HTML + plain text for a reportDayClose_ result. */
function dayCloseMail_(d, s, opt) {
    const biz = s.business_name || "Groovy Fragrances";
    const where = d.branch_name && activeBranches_().length > 1 ? d.branch_name : "";
    const scope = (opt.salesperson ? opt.salesperson : "Whole shop") + (where ? " · " + where : "");
    const subject = biz + (where ? " " + where : "") + " — Day close " + dateNice_(d.date) + " — " + inrText_(d.net) + (opt.salesperson ? " (" + opt.salesperson + ")" : "");
    const td = 'style="padding:6px 8px;border-bottom:1px solid #EBE3D9"';
    const tdr = 'style="padding:6px 8px;border-bottom:1px solid #EBE3D9;text-align:right;white-space:nowrap"';
    const th = 'style="padding:6px 8px;text-align:left;font-size:12px;color:#7A716A;border-bottom:2px solid #EBE3D9"';
    const thr = 'style="padding:6px 8px;text-align:right;font-size:12px;color:#7A716A;border-bottom:2px solid #EBE3D9"';
    const stat = (label, value) =>
        '<td style="padding:10px;background:#FAF7F2;border-radius:8px;width:25%"><div style="font-size:12px;color:#7A716A">' +
        label + '</div><div style="font-size:18px;font-weight:700;color:#1A1A1A;font-family:Georgia,serif">' + value + "</div></td>";

    const methods = Object.keys(d.methods)
        .map((m) => "<tr><td " + td + ">" + (METHOD_NAME_[m] || m) + "</td><td " + tdr + ">" + inrText_(d.methods[m].in) + "</td><td " + tdr + ">" +
            inrText_(d.methods[m].out) + "</td><td " + tdr + "><b>" + inrText_(d.methods[m].net) + "</b></td></tr>")
        .join("");
    // items billed and new customers go under the name, not in columns of their own: six columns in a
    // 560px-wide email wrap badly on a phone. "Items billed" keeps them distinct from the per-product
    // "Items sold" table further down, which counts the same goods a different way (net of returns).
    const sub = (txt) => '<div style="font-size:11px;color:#7A716A">' + txt + "</div>";
    const sellers = d.by_salesman
        .map((r, i) => "<tr><td " + td + ">" + (i + 1) + ". " + escHtml_(r.name) +
            sub(r.items + " items billed · " + r.new_customers + " new " + (r.new_customers === 1 ? "customer" : "customers")) +
            "</td><td " + tdr + ">" + r.bills + "</td><td " + tdr + ">" +
            inrText_(r.returns) + "</td><td " + tdr + "><b>" + inrText_(r.net) + "</b></td></tr>")
        .join("");
    // what was sold, with stock left — for refilling
    const qtyTxt = (q, unit) => r3_(q) + (unit === "ml" ? " ml" : "");
    const items = d.items || [];
    const refills = items.filter((it) => it.refill).length;
    const itemRows = items
        .map((it) =>
            "<tr" + (it.refill ? ' style="background:#FDECEA"' : "") + "><td " + td + "><b>" + escHtml_(it.name) + "</b>" +
            (it.unit === "ml" ? "" : " " + escHtml_(it.size)) +
            (it.brand ? '<div style="font-size:11px;color:#7A716A">' + escHtml_(it.brand) + "</div>" : "") +
            "</td><td " + tdr + ">" + qtyTxt(it.qty, it.unit) + "</td><td " + tdr + ">" + qtyTxt(it.stock_left, it.unit) +
            (it.refill ? '<div style="font-size:11px;font-weight:700;color:#C62828">REFILL</div>' : "") + "</td></tr>")
        .join("");
    const extra = [];
    d.voided.forEach((v) => extra.push("Voided " + escHtml_(v.invoice_no) + " (" + escHtml_(v.salesman_name) + ") " + inrText_(v.amount)));
    d.credit_notes.forEach((c) => extra.push("Return " + escHtml_(c.credit_note_no) + " on " + escHtml_(c.invoice_no) + " −" + inrText_(c.total) + " · " + escHtml_(c.reason)));

    const html =
        '<div style="font-family:Arial,Helvetica,sans-serif;background:#FAF7F2;padding:16px">' +
        '<div style="max-width:560px;margin:auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #EBE3D9">' +
        '<div style="background:#654321;color:#fff;padding:16px 20px;border-bottom:5px solid #F5BF03">' +
        '<div style="font-family:Georgia,serif;font-size:20px;font-weight:700">' + escHtml_(biz) + "</div>" +
        '<div style="color:#F5BF03;font-size:13px">Day close · ' + dateNice_(d.date) + " · " + escHtml_(scope) + "</div></div>" +
        '<div style="padding:16px 20px">' +
        '<table style="width:100%;border-collapse:separate;border-spacing:6px"><tr>' +
        stat("Net sales", inrText_(d.net)) + stat("Bills", d.bills) + stat("Discounts", inrText_(d.discounts)) + stat("Returns", inrText_(d.returns)) +
        "</tr></table>" +
        '<h3 style="font-family:Georgia,serif;color:#654321;margin:18px 0 6px">Money by method</h3>' +
        '<table style="width:100%;border-collapse:collapse;font-size:14px"><tr><th ' + th + ">Method</th><th " + thr + ">In</th><th " + thr +
        ">Refund</th><th " + thr + ">Net</th></tr>" + methods + "</table>" +
        (opt.salesperson ? "" :
            '<table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:8px">' +
            (d.cash_expenses ? "<tr><td " + td + ">Cash expenses paid</td><td " + tdr + ">−" + inrText_(d.cash_expenses) + "</td></tr>" : "") +
            '<tr><td style="padding:8px;font-weight:700;font-size:16px;border-top:2px solid #1A1A1A">Cash in drawer</td>' +
            '<td style="padding:8px;font-weight:700;font-size:16px;text-align:right;border-top:2px solid #1A1A1A">' + inrText_(d.expected_cash) + "</td></tr></table>" +
            '<div style="font-size:12px;color:#7A716A">Expected cash from today\'s sales (plus your opening float).</div>') +
        ((d.by_branch || []).length
            ? '<h3 style="font-family:Georgia,serif;color:#654321;margin:18px 0 6px">By branch</h3><table style="width:100%;border-collapse:collapse;font-size:14px"><tr><th ' +
              th + ">Branch</th><th " + thr + ">Bills</th><th " + thr + ">Returns</th><th " + thr + ">Net</th></tr>" +
              d.by_branch.map((b) => "<tr><td " + td + ">" + escHtml_(b.name) +
                  sub(b.items + " items billed · " + b.new_customers + " new " +
                      (b.new_customers === 1 ? "customer" : "customers") + " to the shop") +
                  "</td><td " + tdr + ">" + b.bills + "</td><td " + tdr + ">" + inrText_(b.returns) + "</td><td " + tdr + "><b>" + inrText_(b.net) + "</b></td></tr>").join("") +
              "</table>"
            : "") +
        '<h3 style="font-family:Georgia,serif;color:#654321;margin:18px 0 6px">' + (opt.salesperson ? "Your sales" : "By salesperson") + "</h3>" +
        (sellers
            ? '<table style="width:100%;border-collapse:collapse;font-size:14px"><tr><th ' + th + ">Salesperson</th><th " + thr + ">Bills</th><th " + thr +
              ">Returns</th><th " + thr + ">Net</th></tr>" + sellers + "</table>"
            : '<div style="color:#7A716A">No sales.</div>') +
        (items.length
            ? '<h3 style="font-family:Georgia,serif;color:#654321;margin:18px 0 6px">Items sold (' + items.length + ")" +
              (refills ? ' <span style="font-family:Arial;font-size:12px;color:#C62828">· ' + refills + " to refill</span>" : "") + "</h3>" +
              '<table style="width:100%;border-collapse:collapse;font-size:14px"><tr><th ' + th + ">Item</th><th " + thr + ">Sold</th><th " + thr +
              ">Stock left</th></tr>" + itemRows + "</table>"
            : "") +
        (extra.length ? '<h3 style="font-family:Georgia,serif;color:#654321;margin:18px 0 6px">Voids & returns</h3><div style="font-size:13px">' + extra.join("<br>") + "</div>" : "") +
        "</div>" +
        '<div style="padding:10px 20px;background:#FAF7F2;font-size:12px;color:#7A716A">' + escHtml_(opt.footer) + "</div>" +
        "</div></div>";

    const text = [
        biz + " — Day close " + dateNice_(d.date) + " (" + scope + ")",
        "",
        "Net sales: " + inrText_(d.net) + "   Bills: " + d.bills + "   Discounts: " + inrText_(d.discounts) + "   Returns: " + inrText_(d.returns),
        "",
        Object.keys(d.methods).map((m) => (METHOD_NAME_[m] || m) + ": " + inrText_(d.methods[m].net)).join("   "),
        opt.salesperson ? "" : "Cash in drawer (expected): " + inrText_(d.expected_cash),
        "",
        d.by_salesman
            .map((r) =>
                r.name + ": " + r.bills + " bills, " + r.items + " items, " +
                r.new_customers + " new " + (r.new_customers === 1 ? "customer" : "customers") + ", " + inrText_(r.net))
            .join("\n"),
        items.length ? "\nItems sold:" : "",
        items
            .map((it) => "- " + it.name + (it.unit === "ml" ? "" : " " + it.size) + ": sold " + qtyTxt(it.qty, it.unit) + ", left " + qtyTxt(it.stock_left, it.unit) + (it.refill ? "  << REFILL" : ""))
            .join("\n"),
        extra.length ? "\n" + extra.join("\n").replace(/<[^>]+>/g, "") : "",
        "",
        opt.footer,
    ].join("\n");
    return { subject, html, text };
}

function sendMail_(to, mail, extra) {
    const count = to.length + (extra && extra.cc ? 1 : 0);
    if (MailApp.getRemainingDailyQuota() < count) fail_("Google's daily email limit is reached. Try again tomorrow.");
    const msg = {
        to: to.join(","),
        subject: mail.subject,
        body: mail.text,
        htmlBody: mail.html,
        name: (setting_("business_name") || "Groovy Fragrances") + " Kiosk",
    };
    if (extra && extra.cc) msg.cc = extra.cc;
    if (extra && extra.replyTo) msg.replyTo = extra.replyTo;
    MailApp.sendEmail(msg);
}

/* ---------- A) email from the app ---------- */

function apiEmailDayClose_(p, ctx) {
    const date = str_(p.date) || todayStr_();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > todayStr_()) fail_("Choose a valid date");
    const to = recipientsFor_(ctx.branch_id);
    if (!to.length) fail_("No report email is set. Ask the owner to add one in Settings → Email.");

    const cache = CacheService.getScriptCache();
    const key = "mail_dc_" + ctx.user.id + "_" + todayStr_();
    const sent = num_(cache.get(key), 0);
    if (sent >= MAX_MANUAL_EMAILS_PER_DAY_) fail_("You've already sent " + sent + " day-close emails today.");

    const isSalesman = ctx.user.role === "salesperson";
    const d = reportDayClose_({ date }, ctx);
    const mail = dayCloseMail_(d, settingsMap_(), {
        salesperson: isSalesman ? ctx.user.name : "",
        footer: "Sent by " + ctx.user.name + " from Groovy Kiosk on " + nowStr_().slice(0, 16),
    });
    const cc = p.copy_me && ctx.user.email && to.indexOf(ctx.user.email) < 0 ? ctx.user.email : "";
    sendMail_(to, mail, { cc, replyTo: ctx.user.email });
    cache.put(key, String(sent + 1), 21600);
    log_(ctx, "EMAIL", "Reports", date, "Day close emailed to " + to.length + " address(es)" + (cc ? " + copy" : ""));
    return { message: "Day close emailed" + (cc ? " (copy sent to you)" : "") };
}

/* ---------- B) nightly email (time-driven trigger) ---------- */

// Called by the daily trigger. Does nothing when switched off in Settings.
function sendNightlyReport() {
    resetReqCache_();
    const s = settingsMap_();
    if (s.nightly_report !== "yes") return "disabled";
    const results = sendBranchDayCloses_(s.nightly_report_skip_empty !== "no", "Sent automatically every night by Groovy Kiosk. Turn it off in Settings → Email.");
    return results.join("; ");
}

// one day-close email per active branch → "Kondhwa: sent" …
function sendBranchDayCloses_(skipEmpty, footer) {
    const date = todayStr_();
    const s = settingsMap_();
    return activeBranches_().map((b) => {
        const to = recipientsFor_(b.id);
        if (!to.length) return b.name + ": no recipients";
        const sys = { user: { id: 0, name: "Nightly report", role: "owner", email: "" }, branch_id: b.id };
        const d = reportDayClose_({ date }, sys);
        if (skipEmpty && !d.bills && !d.returns && !d.voided.length) return b.name + ": skipped (no sales)";
        sendMail_(to, dayCloseMail_(d, s, { salesperson: "", footer }), {});
        log_(sys, "EMAIL", "Reports", date, b.name + " day close sent to " + to.length + " address(es)");
        return b.name + ": sent";
    });
}

// Installs (or removes) the single daily trigger to match Settings.
function syncNightlyTrigger_() {
    ScriptApp.getProjectTriggers()
        .filter((t) => t.getHandlerFunction() === NIGHTLY_FN_)
        .forEach((t) => ScriptApp.deleteTrigger(t));
    if (setting_("nightly_report") !== "yes") return false;
    const hour = Math.min(23, Math.max(0, parseInt(setting_("nightly_report_hour"), 10) || 22));
    ScriptApp.newTrigger(NIGHTLY_FN_).timeBased().atHour(hour).everyDays(1).inTimezone(APP.TZ).create();
    return true;
}

// Sheet menu: send today's whole-shop day close right now (ignores the on/off switch)
function emailDayCloseNow() {
    resetReqCache_();
    alert_("Day close emails:\n" + sendBranchDayCloses_(false, "Sent from the Groovy Kiosk menu in Google Sheets.").join("\n"));
}

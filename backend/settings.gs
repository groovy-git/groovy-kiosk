/** Settings (key/value) + activity log. */

function settingsMap_() {
    if (REQ_CACHE_.__settings) return REQ_CACHE_.__settings;
    const m = Object.assign({}, DEFAULT_SETTINGS);
    rows_("Settings").forEach((r) => (m[r.key] = r.value));
    REQ_CACHE_.__settings = m;
    return m;
}

function setting_(key) {
    return settingsMap_()[key];
}

function setSetting_(key, value, userId) {
    const row = findBy_("Settings", "key", key);
    const now = nowStr_();
    if (row) {
        row.value = String(value);
        row.updated_by = userId || 0;
        row.updated_at = now;
        updateRows_("Settings", [row]);
    } else {
        appendRows_("Settings", [{ key, value: String(value), updated_by: userId || 0, updated_at: now }]);
    }
    if (REQ_CACHE_.__settings) REQ_CACHE_.__settings[key] = String(value);
}

// must be called inside withLock_
function nextCounter_(key) {
    const n = num_(setting_(key), 0) + 1;
    setSetting_(key, n, 0);
    return n;
}

/**
 * Two counters, because they change at very different rates.
 *
 * The catalogue — names, prices, images, brands — changes when somebody edits a product. Stock changes
 * with every single bill. They used to share one number, so every sale told every device that its
 * whole catalogue was out of date, and a busy shop re-sent ~1,700 products per sale per phone.
 * A catalogue change moves both (an edit can change stock too); a sale moves only the stock one.
 */
function bumpCatalogVersion_() {
    setSetting_("catalog_version", num_(setting_("catalog_version"), 1) + 1, 0);
    bumpStockVersion_();
}

function bumpStockVersion_() {
    setSetting_("stock_version", num_(setting_("stock_version"), 1) + 1, 0);
}

// settings visible to logged-in users (counters hidden; report recipients only for the owner)
function publicSettings_(ctx) {
    const s = settingsMap_();
    const out = {};
    const admin = !ctx || ctx.user.role === "owner";
    Object.keys(s).forEach((k) => {
        if (k.indexOf("inv_seq_") === 0 || k.indexOf("cn_seq_") === 0 || k === "internal_barcode_seq" || k === "sku_seq") return;
        if (k === "report_emails" && !admin) return;
        out[k] = s[k];
    });
    return out;
}

function apiGetSettings_(p, ctx) {
    return { data: publicSettings_(ctx) };
}

const EDITABLE_SETTINGS_ = [
    "business_name", "tagline", "address", "phone", "email", "gstin", "state_name", "state_code",
    "invoice_prefix", "tola_ml", "salesman_max_disc_pct", "salesperson_max_return", "return_days", "round_off",
    "allow_negative_stock", "receipt_footer", "expense_categories",
    "report_emails", "nightly_report", "nightly_report_hour", "nightly_report_skip_empty", "invoice_pdfs",
    "forgot_password",
];
const NIGHTLY_KEYS_ = ["nightly_report", "nightly_report_hour"];

function apiSaveSettings_(p, ctx) {
    const vals = p.settings || {};
    if (vals.report_emails !== undefined) {
        const list = splitEmails_(vals.report_emails);
        const bad = list.filter((e) => !EMAIL_RE_.test(e));
        if (bad.length) fail_("Not a valid email: " + bad.join(", "));
        vals.report_emails = list.join(", ");
    }
    if (vals.invoice_prefix !== undefined) {
        vals.invoice_prefix = str_(vals.invoice_prefix).toUpperCase();
        const longest = Math.max(0, ...rows_("Branches").map((b) => str_(b.code).length));
        if (!/^[A-Z0-9]{1,4}$/.test(vals.invoice_prefix)) fail_("Invoice prefix must be 1–4 letters/digits");
        if (vals.invoice_prefix.length + longest > 4) fail_("Invoice prefix + branch code must be at most 4 characters, e.g. GF + KN (GST bill numbers are limited to 16)");
    }
    if (vals.nightly_report !== undefined && ["yes", "no"].indexOf(vals.nightly_report) < 0) fail_("Invalid nightly email option");
    if (vals.nightly_report_skip_empty !== undefined && ["yes", "no"].indexOf(vals.nightly_report_skip_empty) < 0) fail_("Invalid option");
    if (vals.forgot_password !== undefined && ["yes", "no"].indexOf(vals.forgot_password) < 0) fail_("Invalid forgot-password option");
    if (vals.nightly_report_hour !== undefined) {
        const h = parseInt(vals.nightly_report_hour, 10);
        if (isNaN(h) || h < 0 || h > 23) fail_("Choose an hour between 0 and 23");
        vals.nightly_report_hour = String(h);
    }
    const before = {};
    NIGHTLY_KEYS_.forEach((k) => (before[k] = setting_(k)));
    const pdfBefore = setting_("invoice_pdfs");
    if (vals.gstin) {
        vals.gstin = str_(vals.gstin).toUpperCase();
        if (!/^[0-9A-Z]{15}$/.test(vals.gstin)) fail_("GSTIN must be 15 letters/digits");
    }
    ["tola_ml", "salesman_max_disc_pct", "salesperson_max_return", "return_days"].forEach((k) => {
        if (vals[k] !== undefined && (isNaN(parseFloat(vals[k])) || parseFloat(vals[k]) < 0))
            fail_(k.replace(/_/g, " ") + " must be a positive number");
    });
    withLock_(() => {
        EDITABLE_SETTINGS_.forEach((k) => {
            if (vals[k] !== undefined) setSetting_(k, str_(vals[k]), ctx.user.id);
        });
        log_(ctx, "UPDATE", "Settings", "", "Settings updated");
    });
    let message = "Settings saved";
    if (NIGHTLY_KEYS_.some((k) => setting_(k) !== before[k])) {
        try {
            const on = syncNightlyTrigger_();
            const h = parseInt(setting_("nightly_report_hour"), 10);
            message = on ? "Saved. Nightly email is ON — arrives between " + hourLabel_(h) + " and " + hourLabel_((h + 1) % 24) + "." : "Saved. Nightly email is OFF.";
        } catch (e) {
            console.error("syncNightlyTrigger_", e);
            message = "Settings saved, but the nightly email could not be scheduled. Open the Sheet → Groovy Kiosk menu once to grant permission, then save again.";
        }
    }
    if (setting_("invoice_pdfs") !== pdfBefore) {
        try {
            syncPdfTrigger_();
        } catch (e) {
            console.error("syncPdfTrigger_", e);
            message = "Settings saved, but the invoice PDF timer could not be changed. Open the Sheet → Groovy Kiosk → 1. Setup / repair sheets once, then save again.";
        }
    }
    return { message, data: publicSettings_(ctx) };
}

function hourLabel_(h) {
    return (h % 12 || 12) + (h < 12 ? " AM" : " PM");
}

/* ---------- activity log ---------- */

function log_(ctx, action, entity, refId, details) {
    try {
        appendRows_("Activity_Logs", [
            {
                id: nextId_("Activity_Logs"),
                user_id: ctx && ctx.user ? ctx.user.id : 0,
                user_name: ctx && ctx.user ? ctx.user.name : "",
                action,
                entity,
                ref_id: refId === undefined ? "" : String(refId),
                details: details || "",
                at: nowStr_(),
            },
        ]);
    } catch (e) {
        console.error("log_", e);
    }
}

function apiListLogs_(p, ctx) {
    const lim = Math.min(num_(p.limit, 300), 1000);
    const q = str_(p.q).toLowerCase();
    // the newest rows are all this screen shows; a search looks back further but still not
    // through every line ever logged
    let rows = tailRows_("Activity_Logs", q ? Math.max(5000, lim) : lim).reverse();
    if (q)
        rows = rows.filter((r) =>
            (r.user_name + " " + r.action + " " + r.entity + " " + r.details).toLowerCase().indexOf(q) >= 0,
        );
    return {
        data: rows.slice(0, lim).map((r) => ({
            id: r.id, user_name: r.user_name, action: r.action, entity: r.entity,
            ref_id: r.ref_id, details: r.details, at: r.at,
        })),
    };
}

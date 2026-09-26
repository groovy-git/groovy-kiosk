/**
 * Table helpers — every sheet is read at most once per request and cached here.
 * Records are plain objects keyed by header name, plus `_r` (1-based sheet row).
 */

let REQ_CACHE_ = {};

/** Forget the rows read so far but keep the open spreadsheet — for a second pass inside one lock. */
function rereadRows_() {
    const ss = REQ_CACHE_.__ss;
    const api = REQ_CACHE_.__api;
    REQ_CACHE_ = {};
    if (ss) REQ_CACHE_.__ss = ss;
    if (api) REQ_CACHE_.__api = api;
}

function resetReqCache_() {
    REQ_CACHE_ = {};
}

function ss_() {
    if (!REQ_CACHE_.__ss) {
        const id = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
        REQ_CACHE_.__ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
    }
    return REQ_CACHE_.__ss;
}

/**
 * Within one app request (`__api`, set by dispatch_) a sheet's handle and header row are looked up
 * once and reused: no app action adds, renames or deletes a sheet or rewrites a header, so they
 * cannot change under it. Setup, backups and timers never set the flag and look them up every time.
 */
function sheet_(name) {
    const k = "__sh_" + name;
    if (REQ_CACHE_.__api && REQ_CACHE_[k]) return REQ_CACHE_[k];
    const sh = ss_().getSheetByName(name);
    if (!sh) throw new AppError_("Sheet '" + name + "' missing. Run Setup from the Groovy POS menu.");
    if (REQ_CACHE_.__api) REQ_CACHE_[k] = sh;
    return sh;
}

function cols_(name) {
    return Object.keys(SCHEMA[name]);
}

// coerce a raw cell into the schema type
function fromCell_(v, type) {
    if (type === "n") {
        if (v === "" || v === null) return 0;
        const n = typeof v === "number" ? v : parseFloat(v);
        return isNaN(n) ? 0 : n;
    }
    if (v instanceof Date) return fmtDateTime_(v);
    if (type === "j") {
        if (!v) return null;
        try {
            return JSON.parse(v);
        } catch (e) {
            return null;
        }
    }
    return v === null || v === undefined ? "" : String(v);
}

function toCell_(v, type) {
    if (type === "n") {
        if (v === "" || v === null || v === undefined) return "";
        const n = Number(v);
        return isNaN(n) ? "" : n;
    }
    if (type === "j") return v === null || v === undefined ? "" : JSON.stringify(v);
    if (v === null || v === undefined) return "";
    let s = String(v);
    if (s.charAt(0) === "=") s = "'" + s; // no formula injection
    return s;
}

function readTable_(name) {
    if (REQ_CACHE_[name]) return REQ_CACHE_[name];
    const sh = sheet_(name);
    const schema = SCHEMA[name];
    const keys = Object.keys(schema);
    // header + data in one read; a missing/renamed last column means Setup hasn't run after an update
    const outdated = () => new AppError_("The app was updated — open the Google Sheet and run Groovy POS → 1. Setup / repair sheets.", "SETUP");
    let vals;
    try {
        vals = sh.getRange(1, 1, Math.max(1, sh.getLastRow()), keys.length).getValues();
    } catch (e) {
        throw outdated(); // sheet has fewer columns than this version needs
    }
    if (String(vals[0][keys.length - 1]) !== keys[keys.length - 1]) throw outdated();
    const t = { name, sh, keys, rows: rowsFromValues_(name, vals.slice(1), 2) };
    REQ_CACHE_[name] = t;
    return t;
}

// raw cell rows → records, the way readTable_ does it; firstRow is the sheet row of vals[0]
function rowsFromValues_(name, vals, firstRow) {
    const schema = SCHEMA[name];
    const keys = Object.keys(schema);
    const rows = [];
    for (let i = 0; i < vals.length; i++) {
        const raw = vals[i];
        if (raw[0] === "" && raw.every((c) => c === "")) continue;
        const o = { _r: firstRow + i };
        for (let k = 0; k < keys.length; k++) o[keys[k]] = fromCell_(raw[k], schema[keys[k]]);
        rows.push(o);
    }
    return rows;
}

function rows_(name) {
    return readTable_(name).rows;
}

/**
 * Reading less of a sheet.
 *
 * A sheet read costs roughly its cells, and these tables only ever grow: by the thousandth bill,
 * "today's sales" was reading every bill ever written, 30 columns wide. The helpers below read a
 * slice instead. Each one falls back to the whole table when it is already in the request cache
 * (no second read is cheaper than none) and checks the header of the column it reads, so a sheet
 * that hasn't been repaired after an update still gives the "run Setup" message rather than
 * silently reading the wrong column.
 */
function headerCell_(sh, name, field) {
    const keys = cols_(name);
    const c = keys.indexOf(field) + 1;
    if (c < 1) throw new Error("Unknown column " + field + " on " + name);
    if (String(headerValue_(sh, name, c)) !== field)
        throw new AppError_("The app was updated — open the Google Sheet and run Groovy POS → 1. Setup / repair sheets.", "SETUP");
    return c;
}

// the header in column c; in an app request the whole header row is read once and kept
function headerValue_(sh, name, c) {
    if (!REQ_CACHE_.__api) return sh.getRange(1, c).getValue();
    const k = "__hdr_" + name;
    if (!REQ_CACHE_[k]) {
        try {
            REQ_CACHE_[k] = sh.getRange(1, 1, 1, cols_(name).length).getValues()[0];
        } catch (e) {
            return sh.getRange(1, c).getValue(); // sheet narrower than the schema — check just this cell, as before
        }
    }
    return REQ_CACHE_[k][c - 1];
}

/** The newest n rows — for lists that show the latest first (logs, batches, movements). */
function tailRows_(name, n) {
    if (REQ_CACHE_[name]) return REQ_CACHE_[name].rows.slice(-n);
    const sh = sheet_(name);
    const keys = cols_(name);
    const last = sh.getLastRow();
    if (last < 2) return [];
    headerCell_(sh, name, keys[keys.length - 1]);
    const start = Math.max(2, last - n + 1);
    return rowsFromValues_(name, sh.getRange(start, 1, last - start + 1, keys.length).getValues(), start);
}

/**
 * One column's values, in sheet order — for "has this branch ever sold anything" style questions.
 * In an app request each column is read once: the sales list and dashboard both ask for Sales.date
 * (the date window, then who each customer's first bill was). Every write to the table forgets it.
 */
function columnValues_(name, field) {
    if (REQ_CACHE_[name]) return REQ_CACHE_[name].rows.map((r) => r[field]);
    const memo = REQ_CACHE_.__api ? (REQ_CACHE_["__col_" + name] = REQ_CACHE_["__col_" + name] || {}) : null;
    if (memo && memo[field]) return memo[field];
    const sh = sheet_(name);
    const last = sh.getLastRow();
    if (last < 2) return [];
    const c = headerCell_(sh, name, field);
    const type = SCHEMA[name][field];
    const vals = sh.getRange(2, c, last - 1, 1).getValues().map((r) => fromCell_(r[0], type));
    if (memo) memo[field] = vals;
    return vals;
}

/** A table was written: drop its cached rows and any columns read from it this request. */
function forgetTable_(name) {
    delete REQ_CACHE_[name];
    delete REQ_CACHE_["__col_" + name];
}

// the cached rows stay (they are kept in step), only the columns read straight off the sheet go
function forgetColumns_(name) {
    delete REQ_CACHE_["__col_" + name];
}

/**
 * The last n rows where `field` equals value — a product's recent stock movements, say.
 *
 * Almost always the answer is in the recent rows, so it reads a tail block first and only goes
 * looking through the column when that turns up nothing (a product last touched long ago).
 */
function lastMatchingRows_(name, field, value, n, tail) {
    if (REQ_CACHE_[name]) return REQ_CACHE_[name].rows.filter((r) => r[field] === value).slice(-n);
    const recent = tailRows_(name, tail || 2000).filter((r) => r[field] === value);
    if (recent.length) return recent.slice(-n);
    const col = columnValues_(name, field);
    let start = -1;
    let found = 0;
    for (let i = col.length - 1; i >= 0 && found < n; i--) {
        if (col[i] !== value) continue;
        found++;
        start = i;
    }
    if (start < 0) return [];
    const sh = sheet_(name);
    const keys = cols_(name);
    const first = start + 2;
    return rowsFromValues_(name, sh.getRange(first, 1, col.length - start, keys.length).getValues(), first)
        .filter((r) => r[field] === value)
        .slice(-n);
}

/** One row by id, without reading the whole table to find it. */
function findById_(name, id) {
    const n = Number(id);
    if (!n) return null;
    const hit = windowRows_(name, "id", n, n);
    return hit.length ? hit[0] : null;
}

/**
 * The rows whose `field` falls between from and to (inclusive), read as one block.
 *
 * The block runs from the first matching row to the last, so rows that are out of order — a
 * back-dated import, a sheet someone sorted by hand — are still all inside it and nothing is
 * missed; the worst case is simply the whole table, which is what it read before anyway.
 */
function windowRows_(name, field, from, to) {
    // "2026-09-23 12:00:00" has to count as inside a range that ends on "2026-09-23", so a text value
    // is compared only as far as the bound is long. Numbers (an id window) compare as they are.
    const cut = (v, bound) => (typeof v === "string" && typeof bound === "string" ? v.slice(0, bound.length) : v);
    const within = (v0) => {
        const v = v0 instanceof Date ? fmtDateTime_(v0) : v0;
        if (from !== null && from !== undefined && cut(v, from) < from) return false;
        if (to !== null && to !== undefined && cut(v, to) > to) return false;
        return true;
    };
    if (REQ_CACHE_[name]) return REQ_CACHE_[name].rows.filter((r) => within(r[field]));
    const col = columnValues_(name, field);
    let first = -1;
    let last = -1;
    for (let i = 0; i < col.length; i++) {
        if (!within(col[i])) continue;
        if (first < 0) first = i;
        last = i;
    }
    if (first < 0) return [];
    const sh = sheet_(name);
    const keys = cols_(name);
    const start = first + 2; // +1 for the header, +1 for 1-based rows
    const rows = rowsFromValues_(name, sh.getRange(start, 1, last - first + 1, keys.length).getValues(), start);
    return rows.filter((r) => within(r[field]));
}

function indexBy_(rows, key) {
    const m = {};
    for (let i = 0; i < rows.length; i++) m[rows[i][key]] = rows[i];
    return m;
}

function findBy_(name, key, val) {
    const rows = rows_(name);
    for (let i = 0; i < rows.length; i++) if (rows[i][key] == val) return rows[i];
    return null;
}

/**
 * Next id. Rows are only ever appended with an id one higher than the last, so the last row holds the
 * highest id — reading that one cell keeps saving a bill fast however many bills the shop has.
 * Anything unexpected falls back to scanning the table.
 */
function nextId_(name) {
    if (!REQ_CACHE_[name]) {
        const keys = cols_(name);
        const col = keys.indexOf("id") + 1;
        if (col > 0) {
            const sh = sheet_(name);
            const last = sh.getLastRow();
            if (last < 2) return 1; // header only
            const v = sh.getRange(last, col).getValue();
            const n = typeof v === "number" ? v : parseFloat(v);
            if (n > 0) return Math.floor(n) + 1;
        }
    }
    const rows = rows_(name);
    let max = 0;
    for (let i = 0; i < rows.length; i++) if (rows[i].id > max) max = rows[i].id;
    return max + 1;
}

function rowArray_(name, obj) {
    const schema = SCHEMA[name];
    return Object.keys(schema).map((k) => toCell_(obj[k], schema[k]));
}

// [start,len] runs of 1-based text (non-numeric) column positions
function textColRuns_(name) {
    const schema = SCHEMA[name];
    const keys = Object.keys(schema);
    const runs = [];
    keys.forEach((k, i) => {
        if (schema[k] === "n") return;
        const last = runs[runs.length - 1];
        if (last && last[0] + last[1] === i + 1) last[1]++;
        else runs.push([i + 1, 1]);
    });
    return runs;
}

// plain-text format keeps leading zeros in barcodes/phones and stops date auto-parsing
function formatTextCols_(sh, name, startRow, numRows) {
    textColRuns_(name).forEach(([c, len]) => sh.getRange(startRow, c, numRows, len).setNumberFormat("@"));
}

function ensureRows_(sh, needLast) {
    const max = sh.getMaxRows();
    if (needLast > max) sh.insertRowsAfter(max, needLast - max + 200);
}

/**
 * Append objects (ids must already be set). If the table hasn't been read in this request the rows are
 * written straight away — no need to read thousands of existing rows just to add a few.
 */
function appendRows_(name, objs) {
    if (!objs.length) return;
    forgetColumns_(name);
    const cached = REQ_CACHE_[name] || null;
    const sh = cached ? cached.sh : sheet_(name);
    const keys = cached ? cached.keys : cols_(name);
    const start = sh.getLastRow() + 1;
    ensureRows_(sh, start + objs.length - 1);
    formatTextCols_(sh, name, start, objs.length);
    sh.getRange(start, 1, objs.length, keys.length).setValues(objs.map((o) => rowArray_(name, o)));
    if (!cached) return; // nothing cached to keep in step; a later read picks the rows up
    objs.forEach((o, i) => {
        const copy = Object.assign({}, o, { _r: start + i });
        keys.forEach((k) => {
            if (copy[k] === undefined) copy[k] = SCHEMA[name][k] === "n" ? 0 : "";
        });
        cached.rows.push(copy);
    });
}

/**
 * A record as a read of it would come back right after appendRows_ wrote it: every schema column
 * present, blanks as 0 or "" — the same filling appendRows_ gives the copies it keeps in the cache.
 */
function asStored_(name, obj) {
    const schema = SCHEMA[name];
    const copy = Object.assign({}, obj);
    Object.keys(schema).forEach((k) => {
        if (copy[k] === undefined) copy[k] = schema[k] === "n" ? 0 : "";
    });
    return copy;
}

/**
 * The record at sheet row r, if that row still holds this id — read as one row instead of the whole
 * table. null when it doesn't (the sheet was sorted or rows deleted by hand, or the row can't be read):
 * the caller then looks the id up the old way.
 */
function rowIfId_(name, r, id) {
    if (!r || r < 2) return null;
    try {
        const vals = sheet_(name).getRange(r, 1, 1, cols_(name).length).getValues();
        const row = rowsFromValues_(name, vals, r)[0];
        return row && row.id === Number(id) ? row : null;
    } catch (e) {
        return null;
    }
}

/**
 * Write one field of a record at its row (`_r`) without reading the table — the same cell and the same
 * value updateFields_ writes. Like readTable_, it first checks the sheet's last header, so a sheet that
 * needs Setup still says so.
 */
function setCell_(name, obj, field) {
    forgetColumns_(name);
    const keys = cols_(name);
    const c = keys.indexOf(field) + 1;
    if (c < 1) throw new Error("Unknown column " + field);
    const sh = sheet_(name);
    headerCell_(sh, name, keys[keys.length - 1]);
    sh.getRange(obj._r, c).setValue(toCell_(obj[field], SCHEMA[name][field]));
    const t = REQ_CACHE_[name];
    if (t) t.rows.forEach((row) => row._r === obj._r && (row[field] = obj[field])); // keep a cached copy in step
}

/** Write back full records that carry `_r`. */
function updateRows_(name, objs) {
    forgetColumns_(name);
    const t = readTable_(name);
    objs.forEach((o) => {
        if (!o._r) throw new Error("updateRows_ needs _r");
        t.sh.getRange(o._r, 1, 1, t.keys.length).setValues([rowArray_(name, o)]);
    });
}

/**
 * Write back many full records in ONE call: the span from the first to the last changed row is
 * rewritten from the (fresh, locked) table cache. Blank rows inside the span stay blank.
 */
function updateRowsBatch_(name, objs) {
    if (!objs.length) return;
    forgetColumns_(name);
    const t = readTable_(name);
    const byRow = {};
    t.rows.forEach((o) => (byRow[o._r] = o));
    objs.forEach((o) => {
        if (!o._r) throw new Error("updateRowsBatch_ needs _r");
        byRow[o._r] = o;
    });
    const first = Math.min.apply(null, objs.map((o) => o._r));
    const last = Math.max.apply(null, objs.map((o) => o._r));
    const blank = t.keys.map(() => "");
    const vals = [];
    for (let r = first; r <= last; r++) vals.push(byRow[r] ? rowArray_(name, byRow[r]) : blank);
    t.sh.getRange(first, 1, vals.length, t.keys.length).setValues(vals);
}

/** Update single columns for many records: [{_r, ...fields}] — one call per cell. */
function updateFields_(name, obj, fields) {
    forgetColumns_(name);
    const t = readTable_(name);
    fields.forEach((f) => {
        const c = t.keys.indexOf(f);
        if (c < 0) throw new Error("Unknown column " + f);
        t.sh.getRange(obj._r, c + 1).setValue(toCell_(obj[f], SCHEMA[name][f]));
    });
}

/**
 * Batch-write one numeric column for several records in as few calls as possible
 * (contiguous row runs are written together).
 */
function writeColumn_(name, records, field) {
    if (!records.length) return;
    forgetColumns_(name);
    const t = readTable_(name);
    const c = t.keys.indexOf(field) + 1;
    const sorted = records.slice().sort((a, b) => a._r - b._r);
    let run = [sorted[0]];
    const flush = () => {
        t.sh.getRange(run[0]._r, c, run.length, 1).setValues(run.map((r) => [toCell_(r[field], SCHEMA[name][field])]));
    };
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i]._r === run[run.length - 1]._r + 1) run.push(sorted[i]);
        else {
            flush();
            run = [sorted[i]];
        }
    }
    flush();
}

function deleteRow_(name, obj) {
    const t = readTable_(name);
    t.sh.deleteRow(obj._r);
    forgetTable_(name); // row numbers shifted
}

function withLock_(fn) {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(20000)) throw new AppError_("Server busy, please try again.");
    try {
        // re-read fresh data inside the lock
        rereadRows_();
        return fn();
    } finally {
        SpreadsheetApp.flush();
        lock.releaseLock();
    }
}

/* ---------- dates (IST) ---------- */

function fmtDateTime_(d) {
    return Utilities.formatDate(d || new Date(), APP.TZ, "yyyy-MM-dd HH:mm:ss");
}

function fmtDate_(d) {
    return Utilities.formatDate(d || new Date(), APP.TZ, "yyyy-MM-dd");
}

function nowStr_() {
    return fmtDateTime_(new Date());
}

function todayStr_() {
    return fmtDate_(new Date());
}

// "yyyy-MM-dd" n days before today (IST)
function daysAgoStr_(n) {
    return fmtDate_(new Date(Date.now() - n * 86400000));
}

/* ---------- misc ---------- */

function AppError_(message, code) {
    this.message = message;
    this.code = code || "ERROR";
    this.isAppError = true;
}

function fail_(message, code) {
    throw new AppError_(message, code);
}

function r2_(x) {
    return Math.round((Number(x) + Number.EPSILON) * 100) / 100;
}

function r3_(x) {
    return Math.round((Number(x) + Number.EPSILON) * 1000) / 1000;
}

function str_(v) {
    return v === null || v === undefined ? "" : String(v).trim();
}

function num_(v, def) {
    const n = parseFloat(v);
    return isNaN(n) ? (def === undefined ? 0 : def) : n;
}

function pad_(n, len) {
    let s = String(n);
    while (s.length < len) s = "0" + s;
    return s;
}

function uuid_() {
    return Utilities.getUuid().replace(/-/g, "");
}

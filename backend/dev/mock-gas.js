/**
 * Minimal in-memory Google Apps Script environment for running the backend in Node.
 * Emulates the Sheets behaviours that matter: auto-conversion of numeric/date strings
 * in non-text cells, plain-text ("@") cells keeping strings, row/column bounds.
 * Dev-only — not pushed to Apps Script.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");

class Range {
    constructor(sheet, r, c, nr, nc) {
        if (r < 1 || c < 1 || r + nr - 1 > sheet.maxRows || c + nc - 1 > sheet.maxCols)
            throw new Error(`Range ${r},${c},${nr},${nc} outside sheet ${sheet.name} (${sheet.maxRows}x${sheet.maxCols})`);
        Object.assign(this, { sheet, r, c, nr, nc });
    }
    getValues() {
        const out = [];
        for (let i = 0; i < this.nr; i++) {
            const row = [];
            for (let j = 0; j < this.nc; j++) {
                const v = this.sheet.cell(this.r + i, this.c + j).v;
                row.push(v === undefined ? "" : v);
            }
            out.push(row);
        }
        return out;
    }
    setValues(vals) {
        if (vals.length !== this.nr || vals.some((r) => r.length !== this.nc))
            throw new Error(`setValues dims mismatch on ${this.sheet.name}: range ${this.nr}x${this.nc}, data ${vals.length}x${vals[0] && vals[0].length}`);
        vals.forEach((row, i) => row.forEach((v, j) => this.sheet.write(this.r + i, this.c + j, v)));
        return this;
    }
    getValue() {
        const v = this.sheet.cell(this.r, this.c).v;
        return v === undefined ? "" : v;
    }
    setValue(v) {
        this.sheet.write(this.r, this.c, v);
        return this;
    }
    clearContent() {
        for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sheet.cell(this.r + i, this.c + j).v = ""; // keeps formats
        return this;
    }
    setNumberFormat(f) {
        for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sheet.cell(this.r + i, this.c + j).fmt = f;
        return this;
    }
    setFontWeight() { return this; }
    setBackground() { return this; }
    setFontColor() { return this; }
}

class Sheet {
    constructor(name) {
        this.name = name;
        this.maxRows = 1000;
        this.maxCols = 26;
        this.cells = new Map(); // "r,c" -> {v, fmt}
    }
    cell(r, c) {
        const k = r + "," + c;
        if (!this.cells.has(k)) this.cells.set(k, { v: "", fmt: "" });
        return this.cells.get(k);
    }
    write(r, c, v) {
        const cell = this.cell(r, c);
        if (typeof v === "string" && cell.fmt !== "@") {
            if (v.startsWith("'")) v = v.slice(1);
            else if (v.startsWith("=")) throw new Error("Formula written to sheet: " + v);
            else if (/^-?\d+(\.\d+)?$/.test(v.trim())) v = Number(v); // Sheets auto-converts
            else if (/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(v)) v = new Date(v.replace(" ", "T") + "+05:30");
        } else if (typeof v === "string" && v.startsWith("'")) v = v.slice(1);
        cell.v = v;
    }
    getName() { return this.name; }
    getLastRow() {
        let last = 0;
        for (const [k, cell] of this.cells) if (cell.v !== "" && cell.v !== undefined) last = Math.max(last, +k.split(",")[0]);
        return last;
    }
    getLastColumn() {
        let last = 0;
        for (const [k, cell] of this.cells) if (cell.v !== "" && cell.v !== undefined) last = Math.max(last, +k.split(",")[1]);
        return last;
    }
    getMaxRows() { return this.maxRows; }
    getMaxColumns() { return this.maxCols; }
    insertRowsAfter(after, n) {
        const moved = new Map();
        for (const [k, cell] of this.cells) {
            const [r, c] = k.split(",").map(Number);
            moved.set((r > after ? r + n : r) + "," + c, cell);
        }
        // new rows inherit the format of the row above
        for (let i = 1; i <= n; i++)
            for (let c = 1; c <= this.maxCols; c++) {
                const above = moved.get(after + "," + c);
                if (above && above.fmt) moved.set(after + i + "," + c, { v: "", fmt: above.fmt });
            }
        this.cells = moved;
        this.maxRows += n;
    }
    deleteRow(r) {
        const moved = new Map();
        for (const [k, cell] of this.cells) {
            const [rr, c] = k.split(",").map(Number);
            if (rr === r) continue;
            moved.set((rr > r ? rr - 1 : rr) + "," + c, cell);
        }
        this.cells = moved;
        this.maxRows -= 1;
    }
    deleteColumns(c0, n) {
        for (const k of [...this.cells.keys()]) if (+k.split(",")[1] >= c0) this.cells.delete(k);
        this.maxCols -= n;
    }
    insertColumnsAfter(after, n) {
        const moved = new Map();
        for (const [k, cell] of this.cells) {
            const [r, c] = k.split(",").map(Number);
            moved.set(r + "," + (c > after ? c + n : c), cell);
        }
        this.cells = moved;
        this.maxCols += n;
    }
    setFrozenRows() {}
    getRange(r, c, nr = 1, nc = 1) { return new Range(this, r, c, nr, nc); }
}

class Spreadsheet {
    constructor() { this.sheets = [new Sheet("Sheet1")]; }
    getName() { return "Groovy POS Data"; }
    getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
    getId() { return "SHEET_FILE"; }
    insertSheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; }
    getSheets() { return this.sheets.slice(); }
    deleteSheet(s) { this.sheets = this.sheets.filter((x) => x !== s); }
}

function formatDate(d, tz, pattern) {
    const parts = {};
    new Intl.DateTimeFormat("en-GB", {
        timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(d).forEach((p) => (parts[p.type] = p.value));
    return pattern
        .replace("yyyy", parts.year).replace("MM", parts.month).replace("dd", parts.day)
        .replace("HH", parts.hour).replace("mm", parts.minute).replace("ss", parts.second);
}

// tiny in-memory Drive: folders, files (PDF blobs keep their HTML for tests)
function createDrive() {
    let seq = 0;
    const items = new Map();
    const iter = (list) => { let i = 0; return { hasNext: () => i < list.length, next: () => list[i++] }; };
    const children = (f, kind) => [...items.values()].filter((x) => x.parent === f && x.kind === kind && !x.trashed);
    const make = (kind, name, parent, extra) => {
        const id = (kind === "folder" ? "FOLDER" : "FILE") + ++seq;
        const o = Object.assign({ id, kind, name, parent, trashed: false }, extra);
        o.getId = () => o.id; o.getName = () => o.name; o.setName = (n) => ((o.name = n), o);
        o.isTrashed = () => o.trashed; o.setTrashed = (t) => ((o.trashed = t), o);
        o.getParents = () => iter(o.parent ? [o.parent] : []);
        o.getUrl = () => "https://drive.google.com/" + (kind === "folder" ? "drive/folders/" : "file/d/") + o.id + "/view";
        o.getBlob = () => ({ getDataAsString: () => String(o.html === undefined ? "" : o.html) });
        if (kind === "folder") {
            o.getFoldersByName = (n) => iter(children(o, "folder").filter((x) => x.name === n));
            o.getFilesByName = (n) => iter(children(o, "file").filter((x) => x.name === n));
            o.createFolder = (n) => make("folder", n, o);
            o.createFile = (a, b) =>
                // a blob, or (name, contents) — both forms are used by the app
                typeof a === "string" ? make("file", a, o, { mime: "text/plain", html: String(b) }) : make("file", a.name, o, { mime: a.mime, html: a.html });
            o.getFiles = () => iter(children(o, "file"));
            o.getFolders = () => iter(children(o, "folder"));
        }
        // a copy is a new item with the same contents; the Sheet copies as an ordinary file
        o.makeCopy = (n, dest) => make(o.kind === "folder" ? "folder" : "file", n || o.name, dest || o.parent, { mime: o.mime, html: o.html });
        o.moveTo = (f) => ((o.parent = f), o);
        o.setSharing = () => o;
        items.set(o.id, o);
        return o;
    };
    const root = make("folder", "My Drive", null);
    const sheetFile = make("file", "Groovy POS Data", root);
    items.delete(sheetFile.id);
    sheetFile.id = "SHEET_FILE";
    items.set("SHEET_FILE", sheetFile);
    const byId = (id) => { const o = items.get(id); if (!o) throw new Error("No item with the given ID: " + id); return o; };
    const api = {
        getRootFolder: () => root,
        getFileById: byId,
        getFolderById: byId,
        getFoldersByName: (n) => iter([...items.values()].filter((x) => x.kind === "folder" && x.name === n && !x.trashed)),
        createFolder: (n) => make("folder", n, root),
        Access: { ANYONE_WITH_LINK: "anyone" }, Permission: { VIEW: "view" },
    };
    return { api, items, root, sheetFile, make, files: () => [...items.values()].filter((x) => x.kind === "file" && x.id !== "SHEET_FILE") };
}

function createEnv() {
    const ss = new Spreadsheet();
    const drive = createDrive();
    const props = new Map();
    const cache = new Map();
    const cacheTtl = new Map(); // seconds each entry was kept for (Google's default is 600)
    // time passing: drops what Google would have dropped after that many seconds
    const expireCache = (sec) => [...cacheTtl].forEach(([k, ttl]) => { if (ttl <= sec) { cache.delete(k); cacheTtl.delete(k); } });
    const mails = [];
    const alerts = [];
    const triggers = [];
    const ctx = {
        console,
        JSON, Math, Date, Number, String, Object, Array, Error, isNaN, parseInt, parseFloat, RegExp,
        SpreadsheetApp: {
            getActiveSpreadsheet: () => ss,
            openById: () => ss,
            flush: () => {},
            getUi: () => { throw new Error("no UI in tests"); },
        },
        Utilities: {
            DigestAlgorithm: { SHA_256: "sha256" },
            Charset: { UTF_8: "utf8" },
            computeDigest: (alg, s) => [...crypto.createHash("sha256").update(String(s), "utf8").digest()],
            base64Encode: (bytes) => Buffer.from(bytes).toString("base64"),
            base64Decode: (s) => [...Buffer.from(s, "base64")],
            getUuid: () => crypto.randomUUID(),
            formatDate,
            newBlob: (data, mime, name) => ({
                html: data, mime, name,
                getAs: (m) => { const b = { html: data, mime: m, name, setName: (n) => ((b.name = n), b) }; return b; },
            }),
        },
        CacheService: {
            getScriptCache: () => ({
                get: (k) => (cache.has(k) ? cache.get(k) : null),
                getAll: (keys) => { const o = {}; keys.forEach((k) => { if (cache.has(k)) o[k] = cache.get(k); }); return o; },
                put: (k, v, ttl) => (cache.set(k, v), cacheTtl.set(k, ttl || 600)),
                putAll: (map, ttl) => Object.keys(map).forEach((k) => (cache.set(k, map[k]), cacheTtl.set(k, ttl || 600))),
                remove: (k) => cache.delete(k),
                removeAll: (keys) => keys.forEach((k) => cache.delete(k)),
            }),
        },
        LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
        PropertiesService: {
            getScriptProperties: () => ({
                getProperty: (k) => (props.has(k) ? props.get(k) : null),
                setProperty: (k, v) => props.set(k, String(v)),
                getProperties: () => Object.fromEntries(props),
                deleteProperty: (k) => (props.delete(k), undefined),
            }),
        },
        Session: { getEffectiveUser: () => ({ getEmail: () => "owner@groovy.test" }) },
        ContentService: {
            MimeType: { JSON: "json" },
            createTextOutput: (s) => ({ content: s, setMimeType() { return this; } }),
        },
        MailApp: { sendEmail: (m) => mails.push(m), getRemainingDailyQuota: () => 100 },
        DriveApp: drive.api,
        ScriptApp: {
            getService: () => ({ getUrl: () => "" }),
            getProjectTriggers: () => triggers.slice(),
            deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
            newTrigger: (fn) => {
                const t = { fn, getHandlerFunction: () => fn };
                const b = {
                    timeBased: () => b, everyDays: (n) => ((t.days = n), b), inTimezone: (z) => ((t.tz = z), b),
                    everyMinutes: (n) => ((t.minutes = n), b),
                    onMonthDay: (d) => ((t.monthDay = d), b),
                    after: (ms) => ((t.afterMs = ms), b),
                    atHour: (h) => ((t.hour = h), b), create: () => (triggers.push(t), t),
                };
                return b;
            },
        },
    };
    vm.createContext(ctx);
    const dir = path.join(__dirname, "..");
    // Apps Script loads files in project order; alphabetical here to prove order-independence
    fs.readdirSync(dir)
        .filter((f) => f.endsWith(".gs"))
        .sort()
        .forEach((f) => vm.runInContext(fs.readFileSync(path.join(dir, f), "utf8"), ctx, { filename: f }));
    vm.runInContext("alert_ = function (m) { __alerts.push(m); };", Object.assign(ctx, { __alerts: alerts }));
    const call = (action, payload, token, branch_id, req_id) => {
        const out = ctx.doPost({ postData: { contents: JSON.stringify({ action, payload, token, branch_id, req_id }) } });
        return JSON.parse(out.content);
    };
    return { ctx, ss, call, mails, alerts, cache, cacheTtl, expireCache, triggers, drive, props };
}

module.exports = { createEnv };

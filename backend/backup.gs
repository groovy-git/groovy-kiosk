/**
 * Backups of the shop: a copy of this Sheet plus the invoice PDFs, into the Back_up folder that sits
 * beside them in Drive.
 *
 *   Back_up/2026-08/              ← made on 1 September, holds August
 *   Back_up/2026-09-25 09-15/     ← made by hand, holds whatever was asked for
 *
 * Two ways in: "Back up now…" in the Groovy Kiosk menu, and a trigger on the 1st of each month at 6am
 * that saves the month just ended. The monthly folder is named for the month it covers, so running it
 * again lands in the same folder and copies nothing twice.
 *
 * A backup can take longer than Apps Script allows in one go, so it is built to be interrupted: a
 * marker file says the folder is unfinished and carries what is left to do, files already copied are
 * skipped, and a one-off trigger picks the job up a minute later. Nothing is remembered anywhere else
 * — Drive itself is the record, as it is for the invoice PDFs.
 *
 * Nothing is ever deleted here.
 */

const BACKUP_ROOT_ = "Back_up";
const BACKUP_FN_ = "monthlyBackup";
const BACKUP_RESUME_FN_ = "resumeBackup";
const BACKUP_BUSY_ = "BACKUP IN PROGRESS.txt";
const BACKUP_DONE_ = "BACKUP COMPLETE.txt";

/** Back_up beside the Sheet, found by name every run for the same reason the invoice folders are. */
function backupRoot_() {
    const parents = DriveApp.getFileById(ss_().getId()).getParents();
    const home = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
    return subFolder_(home, BACKUP_ROOT_);
}

/** "2026-09-25 09-15" — a manual backup is stamped to the minute so several in a day sit side by side. */
function backupStamp_() {
    return Utilities.formatDate(new Date(), APP.TZ, "yyyy-MM-dd HH-mm");
}

/** The month before the one this date falls in, as "yyyy-MM". */
function lastMonthOf_(dateStr) {
    const y = parseInt(String(dateStr).slice(0, 4), 10);
    const m = parseInt(String(dateStr).slice(5, 7), 10);
    return m === 1 ? y - 1 + "-12" : y + "-" + pad_(m - 1, 2);
}

function monthLabel_(ym) {
    const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    return names[parseInt(String(ym).slice(5, 7), 10) - 1] + " " + String(ym).slice(0, 4);
}

function fileNamed_(folder, name) {
    const it = folder.getFilesByName(name);
    return it.hasNext() ? it.next() : null;
}

function fileText_(file) {
    try {
        return file ? file.getBlob().getDataAsString() : "";
    } catch (e) {
        return "";
    }
}

function writeNote_(folder, name, text) {
    const old = fileNamed_(folder, name);
    if (old) old.setTrashed(true);
    folder.createFile(name, text);
}

/** "Months: 2026-08,2026-09" → ["2026-08", "2026-09"] */
function noteLine_(text, key) {
    const m = new RegExp("^" + key + ": (.*)$", "m").exec(String(text || ""));
    return m ? m[1].trim() : "";
}

/**
 * Copy the invoices of one month into the backup, keeping the shape they are filed in
 * (Sales_Invoices/FY 2026-27/08/GST) so a restored folder drops straight back into place.
 * Returns how many files were copied; anything already there is left alone, which is what lets an
 * interrupted backup carry on where it stopped.
 */
function copyInvoiceMonth_(ym, dest, inTime) {
    const fyName = fyFolderName_(ym + "-01");
    const mm = String(ym).slice(5, 7);
    const fyIt = invoiceRoot_().getFoldersByName(fyName);
    if (!fyIt.hasNext()) return 0;
    const monthIt = fyIt.next().getFoldersByName(mm);
    if (!monthIt.hasNext()) return 0;
    const month = monthIt.next();

    let copied = 0;
    const kinds = month.getFolders();
    while (kinds.hasNext() && inTime()) {
        const kind = kinds.next(); // GST / Non-GST
        const to = subFolder_(subFolder_(subFolder_(subFolder_(dest, PDF_ROOT_), fyName), mm), kind.getName());
        const files = kind.getFiles();
        while (files.hasNext() && inTime()) {
            const f = files.next();
            if (fileNamed_(to, f.getName())) continue; // already copied by an earlier run
            f.makeCopy(f.getName(), to);
            copied++;
        }
    }
    return copied;
}

/**
 * Copy the product photos taken in the app.
 *
 * They live in their own folder, made at the top of Drive unless the owner filed it elsewhere
 * (imageFolder_ in [catalog.gs] finds it), and the catalogue only stores a link to each one — so
 * without this a restored shop would come back with its photos pointing at a folder that might no
 * longer exist. Photos imported from the website are links to the website and were never in Drive,
 * so they are not here to copy.
 *
 * Returns how many were copied and whether it got to the end before the time ran out.
 */
function copyImages_(dest, inTime) {
    const from = imageFolder_(false);
    if (!from) return { copied: 0, done: true }; // no photos uploaded from the app
    const to = subFolder_(dest, APP.IMAGE_FOLDER);
    let copied = 0;
    const files = from.getFiles();
    while (files.hasNext()) {
        if (!inTime()) return { copied, done: false };
        const f = files.next();
        if (fileNamed_(to, f.getName())) continue; // already copied by an earlier run
        f.makeCopy(f.getName(), to);
        copied++;
    }
    return { copied, done: true };
}

/** Every month that has invoices, oldest first, as "yyyy-MM". */
function invoiceMonths_() {
    const out = [];
    const fys = invoiceRoot_().getFolders();
    while (fys.hasNext()) {
        const fy = fys.next();
        const m = /^FY (\d{4})-(\d{2})$/.exec(fy.getName());
        if (!m) continue;
        const startYear = parseInt(m[1], 10);
        const months = fy.getFolders();
        while (months.hasNext()) {
            const name = months.next().getName();
            if (!/^\d{2}$/.test(name)) continue;
            // a financial year runs April to March, so Jan-Mar belong to the following calendar year
            out.push((parseInt(name, 10) >= 4 ? startYear : startYear + 1) + "-" + name);
        }
    }
    return out.sort();
}

/**
 * Start or continue a backup in `folder`.
 *
 * The marker file is the whole memory of the job: it lists the months still to do and how many files
 * have been copied so far, so a run that is cut short leaves everything the next one needs.
 */
function backupInto_(folder, months, title, inTime, withImages) {
    const busy = fileNamed_(folder, BACKUP_BUSY_);
    const before = fileText_(busy);
    let copied = parseInt(noteLine_(before, "Copied so far"), 10) || 0;
    let photos = parseInt(noteLine_(before, "Photos so far"), 10) || 0;
    let sheet = false;

    const sheetName = ss_().getName() + " " + folder.getName();
    if (!fileNamed_(folder, sheetName)) {
        DriveApp.getFileById(ss_().getId()).makeCopy(sheetName, folder);
        sheet = true;
    }

    const left = months.slice();
    while (left.length && inTime()) {
        copied += copyInvoiceMonth_(left[0], folder, inTime);
        if (!inTime()) break; // the month may be half done; it stays on the list and is finished next run
        left.shift();
    }

    // photos come last, and only for a full backup; a run that stops part-way through them is not finished
    let imagesLeft = !!withImages;
    if (!left.length && imagesLeft && inTime()) {
        const r = copyImages_(folder, inTime);
        photos += r.copied;
        imagesLeft = !r.done;
    }

    const finished = !left.length && !imagesLeft;
    if (finished) {
        if (busy) busy.setTrashed(true);
        const b = fileNamed_(folder, BACKUP_BUSY_);
        if (b) b.setTrashed(true);
        writeNote_(folder, BACKUP_DONE_, title + "\nFinished: " + nowStr_() + "\nInvoice files: " + copied +
            (withImages ? "\nPhoto files: " + photos : "") + "\nSheet copy: " + sheetName);
        clearBackupResume_();
    } else {
        writeNote_(folder, BACKUP_BUSY_, title + "\nMonths: " + left.join(",") + "\nImages: " + (imagesLeft ? "yes" : "no") +
            "\nCopied so far: " + copied + "\nPhotos so far: " + photos +
            "\nStarted: " + (noteLine_(before, "Started") || nowStr_()) +
            "\nStill running — it carries on by itself. Leave this folder alone until it says COMPLETE.");
        scheduleBackupResume_();
    }
    return { sheet, invoices: copied, photos, finished };
}

/** A one-off trigger a minute from now, to carry on where this run stopped. */
function scheduleBackupResume_() {
    try {
        clearBackupResume_();
        ScriptApp.newTrigger(BACKUP_RESUME_FN_).timeBased().after(60 * 1000).create();
    } catch (e) {
        console.error("scheduleBackupResume_", e);
    }
}

function clearBackupResume_() {
    try {
        ScriptApp.getProjectTriggers()
            .filter((t) => t.getHandlerFunction() === BACKUP_RESUME_FN_)
            .forEach((t) => ScriptApp.deleteTrigger(t));
    } catch (e) {
        console.error("clearBackupResume_", e);
    }
}

/** The oldest backup folder that was left unfinished, if there is one. */
function unfinishedBackup_() {
    const folders = backupRoot_().getFolders();
    const waiting = [];
    while (folders.hasNext()) {
        const f = folders.next();
        if (fileNamed_(f, BACKUP_BUSY_)) waiting.push(f);
    }
    waiting.sort((a, b) => (a.getName() < b.getName() ? -1 : 1));
    return waiting.length ? waiting[0] : null;
}

function backupBudget_() {
    const started = Date.now();
    return () => Date.now() - started < 4 * 60 * 1000; // Apps Script stops at 6 minutes
}

/* ---------- the three ways a backup starts ---------- */

/** Trigger: the 1st of the month at 6am — the month that just ended. */
function monthlyBackup() {
    resetReqCache_();
    PDF_DIRS_ = {};
    const ym = lastMonthOf_(todayStr_());
    try {
        const folder = subFolder_(backupRoot_(), ym);
        const r = backupInto_(folder, [ym], "Monthly backup of " + monthLabel_(ym), backupBudget_());
        logBackup_("Monthly backup " + ym, r);
        return r;
    } catch (e) {
        backupFailed_("Monthly backup of " + monthLabel_(ym), e);
        throw e;
    }
}

/** Trigger: carry on a backup that ran out of time. */
function resumeBackup() {
    resetReqCache_();
    PDF_DIRS_ = {};
    const folder = unfinishedBackup_();
    if (!folder) {
        clearBackupResume_();
        return null;
    }
    const note = fileText_(fileNamed_(folder, BACKUP_BUSY_));
    const months = noteLine_(note, "Months").split(",").map((s) => s.trim()).filter(Boolean);
    const title = String(note).split("\n")[0] || "Backup " + folder.getName();
    try {
        const r = backupInto_(folder, months, title, backupBudget_(), noteLine_(note, "Images") === "yes");
        if (r.finished) logBackup_("Backup finished " + folder.getName(), r);
        return r;
    } catch (e) {
        backupFailed_("Backup " + folder.getName(), e);
        throw e;
    }
}

/** Menu: back up now, asking what to include. */
function backupNow() {
    const ui = SpreadsheetApp.getUi();
    const r = ui.alert(
        "Back up now",
        "A copy of this sheet goes into the Back_up folder, with the invoice PDFs.\n\n" +
            "YES — everything, every invoice ever made (slower; use it for a full snapshot)\n" +
            "NO — this month's invoices only\n\n" +
            "Nothing is deleted, and the app keeps working while it runs.",
        ui.ButtonSet.YES_NO_CANCEL,
    );
    if (r !== ui.Button.YES && r !== ui.Button.NO) {
        alert_("Nothing was changed.");
        return;
    }
    const name = backupStamp_();
    try {
        resetReqCache_();
        PDF_DIRS_ = {};
        const all = r === ui.Button.YES;
        const months = all ? invoiceMonths_() : [todayStr_().slice(0, 7)];
        const folder = subFolder_(backupRoot_(), name);
        // a full backup also takes the product photos; a month's backup leaves them, since they
        // rarely change and would otherwise be stored again every time
        const res = backupInto_(folder, months, all ? "Full backup" : "Backup of " + monthLabel_(months[0]), backupBudget_(), all);
        logBackup_("Backup " + name, res);
        alert_(
            "Backup folder: Back_up/" + name + "\n\n" +
                (res.sheet ? "Sheet copied.\n" : "Sheet copy was already there.\n") +
                res.invoices + " invoice files copied.\n" +
                (all ? res.photos + " product photos copied.\n" : "") + "\n" +
                (res.finished
                    ? "Finished — the folder says BACKUP COMPLETE."
                    : "Still running. It carries on by itself in about a minute; the folder says BACKUP IN PROGRESS until it is done."),
        );
    } catch (e) {
        backupFailed_("Backup " + name, e);
        alert_("The backup could not finish:\n\n" + (e.message || e) + "\n\nNothing was lost — your data and invoices are untouched.");
    }
}

/**
 * Menu: run what the 1st-of-the-month job runs, for the month just ended.
 * Also the way to redo a month whose backup failed — running it again only adds what is missing.
 */
function backupLastMonth() {
    const ym = lastMonthOf_(todayStr_());
    const ui = SpreadsheetApp.getUi();
    const ask = ui.alert(
        "Back up " + monthLabel_(ym),
        "Copies this sheet and " + monthLabel_(ym) + "'s invoices into Back_up/" + ym + ".\n\n" +
            "This is exactly what the backup on the 1st of the month does, so it is also the way to redo a month.\n" +
            "Anything already in that folder is left alone.\n\nContinue?",
        ui.ButtonSet.YES_NO,
    );
    if (ask !== ui.Button.YES) {
        alert_("Nothing was changed.");
        return;
    }
    try {
        const res = monthlyBackup();
        alert_(
            "Backup folder: Back_up/" + ym + "\n\n" +
                (res.sheet ? "Sheet copied.\n" : "Sheet copy was already there.\n") +
                res.invoices + " invoice files copied.\n\n" +
                (res.finished
                    ? "Finished — the folder says BACKUP COMPLETE."
                    : "Still running. It carries on by itself in about a minute."),
        );
    } catch (e) {
        alert_("The backup could not finish:\n\n" + (e.message || e) + "\n\nNothing was lost — your data and invoices are untouched.");
    }
}

/* ---------- telling you about it ---------- */

function logBackup_(what, r) {
    log_({ user: { id: 0, name: "Backup" } }, "BACKUP", "Drive", "",
        what + ": " + r.invoices + " invoice files" + (r.photos ? " + " + r.photos + " photos" : "") +
            (r.sheet ? " + sheet" : "") + (r.finished ? "" : " (still running)"));
}

function backupFailed_(what, e) {
    const msg = (e && e.message) || String(e);
    log_({ user: { id: 0, name: "Backup" } }, "BACKUP_FAILED", "Drive", "", what + ": " + msg);
    try {
        const to = reportRecipients_();
        if (!to.length) return;
        const biz = setting_("business_name") || "Groovy Fragrances";
        sendMail_(
            to,
            {
                subject: biz + " — backup did not finish",
                text: what + " could not finish:\n\n" + msg + "\n\nNothing was lost; your data and invoices are untouched. " +
                    "The next attempt runs on the 1st, or use Groovy Kiosk → Back up now in the sheet.",
                html: '<div style="font-family:Arial,Helvetica,sans-serif"><p><b>' + escHtml_(what) + "</b> could not finish:</p>" +
                    '<p style="color:#C62828">' + escHtml_(msg) + "</p><p>Nothing was lost; your data and invoices are untouched. " +
                    "The next attempt runs on the 1st, or use <b>Groovy Kiosk → Back up now</b> in the sheet.</p></div>",
            },
            {},
        );
    } catch (mailErr) {
        console.error("backupFailed_ mail", mailErr);
    }
}

/* ---------- what a reset clears in Drive ---------- */

/**
 * The newest finished backup, by folder name, or "" if there has never been one.
 * Shown before a reset so nobody erases the shop without knowing what they still have.
 */
function lastBackupLabel_() {
    const folders = backupRoot_().getFolders();
    let newest = "";
    while (folders.hasNext()) {
        const f = folders.next();
        if (!fileNamed_(f, BACKUP_DONE_)) continue; // half-finished ones do not count
        if (f.getName() > newest) newest = f.getName();
    }
    return newest;
}

/**
 * Move the invoice PDFs to Drive's bin, keeping the Sales_Invoices folder itself.
 *
 * A reset restarts bill numbers at 00001, so the old PDFs would otherwise share their names with the
 * new bills — two different invoices called GF-26-27-00001.pdf in one folder. The year folders go as
 * a whole, which is one move each rather than one per file. Backups are elsewhere and are untouched.
 */
function trashInvoiceFiles_() {
    const root = invoiceRoot_();
    const years = root.getFolders();
    let gone = 0;
    while (years.hasNext()) {
        years.next().setTrashed(true);
        gone++;
    }
    const loose = root.getFiles(); // anything sitting directly in Sales_Invoices
    while (loose.hasNext()) {
        loose.next().setTrashed(true);
    }
    PDF_DIRS_ = {}; // the folders just went; do not hand a trashed one to the next PDF
    return gone;
}

/** Move the product photos to Drive's bin, keeping the folder so the next upload still works. */
function trashProductImages_(inTime) {
    const folder = imageFolder_(false);
    if (!folder) return 0;
    const files = folder.getFiles();
    let gone = 0;
    while (files.hasNext()) {
        if (inTime && !inTime()) break; // a big library finishes on the next run
        files.next().setTrashed(true);
        gone++;
    }
    return gone;
}

/** How many photos there are, for the warning before a reset. */
function countProductImages_() {
    const folder = imageFolder_(false);
    if (!folder) return 0;
    const files = folder.getFiles();
    let n = 0;
    while (files.hasNext()) {
        files.next();
        n++;
    }
    return n;
}

/** Installs the monthly trigger if it is missing. Cheap enough to call from the 15-minute timer. */
function ensureBackupTrigger_() {
    const have = ScriptApp.getProjectTriggers().filter((t) => t.getHandlerFunction() === BACKUP_FN_);
    if (have.length) return false;
    ScriptApp.newTrigger(BACKUP_FN_).timeBased().onMonthDay(1).atHour(6).inTimezone(APP.TZ).create();
    return true;
}

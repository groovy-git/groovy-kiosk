/**
 * Spare rows: every table keeps a stock of empty rows below its data, topped up at night.
 *
 * When one save made a sheet bigger (added rows) while others were saving, Google went on showing
 * those other saves the sheet as it was before — its size and even which rows held data — for a few
 * seconds, lock or no lock. They then wrote over rows that had just been filled, or into rows that
 * weren't there. In a 12-person stress test that never happened on a sheet that kept its size, so the
 * size is kept still during the day: the empty rows are already there, and a save only fills them.
 * A shop adds a few hundred rows a day; 5,000 spare rows last weeks, and the night tops them up.
 */
const SPARE_ROWS_ = 5000; // topped up to this many empty rows…
const SPARE_LOW_ = 2000; // …once fewer than this are left
const MAINT_FN_ = "nightlyMaintenance";

/** Top every table up to SPARE_ROWS_ empty rows. Returns {table: rows added} for the ones that needed it. */
function topUpSpareRows_() {
    const added = {};
    Object.keys(SCHEMA).forEach((name) => {
        const sh = sheet_(name);
        const last = sh.getLastRow();
        const max = sh.getMaxRows();
        const spare = max - last;
        if (spare >= SPARE_LOW_) return;
        // under the last row with data, so nothing is ever split; a table with no data yet grows at the
        // bottom instead, so the new rows don't copy the header's look
        sh.insertRowsAfter(last >= 2 ? last : max, SPARE_ROWS_ - spare);
        added[name] = SPARE_ROWS_ - spare;
    });
    return added;
}

/** Timer, every night: the only time sheets grow, while nobody is saving. */
function nightlyMaintenance() {
    resetReqCache_();
    const added = withLock_(() => topUpSpareRows_());
    if (Object.keys(added).length) console.log("Spare rows added: " + JSON.stringify(added));
}

function ensureMaintenanceTrigger_() {
    const have = ScriptApp.getProjectTriggers().filter((t) => t.getHandlerFunction() === MAINT_FN_);
    if (have.length) return false;
    ScriptApp.newTrigger(MAINT_FN_).timeBased().everyDays(1).atHour(3).inTimezone(APP.TZ).create();
    return true;
}

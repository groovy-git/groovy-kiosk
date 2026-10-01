/**
 * Web API. The phone app POSTs {action, token, payload} as text/plain JSON
 * (text/plain avoids a CORS preflight, which Apps Script cannot answer).
 * Every action is listed here with the roles allowed to call it — the role always
 * comes from the server-side session, never from the request.
 */

const A_ = ["owner"];
const AM_ = ["owner", "manager"];
const ALL_ = ["owner", "manager", "salesperson"];
// The stock mover is on none of the lists above, so every action refuses them unless it is given one
// of the two lists below — a new action is closed to them until someone opens it on purpose.
const MOVER_ = "stock_mover";
const SIGNED_IN_ = ALL_.concat([MOVER_]); // logging in and seeing products + stock
const AM_MOVER_ = AM_.concat([MOVER_]); // moving stock between branches, and adjusting it

// built lazily: Apps Script evaluates files in load order, so top-level code
// must not reference functions from other files
let ACTIONS_CACHE_ = null;
function actions_() {
    if (ACTIONS_CACHE_) return ACTIONS_CACHE_;
    ACTIONS_CACHE_ = {
    // public
    ping: { fn: () => ({ data: { time: nowStr_() } }), public: true },
    login: { fn: apiLogin_, public: true },
    forgotPassword: { fn: apiForgotPassword_, public: true },
    resetPassword: { fn: apiResetPassword_, public: true },

    // everyone logged in, the stock mover included
    bootstrap: { fn: apiBootstrap_, roles: SIGNED_IN_ },
    me: { fn: apiMe_, roles: SIGNED_IN_ },
    logout: { fn: apiLogout_, roles: SIGNED_IN_ },
    changePassword: { fn: apiChangePassword_, roles: SIGNED_IN_ },
    getSettings: { fn: apiGetSettings_, roles: SIGNED_IN_ },
    getCatalog: { fn: apiGetCatalog_, roles: SIGNED_IN_ },
    getStock: { fn: apiGetStock_, roles: SIGNED_IN_ },

    // everyone who sells
    listSellers: { fn: apiListSellers_, roles: ALL_ },
    findCustomer: { fn: apiFindCustomer_, roles: ALL_ },
    listCustomers: { fn: apiListCustomers_, roles: ALL_ },
    saveCustomer: { fn: apiSaveCustomer_, roles: ALL_ },
    customerHistory: { fn: apiCustomerHistory_, roles: ALL_ },
    completeSale: { fn: apiCompleteSale_, roles: ALL_ },
    listSales: { fn: apiListSales_, roles: ALL_ },
    getSale: { fn: apiGetSale_, roles: ALL_ },
    holdBill: { fn: apiHoldBill_, roles: ALL_ },
    listHeld: { fn: apiListHeld_, roles: ALL_ },
    deleteHeld: { fn: apiDeleteHeld_, roles: ALL_ },
    dashboard: { fn: apiDashboard_, roles: ALL_ },
    report: { fn: apiReport_, roles: ALL_ }, // per-report check inside
    movements: { fn: apiMovements_, roles: ALL_ },
    emailDayClose: { fn: apiEmailDayClose_, roles: ALL_ }, // salesperson gets own figures only

    // owner + manager
    saveBrand: { fn: apiSaveBrand_, roles: AM_ },
    saveCategory: { fn: apiSaveCategory_, roles: AM_ },
    deleteCategory: { fn: apiDeleteCategory_, roles: A_ },
    saveProduct: { fn: apiSaveProduct_, roles: AM_ },
    toggleProduct: { fn: apiToggleProduct_, roles: AM_ },
    deleteProduct: { fn: apiDeleteProduct_, roles: A_ },
    saveInvoicePdf: { fn: apiSaveInvoicePdf_, roles: ALL_ },
    generateBarcode: { fn: apiGenerateBarcode_, roles: AM_ },
    generateSku: { fn: apiGenerateSku_, roles: AM_ },
    uploadImage: { fn: apiUploadImage_, roles: AM_ },
    importCatalog: { fn: apiImportCatalog_, roles: AM_ },
    stockIn: { fn: apiStockIn_, roles: AM_ },
    stockInBatches: { fn: apiStockInBatches_, roles: AM_ },
    adjustStock: { fn: apiAdjustStock_, roles: AM_MOVER_ },
    transferStock: { fn: apiTransferStock_, roles: AM_MOVER_ },
    listTransfers: { fn: apiListTransfers_, roles: AM_MOVER_ },
    voidSale: { fn: apiVoidSale_, roles: AM_ },
    returnItems: { fn: apiReturnItems_, roles: ALL_ }, // a salesperson is held to salesperson_max_return, not kept out by the role
    exchange: { fn: apiExchange_, roles: ALL_ }, // the cap here is on cash handed back, not on the swap
    listExpenses: { fn: apiListExpenses_, roles: AM_ },
    saveExpense: { fn: apiSaveExpense_, roles: AM_ },
    deleteExpense: { fn: apiDeleteExpense_, roles: AM_ },

    // owner only
    listUsers: { fn: apiListUsers_, roles: A_ },
    saveUser: { fn: apiSaveUser_, roles: A_ },
    toggleUser: { fn: apiToggleUser_, roles: A_ },
    deleteUser: { fn: apiDeleteUser_, roles: A_ },
    saveSettings: { fn: apiSaveSettings_, roles: A_ },
    listLogs: { fn: apiListLogs_, roles: A_ },
    listBranches: { fn: apiListBranches_, roles: A_ },
    saveBranch: { fn: apiSaveBranch_, roles: A_ },
    };
    return ACTIONS_CACHE_;
}

function doPost(e) {
    let req = null;
    try {
        req = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    } catch (err) {
        return json_({ success: false, code: "BAD_REQUEST", message: "Invalid request" });
    }
    return json_(dispatchOnce_(req));
}

// reads are safe to run again, so their saved reply is kept only briefly — long enough to cover a
// retry after Google loses one, not long enough to hand anyone stale figures
const READ_ACTIONS_ = {
    bootstrap: 1, getCatalog: 1, getStock: 1, dashboard: 1, listSales: 1, getSale: 1, report: 1, listCustomers: 1, findCustomer: 1,
    listHeld: 1, movements: 1, listExpenses: 1, listUsers: 1, listLogs: 1, customerHistory: 1, listSellers: 1,
    getSettings: 1, stockInBatches: 1, listTransfers: 1, listBranches: 1, me: 1, ping: 1,
};

/**
 * Google sometimes loses the reply (404 on the …/macros/echo redirect) after the script has already run.
 * The app then retries with the same req_id: a write that already happened returns its saved reply
 * instead of running twice (no double stock-in, expense, return…). Requests without req_id run as before.
 *
 * Reads are kept too. They are safe to repeat, but repeating them is what made a lost reply cost 20
 * seconds of sheet reading a second time; answering the retry from the saved reply costs nothing.
 */
function dispatchOnce_(req) {
    const id = req && typeof req.req_id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(req.req_id) ? req.req_id : "";
    if (!id) return dispatch_(req);
    const isRead = !!READ_ACTIONS_[req.action];
    const cache = CacheService.getScriptCache();
    const key = "rq_" + id;
    const seen = cache.get(key);
    if (seen === "PENDING")
        return {
            success: false,
            code: "IN_PROGRESS",
            message: isRead ? "Still fetching that — one moment…" : "Still saving your last request — one moment…",
        };
    if (seen) {
        try {
            return JSON.parse(seen);
        } catch (e) {
            /* unreadable → run again */
        }
    }
    cache.put(key, "PENDING", 120); // a retry arriving while this runs waits instead of running again
    const res = dispatch_(req);
    try {
        const out = JSON.stringify(res);
        // failures aren't kept, so a retry can try again; big replies can't be cached (100 KB limit).
        // A save is remembered for 6 hours (the cache's limit): a phone locked mid-save can retry much
        // later, and after 10 minutes that retry used to save a second time (seen: a transfer done twice).
        if (res.success && out.length < 90000) cache.put(key, out, isRead ? 120 : 21600);
        else cache.remove(key);
    } catch (e) {
        cache.remove(key);
    }
    return res;
}

function doGet() {
    return json_({ success: true, app: APP.NAME, time: nowStr_() });
}

function json_(obj) {
    return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function dispatch_(req) {
    resetReqCache_();
    REQ_CACHE_.__api = true; // sheet handles and header rows can be reused for this request (db.gs sheet_)
    const action = req && req.action;
    const acts = actions_();
    const def = Object.prototype.hasOwnProperty.call(acts, action) ? acts[action] : null;
    if (!def) return { success: false, code: "BAD_ACTION", message: "Unknown action" };
    try {
        let ctx = null;
        if (!def.public) {
            ctx = authenticate_(req.token);
            if (def.roles.indexOf(ctx.user.role) < 0) fail_("You don't have permission to do this", "FORBIDDEN");
            // the branch this request works in — checked against the user's allowed branches
            ctx.branch_id = resolveBranch_(ctx.user, req.branch_id);
        }
        const res = def.fn(req.payload || {}, ctx) || {};
        return {
            success: true,
            message: res.message || "",
            data: res.data === undefined ? null : res.data,
            cv: ctx ? num_(setting_("catalog_version"), 1) : undefined,
            sv: ctx ? num_(setting_("stock_version"), 1) : undefined,
        };
    } catch (err) {
        if (err && err.isAppError) return { success: false, code: err.code, message: err.message };
        console.error("API " + action + ":", err && err.stack ? err.stack : err);
        return { success: false, code: "SERVER", message: "Something went wrong. Please try again." };
    }
}

function apiBootstrap_(p, ctx) {
    return {
        data: {
            user: publicUser_(ctx.user),
            branch_id: ctx.branch_id,
            branches: activeBranches_().map(branchOut_),
            settings: publicSettings_(ctx),
            catalog: apiGetCatalog_(p, ctx).data,
            sellers: ctx.user.role === MOVER_ ? [] : apiListSellers_(p, ctx).data, // who sells is not theirs to see
        },
    };
}

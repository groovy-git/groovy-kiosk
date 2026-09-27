// Talks to the Apps Script web app. Body is text/plain JSON so the browser sends a
// "simple" request (Apps Script cannot answer CORS preflights).
const API_URL = import.meta.env.VITE_API_URL;
const TOKEN_KEY = "gp_token";

let handlers = { authExpired: () => {}, version: () => {} };
export function setApiHandlers(h) {
  handlers = { ...handlers, ...h };
}

export const getToken = () => localStorage.getItem(TOKEN_KEY) || "";
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

// branch this phone is working at (0 = all branches, the owner only); the server re-checks it
const BRANCH_KEY = "gp_branch";
export const getBranch = () => Number(localStorage.getItem(BRANCH_KEY) || 0);
export const setBranch = (id) => localStorage.setItem(BRANCH_KEY, String(id || 0));
export const clearBranch = () => localStorage.removeItem(BRANCH_KEY);

export class ApiError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// one id per action; retries reuse it so the server never runs the same save twice
const newReqId = () => {
  try {
    if (crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* older browsers */
  }
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
};

/**
 * Google occasionally loses the reply (404 on the …/macros/echo redirect) even though the script ran.
 * Every action is therefore retried with the same req_id: the server returns the saved reply of a
 * write that already happened instead of doing it again.
 */
// reads can be asked again safely, so they give up sooner; a save is given longer before it is retried
const READS = /^(bootstrap|getCatalog|getStock|dashboard|listSales|getSale|report|listCustomers|findCustomer|listHeld|movements|listExpenses|listUsers|listLogs|customerHistory|listSellers|getSettings|stockInBatches|listTransfers|listBranches|me|ping)$/;

export async function api(action, payload = {}) {
  if (!API_URL) throw new ApiError("App not configured: VITE_API_URL is missing.", "CONFIG");
  if (!navigator.onLine) throw new ApiError("You're offline. Check the internet and try again.", "OFFLINE");
  const body = JSON.stringify({ action, token: getToken(), branch_id: getBranch(), req_id: newReqId(), payload });
  const isRead = READS.test(action);
  const attempts = 3;
  const timeout = isRead ? 20000 : 45000;
  let lastStatus = 0;
  for (let i = 0; i < attempts; i++) {
    let json = null;
    try {
      const ctrl = new AbortController();
      // the timer covers reading the answer too: a reply that starts arriving and then stalls used
      // to hang with nothing to stop it
      const timer = setTimeout(() => ctrl.abort(), timeout);
      try {
        const res = await fetch(API_URL, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body,
          redirect: "follow",
          signal: ctrl.signal,
        });
        lastStatus = res.status;
        const text = await res.text();
        try {
          json = JSON.parse(text);
        } catch {
          json = null; // Google's HTML error page (e.g. 404 on the echo redirect)
        }
        // "success" without a `data` field isn't an answer to this action: it is the web app's GET page,
        // which Google now and then serves for a POST (seen in the multi-user stress test). The action
        // didn't run — treat it like a lost reply and ask again with the same req_id.
        if (json && json.success && !("data" in json)) json = null;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      json = null; // network drop / timeout
    }
    if (json) {
      if (json.cv) handlers.version(json.cv, json.sv);
      if (json.success) return json;
      if (json.code === "IN_PROGRESS" && i < attempts - 1) {
        await sleep(1500); // the first try is still being saved — ask again for its result
        continue;
      }
      if (json.code === "AUTH_EXPIRED") handlers.authExpired();
      throw new ApiError(json.message || "Request failed", json.code);
    }
    if (i < attempts - 1) await sleep(800 * (i + 1));
  }
  throw new ApiError(
    "Couldn't reach the server" + (lastStatus && lastStatus !== 200 ? " (Google returned " + lastStatus + ")" : "") +
      ". If you were saving something, check whether it was saved before trying again.",
    "NETWORK",
  );
}

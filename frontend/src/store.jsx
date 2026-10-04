import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, clearBranch, clearToken, getBranch, getToken, setApiHandlers, setBranch, setToken } from "./lib/api";
import { navigate } from "./lib/router";
import { buildCatalog } from "./lib/catalog";
import { runBusy } from "./lib/busy";

const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

const load = (k, def) => {
  try {
    const v = localStorage.getItem(k);
    return v ? JSON.parse(v) : def;
  } catch {
    return def;
  }
};
const save = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage full / private mode — app still works */
  }
};

// Roles have been renamed: "salesman" → "salesperson", "admin" → "owner". A phone that logged in
// before a rename still has the old word saved against its user, so the role is read through here.
// The old words are spelled in pieces so a search-and-replace cannot quietly make this a no-op.
const OLD_ROLE_NAMES = {};
OLD_ROLE_NAMES["sales" + "man"] = "salesperson";
OLD_ROLE_NAMES["ad" + "min"] = "owner";

const EMPTY_CART = { lines: [], bill_disc: 0, customer: { phone: "", name: "", gstin: "" }, salesman_id: null, notes: "", held_id: null, gst_hidden: false, exchange: null };
// a bill in progress belongs to the branch it was started at
const cartKey = (branchId) => "gp_cart_" + (branchId || 0);
const pickedKey = (userId) => "gp_branch_picked_" + userId;

/**
 * Home's figures, asked for while logging in instead of after the shop's data has arrived — the
 * two used to run one after the other. Home's first load takes it, once. It counts only for the
 * branch it was meant for: a request for no branch in particular (0) is placed by the server
 * exactly as the login's bootstrap is, so it lands on whatever branch Home then opens with.
 */
let loginDashboard = null;
export function takeLoginDashboard(branchId) {
  const d = loginDashboard;
  loginDashboard = null;
  return d && (d.branch === 0 || d.branch === branchId) ? d.promise : null;
}

export function AppProvider({ children }) {
  const [user, setUser] = useState(() => (getToken() ? load("gp_user", null) : null));
  const [settings, setSettings] = useState(() => load("gp_settings", {}));
  const [rawCatalog, setRawCatalog] = useState(() => load("gp_catalog", null));
  const [sellers, setSellers] = useState(() => load("gp_sellers", []));
  const [branches, setBranches] = useState(() => load("gp_branches", []));
  const [branchId, setBranchId] = useState(getBranch);
  const [pickBranch, setPickBranch] = useState(false);
  // the password just used to log in is one the shop would not accept as a new one: the app says so (App.jsx)
  const [weakPassword, setWeakPassword] = useState(false);
  const [booting, setBooting] = useState(!!getToken());
  const [online, setOnline] = useState(navigator.onLine);
  const [cart, setCartState] = useState(() => load(cartKey(getBranch()), load("gp_cart", EMPTY_CART)));
  const [toasts, setToasts] = useState([]);
  const versionRef = useRef(rawCatalog ? rawCatalog.version : 0);
  const cachedRef = useRef(rawCatalog ? { version: rawCatalog.version, branch: rawCatalog._branch || 0 } : null);
  const rawCatalogRef = useRef(rawCatalog);
  const branchRef = useRef(branchId);
  const refreshing = useRef(false);
  const refreshingStock = useRef(false);
  const stockWanted = useRef(0); // newest stock number seen while a refresh was on its way
  const stockVersionRef = useRef(Number(load("gp_stock_version", 0)) || 0);

  const toast = useCallback((message, type = "info", ms = 2600) => {
    const id = Math.random();
    setToasts((t) => [...t.slice(-2), { id, message, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ms);
  }, []);

  const setCart = useCallback((updater) => {
    setCartState((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      save(cartKey(branchRef.current), next);
      return next;
    });
  }, []);
  const clearCart = useCallback(() => setCart(EMPTY_CART), [setCart]);

  // what the cached catalogue is: which version, and which branch's stock it holds
  const applyCatalog = useCallback((c, branchId) => {
    versionRef.current = c.version;
    const next = { ...c, _branch: Number(branchId) || 0 };
    cachedRef.current = { version: next.version, branch: next._branch };
    setRawCatalog(next);
    save("gp_catalog", next);
    // the catalogue carries current stock, so this is a fresh starting point for stock updates too
    if (c.stock_version) {
      stockVersionRef.current = c.stock_version;
      save("gp_stock_version", c.stock_version);
    }
    if (c.at) save("gp_stock_at", c.at);
  }, []);

  // sent with every request so the server can skip the payload when nothing has changed for us
  const catalogHeld = () => (cachedRef.current ? { catalog_version: cachedRef.current.version, catalog_branch: cachedRef.current.branch } : {});

  // switch the phone to a branch: its own stock (next bootstrap) and its own bill in progress
  const applyBranch = useCallback((id) => {
    const b = Number(id) || 0;
    setBranch(b);
    if (branchRef.current !== b) {
      branchRef.current = b;
      setCartState(load(cartKey(b), EMPTY_CART));
    }
    setBranchId(b);
  }, []);

  /**
   * Stock changed somewhere — fetch the current stock (the server now always sends the whole map).
   * `stock_at` is the server's clock, not this device's; it is still sent for older server versions.
   *
   * A newer stock number can arrive while a refresh is on its way — this phone's own next sale, say.
   * If the answer that lands is older than that number, the stock is fetched once more; otherwise the
   * phone would show the older count until something else asked the server. (The refresh's own reply
   * carries the number it answers for, so it never asks again for itself.)
   */
  const refreshStock = useCallback(async (sv) => {
    if (refreshingStock.current) {
      stockWanted.current = Math.max(stockWanted.current, Number(sv) || 0);
      return;
    }
    refreshingStock.current = true;
    try {
      do {
        stockWanted.current = 0;
        try {
          const since = load("gp_stock_at", "");
          const r = await api("getStock", since ? { since } : {});
          const d = r.data;
          setRawCatalog((c) => {
            if (!c) return c;
            const qty = d.changed || {};
            const byBranch = d.by_branch || {};
            const next = {
              ...c,
              variants: c.variants.map((v) =>
                Object.prototype.hasOwnProperty.call(qty, v.id)
                  ? { ...v, stock_qty: qty[v.id], stock_by_branch: byBranch[v.id] || v.stock_by_branch }
                  : d.full
                    ? { ...v, stock_qty: 0, stock_by_branch: byBranch[v.id] || {} } // full map: anything missing has none left
                    : v,
              ),
            };
            save("gp_catalog", next);
            return next;
          });
          stockVersionRef.current = d.stock_version;
          save("gp_stock_version", d.stock_version);
          save("gp_stock_at", d.at);
        } catch {
          /* keep what we have; the next reply will ask again */
        }
      } while (stockWanted.current > stockVersionRef.current && getToken()); // not after a logout: nobody to fetch it for
    } finally {
      refreshingStock.current = false;
    }
  }, []);

  const refreshCatalog = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const r = await api("getCatalog", catalogHeld());
      if (!r.data.unchanged) applyCatalog(r.data, r.data.branch_id);
    } catch {
      /* keep cached catalog */
    } finally {
      refreshing.current = false;
    }
  }, [applyCatalog]);

  const logoutLocal = useCallback(() => {
    loginDashboard = null; // never shown to the next person
    setWeakPassword(false);
    stockWanted.current = 0;
    clearToken();
    clearBranch(); // the next person on this phone starts at their own home branch
    // shared phones: the next person must not see this person's data (costs, carts, figures, emails)
    Object.keys(localStorage)
      .filter((k) => /^gp_(user|sellers|catalog|settings|branches|cart|stock)/.test(k))
      .forEach((k) => localStorage.removeItem(k));
    try {
      sessionStorage.clear(); // dashboard cache, drafts, filters
    } catch {
      /* private mode */
    }
    setRawCatalog(null);
    cachedRef.current = null; // the next person downloads the catalogue fresh
    rawCatalogRef.current = null;
    stockVersionRef.current = 0;
    setSettings({});
    setUser(null);
    branchRef.current = 0;
    setBranchId(0);
    setCartState(EMPTY_CART);
    navigate("home", { replace: true }); // the next person starts at Home, not the last screen used
  }, []);

  useEffect(() => {
    setApiHandlers({
      authExpired: () => {
        logoutLocal();
        toast("Please log in again", "warn");
      },
      // Every reply carries two numbers: the catalogue's version and the stock's. A higher catalogue
      // number means someone edited a product, so the whole thing is fetched again — rare. A higher
      // stock number means someone sold something, so only what moved is fetched — constant, and it
      // used to drag the entire catalogue down with it.
      // Neither runs while the first load is still going: bootstrap is already fetching it.
      version: (cv, sv) => {
        if (cv > versionRef.current && cachedRef.current) refreshCatalog();
        else if (sv && sv > stockVersionRef.current && cachedRef.current) refreshStock(sv);
      },
    });
  }, [logoutLocal, refreshCatalog, refreshStock, toast]);

  const bootstrap = useCallback(async () => {
    let r;
    try {
      r = await api("bootstrap", catalogHeld());
    } catch (e) {
      if (e.code !== "BRANCH") throw e;
      clearBranch(); // remembered branch no longer allowed → server picks the home branch
      r = await api("bootstrap", catalogHeld());
    }
    const d = r.data;
    // the server says our copy is still current and kept the payload out of the reply
    if (d.catalog.unchanged && !rawCatalogRef.current) {
      cachedRef.current = null; // nothing to keep — ask again for the real thing
      d.catalog = (await api("getCatalog", {})).data;
    }
    setUser(d.user);
    setSettings(d.settings);
    setSellers(d.sellers);
    setBranches(d.branches);
    if (!d.catalog.unchanged) applyCatalog(d.catalog, d.branch_id);
    applyBranch(d.branch_id);
    save("gp_user", d.user);
    save("gp_settings", d.settings);
    save("gp_sellers", d.sellers);
    save("gp_branches", d.branches);
    // first time on this phone with a choice of branches → ask where they're working
    const choices = d.user.role === "owner" ? d.branches.length : d.user.branch_ids.length;
    if (choices > 1 && !localStorage.getItem(pickedKey(d.user.id))) setPickBranch(true);
    return d;
  }, [applyCatalog, applyBranch]);

  // on app open: refresh everything in the background (cached data shows instantly)
  useEffect(() => {
    if (!getToken()) return;
    bootstrap()
      .catch((e) => {
        if (e.code !== "AUTH_EXPIRED") toast(e.message, "error");
      })
      .finally(() => setBooting(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  const login = useCallback(
    async (email, password) => {
      const r = await api("login", { email, password, device: navigator.userAgent.slice(0, 100) });
      setToken(r.data.token);
      setWeakPassword(!!r.data.weak_password);
      // a stock mover has no Home and no figures to fetch: the server would only refuse
      if (r.data.user.role !== "stock_mover") {
        const promise = api("dashboard");
        promise.catch(() => {}); // a failure is Home's to deal with, when it takes this
        loginDashboard = { branch: getBranch(), promise };
      }
      setBooting(true); // "Loading your shop…" until products and settings arrive
      setUser(r.data.user);
      save("gp_user", r.data.user);
      try {
        await bootstrap();
        navigate("home", { replace: true }); // always start on Home, whatever the last person had open
      } finally {
        setBooting(false);
      }
    },
    [bootstrap],
  );

  // the screen is blocked until the phone is fully logged out
  const logout = useCallback(
    () =>
      runBusy("Logging out…", async () => {
        try {
          await api("logout");
        } catch {
          /* already logged out server-side */
        }
        logoutLocal();
      }),
    [logoutLocal],
  );

  const switchBranch = useCallback(
    // the screen is blocked until the new branch's stock and settings have loaded
    (id) => {
      const target = branches.find((x) => x.id === Number(id));
      return runBusy(target ? `Switching to ${target.name}…` : "Loading all branches…", async () => {
        const prev = branchRef.current;
        applyBranch(id);
        if (user) localStorage.setItem(pickedKey(user.id), "1");
        setPickBranch(false);
        try {
          const d = await bootstrap();
          const b = d.branches.find((x) => x.id === d.branch_id);
          toast(b ? `Now working at ${b.name}` : "Showing all branches", "success", 2000);
        } catch (e) {
          applyBranch(prev);
          toast(e.message, "error");
        }
      });
    },
    [applyBranch, bootstrap, toast, user, branches],
  );

  useEffect(() => {
    rawCatalogRef.current = rawCatalog; // read by bootstrap, which runs outside render
  }, [rawCatalog]);

  const catalog = useMemo(() => buildCatalog(rawCatalog), [rawCatalog]);

  // patch stock locally after a sale / stock-in so the UI is instant; server version refresh follows
  const patchStock = useCallback((changes) => {
    setRawCatalog((c) => {
      if (!c) return c;
      const m = new Map(changes.map((x) => [x.id, x.stock_qty]));
      const next = { ...c, variants: c.variants.map((v) => (m.has(v.id) ? { ...v, stock_qty: m.get(v.id) } : v)) };
      save("gp_catalog", next);
      return next;
    });
  }, []);

  const role = user ? OLD_ROLE_NAMES[user.role] || user.role : null;
  const isManager = role === "owner" || role === "manager";
  // carries stock between branches: sees products and stock, moves it, and nothing else
  const isMover = role === "stock_mover";
  const multiBranch = branches.length > 1;
  const branch = branches.find((b) => b.id === branchId) || null;
  // branches this person can switch to (the owner: all)
  const myBranches = !user ? [] : role === "owner" ? branches : branches.filter((b) => (user.branch_ids || []).includes(b.id));

  const value = {
    user, role, isManager, isAdmin: role === "owner", isMover, canTransfer: isManager || isMover,
    settings, setSettings: (s) => { setSettings(s); save("gp_settings", s); },
    catalog, rawCatalog, refreshCatalog, patchStock,
    sellers, setSellers,
    branches, branchId, branch, multiBranch, myBranches, isAllBranches: multiBranch && !branchId,
    switchBranch, pickBranch, setPickBranch,
    weakPassword, setWeakPassword,
    booting, online,
    login, logout, bootstrap,
    cart, setCart, clearCart,
    toast, toasts,
  };
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

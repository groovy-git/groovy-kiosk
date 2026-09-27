import { Component, Suspense, useEffect } from "react";
import { Home as HomeIcon, ShoppingBag, Receipt, Boxes, Menu, Users, BarChart3, Wallet, Settings as Cog, LogOut, UserCircle, History, Package } from "lucide-react";
import { useApp } from "./store";
import { useRoute, navigate } from "./lib/router";
import { Toasts, Spinner, SkeletonList, Empty } from "./components/ui";
import TopBar from "./components/TopBar";
import BusyOverlay from "./components/BusyOverlay";
import { lazyScreen } from "./lib/lazyScreen";
import { BranchChip, BranchPicker } from "./components/Branch";
import Login from "./pages/Login";
import Home from "./pages/Home";
import Sell from "./pages/Sell";

const Sales = lazyScreen(() => import("./pages/Sales"));
const SaleDetail = lazyScreen(() => import("./pages/SaleDetail"));
const Stock = lazyScreen(() => import("./pages/Stock"));
const ProductForm = lazyScreen(() => import("./pages/ProductForm"));
const StockIn = lazyScreen(() => import("./pages/StockIn"));
const Transfer = lazyScreen(() => import("./pages/Transfer"));
const Customers = lazyScreen(() => import("./pages/Customers"));
const Expenses = lazyScreen(() => import("./pages/Expenses"));
const Reports = lazyScreen(() => import("./pages/Reports"));
const More = lazyScreen(() => import("./pages/More"));
const UsersPage = lazyScreen(() => import("./pages/Users"));
const SettingsPage = lazyScreen(() => import("./pages/Settings"));
const Logs = lazyScreen(() => import("./pages/Logs"));
const Account = lazyScreen(() => import("./pages/Account"));

// the screens are separate files so the app starts fast; fetch them quietly once Home is up,
// otherwise the first tap on a screen waits for its file over mobile data
const PRELOAD = [
  () => import("./pages/Sales"),
  () => import("./pages/Stock"),
  () => import("./pages/More"),
  () => import("./pages/SaleDetail"),
  () => import("./pages/Customers"),
  () => import("./pages/Reports"),
  () => import("./pages/ProductForm"),
  () => import("./pages/StockIn"),
  () => import("./pages/Expenses"),
  () => import("./pages/Account"),
  () => import("./pages/Users"),
  () => import("./pages/Settings"),
  () => import("./pages/Transfer"),
  () => import("./pages/Logs"),
];

// logged out: only the login screen shows, so keep the address on Home — a sheet closing can
// otherwise step back to the screen the last person had open (e.g. #/more)
function useHomeWhenLoggedOut(loggedOut) {
  useEffect(() => {
    if (!loggedOut) return;
    const fix = () => {
      if (window.location.hash && window.location.hash !== "#/home") navigate("home", { replace: true });
    };
    fix();
    window.addEventListener("hashchange", fix);
    window.addEventListener("popstate", fix);
    return () => {
      window.removeEventListener("hashchange", fix);
      window.removeEventListener("popstate", fix);
    };
  }, [loggedOut]);
}

// on a weak or metered connection these files are competing with the shop's own data, so they wait
function connectionIsCheap() {
  try {
    const c = navigator.connection;
    if (!c) return true; // no way to tell (Safari) — behave as before
    if (c.saveData) return false;
    return !/(^|-)2g$/.test(c.effectiveType || "");
  } catch {
    return true;
  }
}

function usePreloadScreens(ready) {
  useEffect(() => {
    if (!ready || !connectionIsCheap()) return;
    let i = 0;
    let stop = false;
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 300));
    const next = () => {
      if (stop || i >= PRELOAD.length) return;
      PRELOAD[i++]()
        .catch(() => {}) // offline or a slow network: the screen loads normally when opened
        .then(() => idle(next));
    };
    // let the screen the user is actually looking at finish loading its data first
    const start = setTimeout(() => idle(next), 4000);
    return () => {
      stop = true;
      clearTimeout(start);
    };
  }, [ready]);
}

// iPhone home-screen app: at launch, and after the login keyboard closes, iOS can think the screen is
// shorter than it is, leaving a strip under the bottom tabs until something makes it measure again.
// A scroll to the top (where a fresh screen already is) is that something.
function useIosViewportNudge(shown) {
  useEffect(() => {
    if (!shown) return;
    const nudge = () => requestAnimationFrame(() => window.scrollTo(0, 0));
    nudge();
    const vv = window.visualViewport;
    if (!vv) return;
    let last = vv.height;
    const onResize = () => {
      const grew = vv.height > last;
      last = vv.height;
      // keyboard just closed, nothing is being typed into, and the page is at the top anyway
      if (grew && window.scrollY === 0 && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "")) nudge();
    };
    vv.addEventListener("resize", onResize);
    return () => vv.removeEventListener("resize", onResize);
  }, [shown]);
}

// same frame as a real screen (title bar + rows) so a screen being fetched never looks blank
function PageLoading() {
  return (
    <>
      <div className="topbar">
        <h1>&nbsp;</h1>
      </div>
      <div className="page">
        <SkeletonList rows={4} height={70} />
      </div>
    </>
  );
}

// a screen that cannot open (its file failed to load even after a reload, or it crashed) shows this
// instead of taking the whole app down to a blank page; the top bar and tabs stay usable
class ScreenGuard extends Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err) {
    console.error(err);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div data-screen-error>
        <TopBar title="Couldn't open" />
        <div className="page">
          <Empty
            title="This screen couldn't open"
            text="Check your internet, then tap Reload."
            action={<button className="btn" onClick={() => window.location.reload()}>Reload</button>}
          />
        </div>
      </div>
    );
  }
}

// who may open which page (server enforces the same rules on every action)
const ACCESS = {
  home: "all", sell: "all", sales: "all", customers: "all", more: "all", account: "all", reports: "all", stock: "all",
  expenses: "mgr", users: "owner", settings: "owner", logs: "owner",
};

function Page({ route }) {
  const { page, parts } = route;
  switch (page) {
    case "home": return <Home />;
    case "sell": return <Sell />;
    case "sales": return parts[1] ? <SaleDetail id={Number(parts[1])} /> : <Sales />;
    case "stock":
      if (parts[1] === "product") return <ProductForm id={parts[2] === "new" ? null : Number(parts[2])} />;
      if (parts[1] === "in") return <StockIn />;
      if (parts[1] === "transfer") return <Transfer />;
      return <Stock tab={parts[1]} />;
    case "customers": return <Customers />;
    case "expenses": return <Expenses />;
    case "reports": return <Reports />;
    case "more": return <More />;
    case "users": return <UsersPage />;
    case "settings": return <SettingsPage />;
    case "logs": return <Logs />;
    case "account": return <Account />;
    default: return <Home />;
  }
}

export default function App() {
  const { user, booting, rawCatalog, online, isManager, isAdmin, logout, settings, branchId } = useApp();
  const route = useRoute();
  usePreloadScreens(!!user && !!rawCatalog);
  useHomeWhenLoggedOut(!user);
  useIosViewportNudge(!!user && !(booting && !rawCatalog));

  if (!user) return (<><Login /><Toasts /><BusyOverlay /></>);
  if (booting && !rawCatalog)
    return (
      <div className="login">
        <img className="logo" src="./logo.svg" alt="Groovy Fragrances" />
        <div className="tagline">Loading your shop…</div>
        <Spinner />
      </div>
    );

  const allowed = (p) => {
    const a = ACCESS[p] || "all";
    return a === "all" || (a === "mgr" && isManager) || (a === "owner" && isAdmin);
  };
  const page = allowed(route.page) ? route.page : "home";
  const active = ["users", "settings", "logs", "account", "customers", "expenses", "reports"].includes(page) ? "more" : page;

  const tabs = isManager
    ? [
        { id: "home", label: "Home", icon: HomeIcon },
        { id: "stock", label: "Stock", icon: Boxes },
        { id: "sell", label: "Sell", icon: ShoppingBag, center: true },
        { id: "sales", label: "Sales", icon: Receipt },
        { id: "more", label: "More", icon: Menu },
      ]
    : [
        { id: "home", label: "Home", icon: HomeIcon },
        { id: "sales", label: "My Sales", icon: Receipt },
        { id: "sell", label: "Sell", icon: ShoppingBag, center: true },
        { id: "stock", label: "Products", icon: Package },
        { id: "more", label: "More", icon: Menu },
      ];

  const side = [
    { id: "home", label: "Home", icon: HomeIcon },
    { id: "sell", label: "Sell", icon: ShoppingBag },
    { id: "sales", label: isManager ? "Sales" : "My Sales", icon: Receipt },
    { id: "stock", label: isManager ? "Stock" : "Products", icon: Boxes },
    { id: "customers", label: "Customers", icon: Users },
    isManager && { id: "expenses", label: "Expenses", icon: Wallet },
    { id: "reports", label: "Reports", icon: BarChart3 },
    isAdmin && { id: "users", label: "Staff", icon: UserCircle },
    isAdmin && { id: "settings", label: "Settings", icon: Cog },
    isAdmin && { id: "logs", label: "Activity", icon: History },
  ].filter(Boolean);

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          <img src="./logo.svg" alt="" />
          <div>
            <div className="name">{settings.business_name || "Groovy Fragrances"}</div>
            <div className="tag">{(settings.tagline || "Smell of perfection").toUpperCase()}</div>
          </div>
        </div>
        <BranchChip />
        {side.map((s) => (
          <button key={s.id} className={page === s.id ? "active" : ""} onClick={() => navigate(s.id)}>
            <s.icon size={20} /> {s.label}
          </button>
        ))}
        <div className="spacer" />
        <button onClick={() => navigate("account")} className={page === "account" ? "active" : ""}>
          <UserCircle size={20} /> {user.name}
        </button>
        <button onClick={logout}>
          <LogOut size={20} /> Log out
        </button>
      </nav>

      <div className="main">
        {!online && <div className="offline">You're offline — you can browse, but bills can't be saved until you're back online.</div>}
        {/* keyed by page, so moving to another tab clears an error (every page is its own screen
            component already, so this remounts nothing that wasn't remounting before) */}
        <ScreenGuard key={page}>
          <Suspense fallback={<PageLoading />}>
            {/* switching branch reloads the open screen with that branch's data */}
            <Page key={branchId} route={{ ...route, page }} />
          </Suspense>
        </ScreenGuard>
      </div>

      <nav className="bottomnav" aria-label="Main">
        {tabs.map((t) =>
          t.center ? (
            <button key={t.id} className={"sell-tab" + (active === t.id ? " active" : "")} onClick={() => navigate(t.id)} aria-label="Sell">
              <span className="sell-circle">
                <t.icon size={26} />
              </span>
              {t.label}
            </button>
          ) : (
            <button key={t.id} className={active === t.id ? "active" : ""} onClick={() => navigate(t.id)}>
              <t.icon size={23} />
              {t.label}
            </button>
          ),
        )}
      </nav>
      <BranchPicker />
      <Toasts />
      <BusyOverlay />
    </div>
  );
}

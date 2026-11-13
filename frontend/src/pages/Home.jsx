import { useEffect, useState } from "react";
import { ShoppingBag, AlertTriangle, Trophy, RefreshCw, ChevronRight } from "lucide-react";
import { useApp, takeLoginDashboard } from "../store";
import { api } from "../lib/api";
import { navigate } from "../lib/router";
import { inr, fmtDate, istDate, METHOD_LABEL, plural, ROLE_LABEL } from "../lib/format";
import TopBar from "../components/TopBar";
import { Seg, SkeletonList } from "../components/ui";
import BarChart from "../components/BarChart";

// role pill next to the greeting — brown for the owner, gold for manager, cream for salesperson
const ROLE_TONE = { owner: "dark", admin: "dark", manager: "gold", salesperson: "" }; // a stale cached role still gets its colour

export default function Home() {
  const { user, isManager, toast, settings, branchId, isAllBranches } = useApp();
  const [d, setD] = useState(() => {
    try {
      return JSON.parse(sessionStorage.getItem("gp_dash_" + branchId) || "null");
    } catch {
      return null;
    }
  });
  const [board, setBoard] = useState("today");
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      // right after logging in, the figures were already asked for alongside the shop's data
      const early = takeLoginDashboard(branchId);
      const r = early
        ? await early.catch((e) => {
            if (e.code === "AUTH_EXPIRED") throw e;
            return api("dashboard"); // it failed — ask again, as Home always has
          })
        : await api("dashboard");
      setD(r.data);
      sessionStorage.setItem("gp_dash_" + branchId, JSON.stringify(r.data));
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setLoading(false);
    }
  };
  // reload when the phone switches branch
  useEffect(() => {
    load();
  }, [branchId]); // eslint-disable-line react-hooks/exhaustive-deps

  const hour = Number(new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: false }).format(new Date()));
  const greet = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const payTotal = d ? Object.values(d.today.payments).reduce((a, b) => a + Math.max(0, b), 0) : 0;
  const lb = d ? d.leaderboard[board] : [];
  const lbMax = Math.max(1, ...lb.map((r) => r.net));

  return (
    <>
      <TopBar
        title={settings.business_name || "Groovy Fragrances"}
        right={
          <button className="icon-btn" onClick={load} aria-label="Refresh">
            <RefreshCw size={20} className={loading ? "spin" : ""} />
          </button>
        }
      />
      <div className="page">
        <div className="row between mb">
          <div>
            <h2 className="row gap-s" style={{ flexWrap: "wrap", alignItems: "center" }}>
              <span>
                {greet}, {user.name.split(" ")[0]}
              </span>
              <span className={"badge " + (ROLE_TONE[user.role] || "")}>{ROLE_LABEL[user.role] || user.role}</span>
            </h2>
            <div className="small muted">{fmtDate(istDate())}</div>
          </div>
        </div>

        <button className="card row" style={{ width: "100%", border: 0, background: "var(--gold)", cursor: "pointer", textAlign: "left" }} onClick={() => navigate("sell")}>
          <div className="avatar" style={{ background: "#fff", width: 48, height: 48 }}>
            <ShoppingBag />
          </div>
          <div className="grow">
            <div className="serif bold" style={{ fontSize: 18 }}>Start a new sale</div>
            <div className="small" style={{ color: "var(--brown-dark)" }}>Scan or tap products to bill</div>
          </div>
          <ChevronRight />
        </button>

        {!d ? (
          <div className="mt">
            <SkeletonList rows={4} height={80} />
          </div>
        ) : (
          <>
            <div className="section-label">{isManager ? "Today" : "My sales today"}</div>
            <div className="grid-2">
              <div className="stat brown">
                <div className="label">Net sales</div>
                <div className="value">{inr(d.today.net)}</div>
              </div>
              <div className="stat">
                <div className="label">Bills</div>
                <div className="value">{d.today.bills}</div>
              </div>
              <div className="stat">
                <div className="label">Average bill</div>
                <div className="value">{inr(Math.round(d.today.avg_bill))}</div>
              </div>
              <div className="stat">
                <div className="label">Returns</div>
                <div className="value">{inr(d.today.returns)}</div>
              </div>
              {/* a dashboard saved before this update has neither figure, so both default to 0 */}
              <div className="stat">
                <div className="label">Items sold</div>
                <div className="value">{d.today.items || 0}</div>
              </div>
              <div className="stat">
                <div className="label">New customers</div>
                <div className="value">{d.today.new_customers || 0}</div>
              </div>
            </div>

            {isAllBranches && d.by_branch && (
              <div className="card mt">
                <div className="card-title">
                  <h3>By branch</h3>
                  <span className="small muted">Today · month</span>
                </div>
                {d.by_branch.map((b) => (
                  <div key={b.branch_id} className="kv">
                    <span>
                      <b>{b.name}</b> <span className="small muted">· {plural("bill", b.bills)} · {plural("item", b.items || 0)}</span>
                      {/* a customer belongs to the branch that billed them first, so branches never
                          claim the same person twice */}
                      <div className="tiny muted">{plural("new customer", b.new_customers || 0)} to the shop</div>
                    </span>
                    <span className="right">
                      <b className="money">{inr(b.net)}</b>
                      <div className="tiny muted">month {inr(b.month_net)}</div>
                    </span>
                  </div>
                ))}
              </div>
            )}

            {payTotal > 0 && (
              <div className="card mt">
                <div className="card-title">
                  <h3>Money received today</h3>
                </div>
                {Object.entries(d.today.payments).map(([m, v]) => (
                  <div key={m} className="mb">
                    <div className="row between small">
                      <span className="bold">{METHOD_LABEL[m] || m}</span>
                      <span className="money">{inr(v)}</span>
                    </div>
                    <div className="bar-track">
                      <div className="bar-fill" style={{ width: `${Math.max(0, (v / payTotal) * 100)}%`, background: m === "cash" ? "var(--brown)" : m === "upi" ? "var(--gold)" : "var(--charcoal)" }} />
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="card mt">
              <div className="card-title">
                <h3 className="row gap-s">
                  <Trophy size={18} color="var(--gold-dark)" /> {isManager ? "Salespeople leaderboard" : "My performance"}
                </h3>
              </div>
              <Seg
                value={board}
                onChange={setBoard}
                options={[
                  { value: "today", label: "Today" },
                  { value: "month", label: "This month" },
                ]}
              />
              {lb.length === 0 ? (
                <div className="muted small center mt">No sales yet.</div>
              ) : (
                lb.map((r, i) => (
                  <div key={r.salesman_id} className="row mt">
                    <span className={"rank" + (i === 0 ? " r1" : "")}>{i + 1}</span>
                    <div className="grow">
                      <div className="row between">
                        <b className="ellipsis">{r.name}</b>
                        <b className="money">{inr(r.net)}</b>
                      </div>
                      <div className="bar-track" style={{ margin: "5px 0 3px" }}>
                        <div className="bar-fill" style={{ width: `${(r.net / lbMax) * 100}%` }} />
                      </div>
                      <div className="tiny muted">
                        {r.bills} bills · avg {inr(Math.round(r.avg_bill))}
                        {r.returns > 0 ? ` · returns ${inr(r.returns)}` : ""}
                      </div>
                      {/* on its own line: with returns too, one line wraps awkwardly on a phone */}
                      <div className="tiny muted">
                        {plural("item", r.items || 0)} · {plural("new customer", r.new_customers || 0)}
                        {r.reviews ? ` · ${plural("Google review", r.reviews)}` : ""}
                        {r.samples ? ` · ${plural("sample", r.samples)}` : ""}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="card mt">
              <div className="card-title">
                <h3>Last 30 days</h3>
                {isManager && d.month_net !== undefined && <span className="small muted">Month: {inr(d.month_net)}</span>}
              </div>
              <BarChart data={d.trend.map((t) => ({ label: t.date, value: t.net }))} />
            </div>

            {d.top_products.length > 0 && (
              <div className="card mt">
                <div className="card-title">
                  <h3>Top sellers this month</h3>
                </div>
                {d.top_products.map((p, i) => (
                  <div key={i} className="kv small">
                    <span className="ellipsis">
                      {p.name} <span className="muted">{p.size}</span> · {p.unit === "ml" ? `${p.qty} ml` : `${p.qty} pcs`}
                    </span>
                    <b className="money">{inr(p.amount)}</b>
                  </div>
                ))}
              </div>
            )}

            {d.low_stock_count > 0 && (
              <div className="card mt" style={{ borderLeft: "4px solid var(--gold)" }}>
                <div className="card-title">
                  <h3 className="row gap-s">
                    <AlertTriangle size={18} color="var(--gold-dark)" /> Low stock ({d.low_stock_count})
                  </h3>
                  {isManager && (
                    <button className="btn ghost small" onClick={() => navigate("stock?filter=low")}>
                      See all
                    </button>
                  )}
                </div>
                {d.low_stock.slice(0, 6).map((v) => (
                  <div key={v.variant_id} className="kv small">
                    <span className="ellipsis">
                      {v.name} <span className="muted">{v.size}</span>
                    </span>
                    <span className={v.stock_qty <= 0 ? "bad-text bold" : "bold"}>{v.stock_qty <= 0 ? "Out" : v.unit === "ml" ? `${v.stock_qty} ml` : v.stock_qty}</span>
                  </div>
                ))}
              </div>
            )}

            {isManager && d.month_expenses !== undefined && (
              <div className="grid-2 mt">
                <div className="stat gold">
                  <div className="label">Sales this month</div>
                  <div className="value">{inr(d.month_net)}</div>
                </div>
                <div className="stat">
                  <div className="label">Expenses this month</div>
                  <div className="value">{inr(d.month_expenses)}</div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

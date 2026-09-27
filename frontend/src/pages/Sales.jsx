import { useMemo, useState } from "react";
import { Receipt, ChevronRight } from "lucide-react";
import { useApp } from "../store";
import { api } from "../lib/api";
import { useCachedFetch } from "../lib/cached";
import { navigate } from "../lib/router";
import { inr, istDate, monthStart, fmtTime, relDay, METHOD_LABEL } from "../lib/format";
import TopBar, { Updating } from "../components/TopBar";
import { Chips, DateField, Empty, SearchBar, SkeletonList } from "../components/ui";

const PRESETS = [
  { value: "today", label: "Today", range: () => [istDate(), istDate()] },
  { value: "yday", label: "Yesterday", range: () => [istDate(-1), istDate(-1)] },
  { value: "7d", label: "Last 7 days", range: () => [istDate(-6), istDate()] },
  { value: "month", label: "This month", range: () => [monthStart(), istDate()] },
  { value: "custom", label: "Pick dates" },
];

export const STATUS = {
  completed: { label: "Paid", cls: "ok" },
  part_returned: { label: "Part returned", cls: "gold" },
  returned: { label: "Returned", cls: "" },
  voided: { label: "Voided", cls: "bad" },
};

export default function Sales() {
  const { isManager, sellers, toast, multiBranch, isAllBranches, role } = useApp();
  const saved = JSON.parse(sessionStorage.getItem("gp_sales_filter") || "null") || { preset: "today", from: istDate(), to: istDate(), seller: "" };
  const [f, setF] = useState(saved);
  const [q, setQ] = useState("");

  const setFilter = (patch) =>
    setF((x) => {
      const n = { ...x, ...patch };
      sessionStorage.setItem("gp_sales_filter", JSON.stringify(n));
      return n;
    });

  const [from, to] = f.preset === "custom" ? [f.from, f.to] : PRESETS.find((p) => p.value === f.preset).range();

  // the same range and salesperson as last time paint at once, then refresh underneath
  const { data, loading } = useCachedFetch(
    `gp_sales_${from}_${to}_${f.seller || "all"}`,
    () => api("listSales", { from, to, salesman_id: f.seller || undefined }).then((r) => r.data),
    [from, to, f.seller],
    (e) => toast(e.message, "error"),
  );

  const list = useMemo(() => {
    if (!data) return [];
    const s = q.trim().toLowerCase();
    return s ? data.sales.filter((x) => (x.invoice_no + " " + x.customer_name + " " + x.customer_phone + " " + x.salesman_name).toLowerCase().includes(s)) : data.sales;
  }, [data, q]);

  const groups = useMemo(() => {
    const g = [];
    list.forEach((s) => {
      const day = s.date.slice(0, 10);
      if (!g.length || g[g.length - 1].day !== day) g.push({ day, rows: [] });
      g[g.length - 1].rows.push(s);
    });
    return g;
  }, [list]);

  return (
    <>
      <TopBar title={isManager ? "Sales" : "My Sales"} right={loading && data ? <Updating /> : null} />
      <div className="page">
        <Chips options={PRESETS} value={f.preset} onChange={(p) => setFilter({ preset: p })} />
        {f.preset === "custom" && (
          <div className="grid-2 mt">
            <DateField value={f.from} max={f.to} onChange={(e) => setFilter({ from: e.target.value })} aria-label="From date" />
            <DateField value={f.to} min={f.from} max={istDate()} onChange={(e) => setFilter({ to: e.target.value })} aria-label="To date" />
          </div>
        )}
        {isManager && (
          <select className="input mt" value={f.seller} onChange={(e) => setFilter({ seller: e.target.value })} aria-label="Salesperson">
            <option value="">All salespeople</option>
            {sellers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        <div className="mt">
          <SearchBar value={q} onChange={setQ} placeholder="Bill no, customer or phone" />
        </div>

        {data && (
          <div className="grid-2 mt">
            <div className="stat brown">
              <div className="label">Net sales</div>
              <div className="value">{inr(data.summary.net)}</div>
            </div>
            <div className="stat">
              <div className="label">Bills</div>
              <div className="value">{data.summary.bills}</div>
            </div>
            <div className="stat">
              <div className="label">Items sold</div>
              <div className="value">{data.summary.items || 0}</div>
            </div>
            <div className="stat">
              <div className="label">New customers</div>
              <div className="value">{data.summary.new_customers || 0}</div>
            </div>
          </div>
        )}

        {!data ? (
          <div className="mt">
            <SkeletonList />
          </div>
        ) : list.length === 0 ? (
          <Empty icon={Receipt} title="No bills" text="No sales in this period." />
        ) : (
          groups.map((g) => (
            <div key={g.day}>
              <div className="section-label">{relDay(g.day)}</div>
              <div className="list">
                {g.rows.map((s) => (
                  <button key={s.id} className="list-item" onClick={() => navigate(`sales/${s.id}`)}>
                    <div className="grow">
                      <div className="row between">
                        <span className="title">{s.customer_name || s.customer_phone || "Walk-in"}</span>
                        <b className="money" style={s.status === "voided" ? { textDecoration: "line-through", color: "var(--muted)" } : null}>
                          {inr(s.grand_total - (s.status === "voided" ? 0 : s.refunded))}
                        </b>
                      </div>
                      <div className="row between sub">
                        <span className="ellipsis">
                          {fmtTime(s.date)} · {s.invoice_no} · {s.salesman_name}
                          {multiBranch && (isAllBranches || role === "salesperson") ? " · " + s.branch_name : ""}
                        </span>
                        <span className="row gap-s">
                          {s.status !== "completed" && <span className={"badge " + STATUS[s.status].cls}>{STATUS[s.status].label}</span>}
                          {s.status === "completed" && <span className="tiny">{s.methods.map((m) => METHOD_LABEL[m]).join(" + ")}</span>}
                        </span>
                      </div>
                    </div>
                    <ChevronRight size={18} color="var(--muted)" />
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}

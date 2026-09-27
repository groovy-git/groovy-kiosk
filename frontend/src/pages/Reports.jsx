import { useState } from "react";
import { Download, Trophy, Mail } from "lucide-react";
import { useApp } from "../store";
import { api } from "../lib/api";
import { useCachedFetch } from "../lib/cached";
import { inr, istDate, monthStart, fmtDate, fmtDateTime, METHOD_LABEL, r2, plural } from "../lib/format";
import { toCSV, downloadText } from "../lib/files";
import TopBar, { Updating } from "../components/TopBar";
import { Button, Chips, DateField, Seg, SkeletonList } from "../components/ui";

const TYPES = [
  { value: "day_close", label: "Day close", all: true },
  { value: "salesman_performance", label: "Salespeople", all: true },
  { value: "profit", label: "Profit" },
  { value: "gst_summary", label: "GST" },
  { value: "product_sales", label: "Best sellers" },
  { value: "sales_register", label: "Sales register" },
  { value: "stock_valuation", label: "Stock value" },
  { value: "expenses", label: "Expenses" },
];

const RANGES = [
  { value: "today", label: "Today", r: () => [istDate(), istDate()] },
  { value: "7d", label: "7 days", r: () => [istDate(-6), istDate()] },
  { value: "month", label: "This month", r: () => [monthStart(), istDate()] },
  { value: "custom", label: "Pick dates" },
];

export default function Reports() {
  const { isManager, toast } = useApp();
  const types = TYPES.filter((t) => isManager || t.all);
  const [type, setType] = useState(types[0].value);
  const [range, setRange] = useState("month");
  const [custom, setCustom] = useState({ from: monthStart(), to: istDate() });
  const [date, setDate] = useState(istDate());
  const [group, setGroup] = useState("variant");
  const [from, to] = range === "custom" ? [custom.from, custom.to] : RANGES.find((x) => x.value === range).r();

  // the same report with the same dates paints from last time, then refreshes
  const { data: report, loading } = useCachedFetch(
    `gp_report_${type}_${from}_${to}_${date}_${group}`,
    () => api("report", { type, from, to, date, group }).then((r) => ({ type, d: r.data })),
    [type, from, to, date, group],
    (e) => toast(e.message, "error"),
  );
  const data = report;

  const needsRange = !["day_close", "stock_valuation"].includes(type);
  return (
    <>
      <TopBar title="Reports" back="more" right={loading && data ? <Updating /> : null} />
      <div className="page">
        <Chips value={type} onChange={setType} options={types} />
        {type === "day_close" && (
          <>
            <div className="mt">
              <DateField max={istDate()} value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
            </div>
            <EmailDayClose date={date} />
          </>
        )}
        {needsRange && (
          <div className="mt">
            <Chips value={range} onChange={setRange} options={RANGES} />
            {range === "custom" && (
              <div className="grid-2">
                <DateField value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} aria-label="From" />
                <DateField value={custom.to} min={custom.from} max={istDate()} onChange={(e) => setCustom({ ...custom, to: e.target.value })} aria-label="To" />
              </div>
            )}
          </div>
        )}
        {type === "product_sales" && (
          <div className="mt">
            <Seg value={group} onChange={setGroup} options={[{ value: "variant", label: "Item" }, { value: "brand", label: "Brand" }, { value: "category", label: "Category" }]} />
          </div>
        )}
        <div className="mt">{!data || data.type !== type ? <SkeletonList rows={4} height={70} /> : data.error ? null : <Report type={type} d={data.d} />}</div>
      </div>
    </>
  );
}

// Option A: email this day close to the owner (salesperson → own figures, manager/owner → whole shop)
function EmailDayClose({ date }) {
  const { toast, role } = useApp();
  const [copy, setCopy] = useState(false);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      const r = await api("emailDayClose", { date, copy_me: copy });
      toast(r.message, "success", 3500);
    } catch (e) {
      toast(e.message, "error", 4000);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card mt row between wrap">
      <div className="grow" style={{ minWidth: 150 }}>
        <div className="bold small">{role === "salesperson" ? "Send my day close to the owner" : "Email this day close"}</div>
        <label className="row gap-s small muted" style={{ marginTop: 4 }}>
          <input type="checkbox" checked={copy} onChange={(e) => setCopy(e.target.checked)} style={{ width: 18, height: 18, accentColor: "var(--brown)" }} />
          Send me a copy
        </label>
      </div>
      <Button className="small dark" loading={busy} onClick={send}>
        <Mail size={16} /> Email
      </Button>
    </div>
  );
}

function Csv({ name, rows, cols }) {
  return (
    <button className="btn ghost small" onClick={() => downloadText(`${name}.csv`, toCSV(rows, cols))}>
      <Download size={16} /> CSV
    </button>
  );
}

const Stat = ({ label, value, cls = "" }) => (
  <div className={"stat " + cls}>
    <div className="label">{label}</div>
    <div className="value">{value}</div>
  </div>
);

function Report({ type, d }) {
  if (type === "day_close") {
    const expected = d.expected_cash;
    return (
      <>
        <div className="grid-2">
          <Stat cls="brown" label={`Net sales · ${fmtDate(d.date)}`} value={inr(d.net)} />
          <Stat label="Bills" value={d.bills} />
          <Stat label="Discounts given" value={inr(d.discounts)} />
          <Stat label="Returns" value={inr(d.returns)} />
        </div>
        <div className="card mt">
          <div className="card-title"><h3>Money by method</h3></div>
          <table className="tbl">
            <thead><tr><th>Method</th><th className="num">In</th><th className="num">Refund</th><th className="num">Net</th></tr></thead>
            <tbody>
              {Object.entries(d.methods).map(([m, v]) => (
                <tr key={m}><td>{METHOD_LABEL[m] || m}</td><td className="num">{inr(v.in)}</td><td className="num">{inr(v.out)}</td><td className="num"><b>{inr(v.net)}</b></td></tr>
              ))}
            </tbody>
          </table>
          {d.cash_expenses > 0 && <div className="kv small mt"><span className="k">Cash expenses paid</span><span>−{inr(d.cash_expenses)}</span></div>}
          <div className="kv total"><span>Cash in drawer</span><span>{inr(expected)}</span></div>
          <div className="tiny muted">Expected cash from today's sales (add your opening cash float).</div>
        </div>
        {(d.by_branch || []).length > 0 && (
          <div className="card mt">
            <div className="card-title"><h3>By branch</h3></div>
            {d.by_branch.map((b) => (
              <div key={b.branch_id} className="kv">
                <span>
                  <b>{b.name}</b> <span className="small muted">· {plural("bill", b.bills)}{b.returns ? " · returns " + inr(b.returns) : ""}</span>
                  <div className="tiny muted">{plural("item", b.items || 0)} · {plural("new customer", b.new_customers || 0)} to the shop</div>
                </span>
                <b className="money">{inr(b.net)}</b>
              </div>
            ))}
          </div>
        )}
        <SalesmenTable rows={d.by_salesman} title="By salesperson" />
        <ItemsSold items={d.items || []} date={d.date} />
        {d.credit_notes.length > 0 && (
          <div className="card mt">
            <div className="card-title"><h3>Returns</h3></div>
            {d.credit_notes.map((c) => (
              <div key={c.credit_note_no} className="kv small"><span>{c.credit_note_no} · {c.invoice_no} · {c.reason}</span><span>−{inr(c.total)}</span></div>
            ))}
          </div>
        )}
        {d.voided.length > 0 && (
          <div className="card mt">
            <div className="card-title"><h3>Voided bills</h3></div>
            {d.voided.map((v) => (
              <div key={v.invoice_no} className="kv small"><span>{v.invoice_no} · {v.salesman_name}</span><span className="muted">{inr(v.amount)}</span></div>
            ))}
          </div>
        )}
      </>
    );
  }

  if (type === "salesman_performance") return <SalesmenTable rows={d.rows} title={`${fmtDate(d.from)} – ${fmtDate(d.to)}`} full csv />;

  if (type === "profit")
    return (
      <>
        <div className="grid-2">
          <Stat cls="brown" label="Net profit" value={inr(Math.round(d.net_profit))} />
          <Stat cls="gold" label="Gross margin" value={`${d.margin_pct}%`} />
        </div>
        <div className="card mt">
          <div className="kv"><span className="k">Sales (incl. GST)</span><span>{inr(d.sales_incl_gst)}</span></div>
          <div className="kv"><span className="k">Returns (incl. GST)</span><span>−{inr(d.returns_incl_gst)}</span></div>
          <div className="kv"><span className="k">GST collected</span><span>−{inr(d.gst_collected)}</span></div>
          <div className="kv bold"><span>Revenue (ex-GST)</span><span>{inr(d.revenue_ex_gst)}</span></div>
          <div className="kv"><span className="k">Cost of goods sold</span><span>−{inr(d.cost_of_goods)}</span></div>
          <div className="kv bold"><span>Gross profit</span><span>{inr(d.gross_profit)}</span></div>
          <div className="kv"><span className="k">Shop expenses</span><span>−{inr(d.expenses)}</span></div>
          <div className="kv total"><span>Net profit</span><span>{inr(d.net_profit)}</span></div>
          <div className="tiny muted mt">Cost uses the average purchase cost entered in Stock In / products.</div>
        </div>
      </>
    );

  if (type === "gst_summary")
    return (
      <>
        <div className="grid-2">
          <Stat cls="brown" label="Taxable value" value={inr(d.totals.taxable)} />
          <Stat label="CGST + SGST" value={inr(r2(d.totals.cgst + d.totals.sgst))} />
        </div>
        <div className="card mt table-wrap">
          <div className="card-title"><h3>By GST rate</h3><Csv name={`gst-${d.from}-${d.to}`} rows={d.by_rate} cols={[{ key: "rate", label: "GST %" }, { key: "taxable", label: "Taxable" }, { key: "cgst", label: "CGST" }, { key: "sgst", label: "SGST" }, { key: "total", label: "Invoice value" }]} /></div>
          <table className="tbl">
            <thead><tr><th>Rate</th><th className="num">Taxable</th><th className="num">CGST</th><th className="num">SGST</th><th className="num">Total</th></tr></thead>
            <tbody>{d.by_rate.map((r) => <tr key={r.rate}><td>{r.rate}%</td><td className="num">{r.taxable.toFixed(2)}</td><td className="num">{r.cgst.toFixed(2)}</td><td className="num">{r.sgst.toFixed(2)}</td><td className="num">{r.total.toFixed(2)}</td></tr>)}</tbody>
          </table>
        </div>
        <div className="card mt table-wrap">
          <div className="card-title"><h3>HSN summary</h3><Csv name={`hsn-${d.from}-${d.to}`} rows={d.by_hsn} cols={[{ key: "hsn", label: "HSN" }, { key: "rate", label: "GST %" }, { key: "qty", label: "Qty (pcs)" }, { key: "taxable", label: "Taxable" }, { key: "tax", label: "Tax" }, { key: "total", label: "Total" }]} /></div>
          <table className="tbl">
            <thead><tr><th>HSN</th><th>Rate</th><th className="num">Qty</th><th className="num">Taxable</th><th className="num">Tax</th></tr></thead>
            <tbody>{d.by_hsn.map((h) => <tr key={h.hsn + h.rate}><td>{h.hsn}</td><td>{h.rate}%</td><td className="num">{h.qty}</td><td className="num">{h.taxable.toFixed(2)}</td><td className="num">{h.tax.toFixed(2)}</td></tr>)}</tbody>
          </table>
        </div>
        <div className="card mt">
          <div className="card-title"><h3>B2C (no GSTIN)</h3></div>
          <div className="kv small"><span className="k">Bills</span><span>{d.b2c.bills}</span></div>
          <div className="kv small"><span className="k">Taxable</span><span>{inr(d.b2c.taxable, { paise: true })}</span></div>
          <div className="kv small"><span className="k">CGST / SGST</span><span>{inr(d.b2c.cgst, { paise: true })} / {inr(d.b2c.sgst, { paise: true })}</span></div>
        </div>
        {d.b2b.length > 0 && (
          <div className="card mt table-wrap">
            <div className="card-title"><h3>B2B invoices</h3><Csv name={`b2b-${d.from}-${d.to}`} rows={d.b2b} cols={[{ key: "invoice_no", label: "Invoice" }, { key: "date", label: "Date" }, { key: "gstin", label: "GSTIN" }, { key: "name", label: "Name" }, { key: "taxable", label: "Taxable" }, { key: "cgst", label: "CGST" }, { key: "sgst", label: "SGST" }, { key: "total", label: "Total" }]} /></div>
            <table className="tbl">
              <thead><tr><th>Invoice</th><th>GSTIN</th><th className="num">Taxable</th><th className="num">Total</th></tr></thead>
              <tbody>{d.b2b.map((b) => <tr key={b.invoice_no}><td>{b.invoice_no}<div className="tiny muted">{b.name}</div></td><td>{b.gstin}</td><td className="num">{b.taxable.toFixed(2)}</td><td className="num">{b.total.toFixed(2)}</td></tr>)}</tbody>
            </table>
          </div>
        )}
        {d.credit_notes_by_rate.length > 0 && (
          <div className="card mt">
            <div className="card-title"><h3>Credit notes (returns)</h3></div>
            {d.credit_notes_by_rate.map((c) => <div key={c.rate} className="kv small"><span>{c.rate}% · taxable {c.taxable.toFixed(2)}</span><span>tax {c.tax.toFixed(2)}</span></div>)}
          </div>
        )}
        <div className="tiny muted mt">Share these figures with your accountant for GSTR-1 / GSTR-3B.</div>
      </>
    );

  if (type === "product_sales")
    return (
      <div className="card table-wrap">
        <div className="card-title">
          <h3>Total {inr(d.totals.amount)} · profit {inr(Math.round(d.totals.profit))}</h3>
          <Csv name={`best-sellers-${d.group}-${d.from}-${d.to}`} rows={d.rows} cols={[{ key: "label", label: "Name" }, { key: "pcs", label: "Pieces" }, { key: "ml", label: "ml" }, { key: "amount", label: "Sales" }, { key: "cost", label: "Cost" }, { key: "profit", label: "Profit" }]} />
        </div>
        <table className="tbl">
          <thead><tr><th>Name</th><th className="num">Qty</th><th className="num">Sales</th><th className="num">Profit</th></tr></thead>
          <tbody>
            {d.rows.map((r, i) => (
              <tr key={i}><td>{r.label}</td><td className="num">{r.pcs ? `${r.pcs}` : ""}{r.ml ? `${r.pcs ? " + " : ""}${r.ml}ml` : ""}</td><td className="num">{inr(r.amount)}</td><td className="num">{inr(Math.round(r.profit))}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    );

  if (type === "sales_register")
    return (
      <div className="card table-wrap">
        <div className="card-title">
          <h3>{d.totals.bills} bills · {inr(d.totals.total)}</h3>
          <Csv name={`sales-register-${d.from}-${d.to}`} rows={d.rows} cols={[{ key: "invoice_no", label: "Invoice" }, { key: "date", label: "Date" }, { key: "customer", label: "Customer" }, { key: "phone", label: "Phone" }, { key: "gstin", label: "GSTIN" }, { key: "salesperson", label: "Salesperson" }, { key: "taxable", label: "Taxable" }, { key: "cgst", label: "CGST" }, { key: "sgst", label: "SGST" }, { key: "round_off", label: "Round off" }, { key: "total", label: "Total" }, { key: "refunded", label: "Refunded" }, { key: "status", label: "Status" }]} />
        </div>
        <table className="tbl">
          <thead><tr><th>Bill</th><th>Salesperson</th><th className="num">Taxable</th><th className="num">GST</th><th className="num">Total</th></tr></thead>
          <tbody>{d.rows.map((r) => <tr key={r.invoice_no}><td>{r.invoice_no}<div className="tiny muted">{fmtDateTime(r.date)} · {r.customer}</div></td><td>{r.salesperson}</td><td className="num">{r.taxable.toFixed(2)}</td><td className="num">{(r.cgst + r.sgst).toFixed(2)}</td><td className="num"><b>{inr(r.total)}</b></td></tr>)}</tbody>
          <tfoot><tr><td colSpan={2}>Total</td><td className="num">{d.totals.taxable.toFixed(2)}</td><td className="num">{(d.totals.cgst + d.totals.sgst).toFixed(2)}</td><td className="num">{inr(d.totals.total)}</td></tr></tfoot>
        </table>
        {d.totals.returns > 0 && <div className="small mt">Returns (credit notes) in period: −{inr(d.totals.returns)}</div>}
      </div>
    );

  if (type === "stock_valuation")
    return (
      <>
        <div className="grid-2">
          <Stat cls="brown" label="Stock at cost" value={inr(Math.round(d.totals.cost))} />
          <Stat cls="gold" label="Stock at selling price" value={inr(Math.round(d.totals.retail))} />
        </div>
        <div className="card mt table-wrap">
          <div className="card-title"><h3>By category</h3><Csv name={`stock-${istDate()}`} rows={d.items} cols={[{ key: "name", label: "Product" }, { key: "brand", label: "Brand" }, { key: "size", label: "Size" }, { key: "category", label: "Category" }, { key: "barcode", label: "Barcode" }, { key: "stock_qty", label: "Stock" }, { key: "unit", label: "Unit" }, { key: "avg_cost", label: "Avg cost" }, { key: "sell_price", label: "Price" }, { key: "cost", label: "Value at cost" }, { key: "retail", label: "Value at price" }]} /></div>
          <table className="tbl">
            <thead><tr><th>Category</th><th className="num">Qty</th><th className="num">Cost</th><th className="num">Retail</th></tr></thead>
            <tbody>{d.categories.map((c) => <tr key={c.category}><td>{c.category}</td><td className="num">{c.pcs ? c.pcs : ""}{c.ml ? `${c.pcs ? " + " : ""}${c.ml}ml` : ""}</td><td className="num">{inr(Math.round(c.cost))}</td><td className="num">{inr(Math.round(c.retail))}</td></tr>)}</tbody>
          </table>
        </div>
      </>
    );

  if (type === "expenses")
    return (
      <>
        <Stat cls="brown" label="Total expenses" value={inr(d.total)} />
        <div className="card mt">
          <div className="card-title"><h3>By category</h3><Csv name={`expenses-${d.from}-${d.to}`} rows={d.rows} cols={[{ key: "date", label: "Date" }, { key: "category", label: "Category" }, { key: "title", label: "Title" }, { key: "amount", label: "Amount" }, { key: "method", label: "Paid by" }]} /></div>
          {d.by_category.map((c) => (
            <div key={c.category} className="mb">
              <div className="row between small"><b>{c.category}</b><span>{inr(c.amount)}</span></div>
              <div className="bar-track"><div className="bar-fill" style={{ width: `${(c.amount / Math.max(1, d.total)) * 100}%` }} /></div>
            </div>
          ))}
        </div>
      </>
    );
  return null;
}

// Day close: what was sold and what's left — refill candidates first
function ItemsSold({ items, date }) {
  const qty = (q, unit) => `${q}${unit === "ml" ? " ml" : ""}`;
  const refills = items.filter((i) => i.refill).length;
  return (
    <div className="card mt table-wrap">
      <div className="card-title">
        <h3>
          Items sold ({items.length}){refills > 0 && <span className="small bad-text"> · {refills} to refill</span>}
        </h3>
        {items.length > 0 && (
          <Csv
            name={`items-sold-${date}`}
            rows={items}
            cols={[
              { key: "name", label: "Product" },
              { key: "brand", label: "Brand" },
              { get: (i) => (i.unit === "ml" ? "Loose (ml)" : i.size), label: "Size" },
              { key: "qty", label: "Sold" },
              { key: "stock_left", label: "Stock left" },
              { get: (i) => (i.refill ? "REFILL" : ""), label: "Refill" },
            ]}
          />
        )}
      </div>
      {items.length === 0 ? (
        <div className="muted small">Nothing sold.</div>
      ) : (
        <table className="tbl">
          <thead>
            <tr><th>Item</th><th className="num">Sold</th><th className="num">Left</th></tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.variant_id} style={i.refill ? { background: "var(--bad-soft)" } : null}>
                <td>
                  <b>{i.name}</b> {i.unit === "ml" ? "" : <span className="muted">{i.size}</span>}
                  {i.brand && <div className="tiny muted">{i.brand}</div>}
                </td>
                <td className="num">{qty(i.qty, i.unit)}</td>
                <td className="num">
                  {qty(i.stock_left, i.unit)}
                  {i.refill && <div><span className="badge bad">Refill</span></div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SalesmenTable({ rows, title, full, csv }) {
  return (
    <div className="card mt table-wrap">
      <div className="card-title">
        <h3 className="row gap-s"><Trophy size={17} color="var(--gold-dark)" /> {title}</h3>
        {csv && <Csv name="salesman-performance" rows={rows} cols={[{ key: "name", label: "Salesperson" }, { key: "bills", label: "Bills" }, { key: "items", label: "Items" }, { key: "new_customers", label: "New customers" }, { key: "gross", label: "Gross" }, { key: "discount", label: "Discount" }, { key: "sales", label: "Sales" }, { key: "returns", label: "Returns" }, { key: "net", label: "Net" }, { key: "avg_bill", label: "Avg bill" }]} />}
      </div>
      {rows.length === 0 ? (
        <div className="muted small">No sales.</div>
      ) : (
        <table className="tbl">
          <thead><tr><th>Salesperson</th><th className="num">Bills</th>{full && <th className="num">Disc.</th>}<th className="num">Returns</th><th className="num">Net</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.salesman_id}><td><b>{r.name}</b><div className="tiny muted">{plural("item", r.items || 0)} · avg {inr(Math.round(r.avg_bill))}</div><div className="tiny muted">{plural("new customer", r.new_customers || 0)}</div></td><td className="num">{r.bills}</td>{full && <td className="num">{inr(r.discount)}</td>}<td className="num">{inr(r.returns)}</td><td className="num"><b>{inr(r.net)}</b></td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

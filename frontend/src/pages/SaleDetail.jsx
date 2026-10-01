import { useEffect, useState } from "react";
import { MessageCircle, Printer, FileText, Undo2, Ban, Repeat2, Share2, CloudUpload, CheckCircle2 } from "lucide-react";
import { useApp } from "../store";
import { api } from "../lib/api";
import { runBusy } from "../lib/busy";
import { navigate } from "../lib/router";
import { inr, fmtDateTime, qtyLabel, istDate, METHOD_LABEL, r2 } from "../lib/format";
import { a4InvoiceHtml, billText, printHtml, receiptHtml, whatsappLink } from "../lib/print";
import TopBar from "../components/TopBar";
import { Button, Chips, Field, Seg, Sheet, SkeletonList, Stepper } from "../components/ui";
import { STATUS } from "./Sales";

export default function SaleDetail({ id }) {
  const { settings, isManager, toast, refreshCatalog, multiBranch, cart, setCart } = useApp();
  const shop = { ...settings, multi_branch: multiBranch };
  const [d, setD] = useState(null);
  const [ret, setRet] = useState(null); // "return" | "exchange"
  const [voidOpen, setVoidOpen] = useState(false);

  const load = () =>
    api("getSale", { id })
      .then((r) => setD(r.data))
      .catch((e) => toast(e.message, "error"));
  useEffect(() => {
    load();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!d)
    return (
      <>
        <TopBar title="Bill" back="sales" />
        <div className="page">
          <SkeletonList rows={4} height={70} />
        </div>
      </>
    );

  const s = d.sale;
  const st = STATUS[s.status] || STATUS.completed;
  const showGst = !s.gst_hidden; // a bill printed without GST shows none here either — like its receipt / A4 / PDF
  const text = billText(d, shop);
  const canReturn = (isManager || returnCapOf(settings) > 0) && (s.status === "completed" || s.status === "part_returned");
  const canExchange = s.status === "completed" || s.status === "part_returned";
  const canVoid = isManager && s.status === "completed" && s.date.slice(0, 10) === istDate();
  const after = (r) => {
    setD(r.data);
    refreshCatalog();
  };

  return (
    <>
      <TopBar title={s.invoice_no} back="sales" />
      <div className="page">
        <div className="card">
          <div className="row between">
            <div>
              <div className="serif bold" style={{ fontSize: 26 }}>{inr(s.grand_total)}</div>
              <div className="small muted">{fmtDateTime(s.date)}</div>
            </div>
            <div className="col gap-s" style={{ alignItems: "flex-end" }}>
              <span className={"badge " + st.cls}>{st.label}</span>
              {s.gst_hidden ? <span className="badge">{s.gst_hidden === 2 ? "No GST (branch)" : "GST not shown on bill"}</span> : null}
              {multiBranch && d.branch ? <span className="badge gold">{d.branch.name}</span> : null}
            </div>
          </div>
          <div className="divider" />
          <div className="kv small"><span className="k">Served by</span><b>{s.salesman_name}</b></div>
          <div className="kv small"><span className="k">Customer</span><span>{s.customer_name || "Walk-in"} {s.customer_phone}</span></div>
          {showGst && s.customer_gstin && <div className="kv small"><span className="k">GSTIN</span><span>{s.customer_gstin}</span></div>}
          {s.notes && <div className="kv small"><span className="k">Note</span><span>{s.notes}</span></div>}
        </div>

        <div className="section-label">Items</div>
        <div className="list">
          {d.items.map((i) => (
            <div key={i.id} className="list-item" style={{ cursor: "default" }}>
              <div className="grow">
                <div className="title">{i.product_name} <span className="muted">{i.size}</span></div>
                <div className="sub">
                  {qtyLabel(i.qty, i.unit)} × {inr(i.price, { paise: i.unit === "ml" })}
                  {i.discount + i.bill_disc_share > 0 && ` · disc ${inr(r2(i.discount + i.bill_disc_share))}`}
                  {showGst && ` · GST ${i.gst_rate}%`}
                  {i.returned_qty > 0 && <span className="bad-text"> · returned {qtyLabel(i.returned_qty, i.unit)}</span>}
                </div>
              </div>
              <b className="money">{inr(i.line_total)}</b>
            </div>
          ))}
        </div>

        <div className="card mt">
          <div className="kv"><span className="k">Items total</span><span>{inr(s.gross)}</span></div>
          {s.item_disc + s.bill_disc > 0 && <div className="kv"><span className="k">Discount</span><span className="ok-text">−{inr(r2(s.item_disc + s.bill_disc))}</span></div>}
          {showGst && <div className="kv"><span className="k">Taxable value</span><span>{inr(s.taxable, { paise: true })}</span></div>}
          {showGst && <div className="kv"><span className="k">CGST + SGST</span><span>{inr(r2(s.cgst + s.sgst), { paise: true })}</span></div>}
          {s.round_off !== 0 && <div className="kv"><span className="k">Round off</span><span>{inr(s.round_off, { paise: true })}</span></div>}
          <div className="kv total"><span>Total</span><span>{inr(s.grand_total)}</span></div>
          {d.payments.map((p) => (
            <div key={p.id} className="kv small">
              <span className="k">
                {p.amount < 0 ? "Refund" : "Paid"} · {METHOD_LABEL[p.method]} {p.reference && p.reference !== "VOID" ? `(${p.reference})` : ""}
              </span>
              <span className={p.amount < 0 ? "bad-text" : ""}>{inr(p.amount)}</span>
            </div>
          ))}
          {s.change > 0 && <div className="kv small"><span className="k">Change returned</span><span>{inr(s.change)}</span></div>}
        </div>

        {d.returns.length > 0 && (
          <>
            <div className="section-label">Returns</div>
            {d.returns.map((r) => (
              <div key={r.id} className="card">
                <div className="row between">
                  <b>{r.credit_note_no}</b>
                  <b className="bad-text">−{inr(r.total)}</b>
                </div>
                <div className="small muted">
                  {fmtDateTime(r.at)} · refund by {METHOD_LABEL[r.refund_method]} · {r.reason}
                </div>
              </div>
            ))}
          </>
        )}

        <div className="grid-2 mt">
          <a className="btn wa" href={whatsappLink(s.customer_phone, text)} target="_blank" rel="noreferrer">
            <MessageCircle size={18} /> WhatsApp
          </a>
          <button className="btn secondary" onClick={() => printHtml(receiptHtml(d, shop))}>
            <Printer size={18} /> Receipt
          </button>
          <button className="btn secondary" onClick={() => printHtml(a4InvoiceHtml(d, shop))}>
            <FileText size={18} /> A4 invoice
          </button>
          {navigator.share && (
            <button className="btn secondary" onClick={() => navigator.share({ title: s.invoice_no, text }).catch(() => {})}>
              <Share2 size={18} /> Share
            </button>
          )}
          {canExchange && (
            <button className="btn secondary" onClick={() => setRet("exchange")}>
              <Repeat2 size={18} /> Exchange
            </button>
          )}
          {canReturn && (
            <button className="btn secondary" onClick={() => setRet("return")}>
              <Undo2 size={18} /> Return items
            </button>
          )}
          {canVoid && (
            <button className="btn danger" onClick={() => setVoidOpen(true)}>
              <Ban size={18} /> Void bill
            </button>
          )}
        </div>
        <DrivePdf sale={s} onSaved={(pdf_url) => setD((x) => ({ ...x, sale: { ...x.sale, pdf_url } }))} />
      </div>
      <ReturnSheet
        mode={ret}
        onClose={() => setRet(null)}
        detail={d}
        onDone={after}
        onExchange={(picked, credit) => {
          // carry the swap into the Sell screen: the replacement is chosen there, with the scanner
          // and the search staff already use, and nothing is saved until checkout
          setCart((c) => ({
            ...c,
            client_ref: null,
            customer: c.lines.length ? c.customer : { phone: s.customer_phone || "", name: s.customer_name || "", gstin: "" },
            exchange: { sale_id: s.id, invoice_no: s.invoice_no, reason: picked.reason, items: picked.items, back: picked.back, credit },
          }));
          setRet(null);
          toast(cart.lines.length ? "Exchange started — your bill in progress is the replacement" : "Now choose the replacement", "success", 3500);
          navigate("sell");
        }}
      />
      <VoidSheet open={voidOpen} onClose={() => setVoidOpen(false)} sale={s} onDone={after} />
    </>
  );
}

// most a salesperson may have back on one bill — the server enforces this, the app only keeps
// staff from filling in a return it would refuse. Absent (an older backend) = the same default.
const returnCapOf = (settings) => {
  const v = settings.salesperson_max_return;
  return v === undefined || v === null || v === "" ? 2000 : Number(v) || 0;
};

const REASONS = ["Damaged / leaked", "Wrong item", "Wrong size", "Customer changed mind"];

// invoice PDF in Google Drive (Groovy Kiosk/Sales_Invoices) — made on the server, so the app stays light
function DrivePdf({ sale, onSaved }) {
  const { isAdmin, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api("saveInvoicePdf", { id: sale.id });
      onSaved(r.data.pdf_url);
      toast(r.message, "success");
    } catch (e) {
      toast(e.message, "error", 4000);
    } finally {
      setBusy(false);
    }
  };
  if (sale.pdf_url)
    return (
      <div className="row between mt small" style={{ padding: "4px 2px" }}>
        <span className="row gap-s" style={{ color: "var(--ok)" }}>
          <CheckCircle2 size={17} /> PDF saved in Google Drive
        </span>
        {isAdmin && (
          <a className="bold" href={sale.pdf_url.replace(/#void$/, "")} target="_blank" rel="noreferrer">
            Open
          </a>
        )}
      </div>
    );
  return (
    <Button className="secondary block mt" loading={busy} onClick={save}>
      <CloudUpload size={18} /> {busy ? "Saving PDF…" : "Save PDF to Drive"}
    </Button>
  );
}

function ReturnSheet({ mode, onClose, detail, onDone, onExchange }) {
  const open = !!mode;
  const swap = mode === "exchange";
  const { toast, isAdmin, isManager, settings } = useApp();
  const [qty, setQty] = useState({});
  const [restock, setRestock] = useState({});
  const [method, setMethod] = useState("cash");
  const [reason, setReason] = useState(REASONS[0]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setQty({});
      setRestock({});
      setMethod("cash");
      setReason(REASONS[0]);
    }
  }, [open]);

  const avail = (i) => r2(i.qty - i.returned_qty);
  const refund = r2(detail.items.reduce((s, i) => s + ((qty[i.id] || 0) * i.line_total) / i.qty, 0));
  const days = Math.floor((new Date(istDate()) - new Date(detail.sale.date.slice(0, 10))) / 86400000);
  const late = days > Number(settings.return_days || 3);
  // a salesperson is capped per bill, earlier returns on it counted
  const cap = returnCapOf(settings);
  const left = r2(cap - Number(detail.sale.refunded || 0));
  const overCap = !swap && !isManager && refund > left + 0.001;

  const chooseReplacement = () => {
    const picked = detail.items.filter((i) => qty[i.id] > 0);
    onExchange(
      {
        reason,
        items: picked.map((i) => ({ sale_item_id: i.id, qty: qty[i.id], restock: restock[i.id] !== false })),
        back: picked.filter((i) => restock[i.id] !== false).map((i) => ({ variant_id: i.variant_id, qty: qty[i.id] })),
      },
      refund,
    );
  };

  const submit = async () => {
    setBusy(true);
    try {
      const r = await runBusy("Saving return…", () => api("returnItems", {
        sale_id: detail.sale.id,
        items: detail.items.filter((i) => qty[i.id] > 0).map((i) => ({ sale_item_id: i.id, qty: qty[i.id], restock: restock[i.id] !== false })),
        refund_method: method,
        reason,
        override: late && isAdmin,
      }));
      toast(r.message, "success", 4000);
      onDone(r);
      onClose();
    } catch (e) {
      toast(e.message, "error", 4000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={swap ? "Exchange — what is coming back?" : "Return items"}
      full
      footer={
        <Button
          className="big block"
          loading={busy}
          disabled={refund <= 0 || (late && !isAdmin) || overCap}
          onClick={swap ? chooseReplacement : submit}
        >
          {swap ? `Choose replacement · ${inr(refund)} credit` : `Refund ${inr(refund)}`}
        </Button>
      }
    >
      {!swap && !isManager && !late && (
        <div className="tiny mb center" style={overCap ? { color: "var(--bad)", fontWeight: 700 } : { color: "var(--muted)" }}>
          {left > 0
            ? `You can refund up to ${inr(left)} on this bill. Ask a manager for more.`
            : "Only a manager can accept a return on this bill."}
        </div>
      )}
      {late && (
        <div className="card mb" style={{ background: "var(--gold-soft)" }}>
          This bill is {days} days old (return window {settings.return_days || 3} days). {isAdmin ? "As the owner you can still accept it." : "Only the owner can accept this return."}
        </div>
      )}
      <div className="list">
        {detail.items.map((i) =>
          avail(i) <= 0 ? null : (
            <div key={i.id} className="list-item" style={{ cursor: "default", flexWrap: "wrap" }}>
              <div className="grow">
                <div className="title">{i.product_name} {i.size}</div>
                <div className="sub">
                  Bought {qtyLabel(i.qty, i.unit)} · can return {qtyLabel(avail(i), i.unit)}
                </div>
              </div>
              <Stepper value={qty[i.id] || 0} min={0} max={avail(i)} decimals={i.unit === "ml" ? 1 : 0} onChange={(v) => setQty((q) => ({ ...q, [i.id]: v }))} />
              {qty[i.id] > 0 && (
                <label className="row small" style={{ flexBasis: "100%", marginTop: 6 }}>
                  <input type="checkbox" checked={restock[i.id] !== false} onChange={(e) => setRestock((r) => ({ ...r, [i.id]: e.target.checked }))} />
                  Put back in stock (untick if damaged)
                </label>
              )}
            </div>
          ),
        )}
      </div>
      {!swap && <div className="section-label">Refund by</div>}
      {!swap && (
        <Seg value={method} onChange={setMethod} options={["cash", "upi", "card"].map((m) => ({ value: m, label: METHOD_LABEL[m] }))} />
      )}
      <div className="section-label">Reason</div>
      <Chips value={reason} onChange={setReason} options={REASONS.map((r) => ({ value: r, label: r }))} />
    </Sheet>
  );
}

function VoidSheet({ open, onClose, sale, onDone }) {
  const { toast } = useApp();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await runBusy("Voiding bill…", () => api("voidSale", { id: sale.id, reason }));
      toast(r.message, "success");
      onDone(r);
      onClose();
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Void this bill?"
      footer={
        <Button className="danger big block" loading={busy} disabled={!reason.trim()} onClick={submit}>
          Void bill {sale.invoice_no}
        </Button>
      }
    >
      <p className="small" style={{ marginTop: 0 }}>
        Use this only for a mistake made today. All items go back to stock and the full {inr(sale.grand_total)} is marked as refunded. For customer returns use “Return items”.
      </p>
      <Field label="Reason">
        <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Billed wrong item" autoFocus />
      </Field>
    </Sheet>
  );
}

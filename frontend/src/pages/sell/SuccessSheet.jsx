import { Check, MessageCircle, Printer, FileText, Share2, Plus } from "lucide-react";
import { useApp } from "../../store";
import { inr, qtyLabel, METHOD_LABEL } from "../../lib/format";
import { a4InvoiceHtml, billText, printHtml, receiptHtml, whatsappLink } from "../../lib/print";
import { Sheet } from "../../components/ui";

export default function SuccessSheet({ detail, onClose }) {
  const { settings, multiBranch } = useApp();
  if (!detail) return null;
  const shop = { ...settings, multi_branch: multiBranch };
  const s = detail.sale;
  const text = billText(detail, shop);
  const swap = detail.exchange || null; // set when this bill came out of an exchange
  const share = async () => {
    try {
      await navigator.share({ title: s.invoice_no, text });
    } catch {
      /* user cancelled */
    }
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={swap ? "Exchange complete" : "Sale complete"}
      full
      footer={
        <button className="btn big block" onClick={onClose}>
          <Plus size={20} /> New sale
        </button>
      }
    >
      {swap && (
        <div className="card mb" style={{ background: "var(--gold-soft)" }}>
          <div>
            Credit note <b>{swap.credit_note_no}</b> for {inr(swap.credit)} against bill {swap.from_invoice_no}
          </div>
          {swap.refunded > 0 && <div className="mt">{inr(swap.refunded)} was given back to the customer.</div>}
        </div>
      )}
      <SaleSummary detail={detail} />
      <div className="grid-2 mt">
        <a className="btn wa" href={whatsappLink(s.customer_phone, text)} target="_blank" rel="noreferrer">
          <MessageCircle size={18} /> WhatsApp
        </a>
        {navigator.share ? (
          <button className="btn secondary" onClick={share}>
            <Share2 size={18} /> Share
          </button>
        ) : (
          <button className="btn secondary" onClick={() => printHtml(a4InvoiceHtml(detail, shop))}>
            <FileText size={18} /> A4 invoice
          </button>
        )}
        <button className="btn secondary" onClick={() => printHtml(receiptHtml(detail, shop))}>
          <Printer size={18} /> Print receipt
        </button>
        {navigator.share && (
          <button className="btn secondary" onClick={() => printHtml(a4InvoiceHtml(detail, shop))}>
            <FileText size={18} /> A4 invoice
          </button>
        )}
      </div>
    </Sheet>
  );
}

export function SaleSummary({ detail }) {
  const s = detail.sale;
  const pays = detail.payments.filter((p) => p.amount > 0 && !p.return_id);
  return (
    <>
      <div className="success-hero">
        <div className="tick">
          <Check size={40} strokeWidth={3} />
        </div>
        <div className="serif bold" style={{ fontSize: 30 }}>{inr(s.grand_total)}</div>
        <div className="muted">{s.invoice_no}</div>
        {s.gst_hidden ? <div className="badge mt">{s.gst_hidden === 2 ? "No GST (branch)" : "GST not shown on bill"}</div> : null}
        {s.change > 0 && (
          <div className="badge gold mt" style={{ fontSize: 15, padding: "6px 12px" }}>
            Give back change {inr(s.change)}
          </div>
        )}
      </div>
      <div className="card">
        <div className="row between small">
          <span className="muted">Served by</span>
          <b>{s.salesman_name}</b>
        </div>
        {(s.customer_name || s.customer_phone) && (
          <div className="row between small mt">
            <span className="muted">Customer</span>
            <b>
              {s.customer_name} {s.customer_phone}
            </b>
          </div>
        )}
        <div className="divider" />
        {detail.items.map((i) => (
          <div key={i.id} className="kv small">
            <span>
              {i.product_name} {i.unit === "ml" ? "" : i.size} × {qtyLabel(i.qty, i.unit)}
            </span>
            <span className="money">{inr(i.line_total)}</span>
          </div>
        ))}
        <div className="divider" />
        {pays.map((p) => (
          <div key={p.id} className="kv small">
            <span className="k">{METHOD_LABEL[p.method]}</span>
            <span className="money">{inr(p.amount)}</span>
          </div>
        ))}
      </div>
    </>
  );
}

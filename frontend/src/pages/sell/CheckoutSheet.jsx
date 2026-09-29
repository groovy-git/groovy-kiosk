import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, X, UserCheck, Building2 } from "lucide-react";
import { useApp } from "../../store";
import { api } from "../../lib/api";
import { runBusy } from "../../lib/busy";
import { newClientRef } from "../../lib/cart";
import { inr, r2, METHOD_LABEL } from "../../lib/format";
import { Button, Field, MoneyInput, Seg, Sheet, Spinner } from "../../components/ui";

const METHODS = ["upi", "cash", "card"]; // UPI first: most customers pay that way

export default function CheckoutSheet({ open, onClose, preview, onDone }) {
  const { cart, setCart, clearCart, sellers, user, role, settings, toast, patchStock, catalog, online } = useApp();
  // bill discount in % by default (the shop's usual); a discount already on the bill is kept in rupees in the
  // cart, so it reopens in ₹ showing that exact amount — never re-read as a percentage
  const [discMode, setDiscMode] = useState(cart.bill_disc ? "rs" : "pct");
  const [discText, setDiscText] = useState("");
  const total = preview.grand_total;
  const swap = cart.exchange || null;
  const credit = swap ? r2(swap.credit) : 0;
  const due = r2(Math.max(0, total - credit)); // what the customer still pays
  const back = r2(Math.max(0, credit - total)); // what goes back to them, if the replacement is cheaper
  const [backMethod, setBackMethod] = useState("upi");
  // payment rows; `auto` rows follow the bill total until the user types an amount
  const [pays, setPays] = useState(() => [{ method: "upi", amount: String(due), reference: "", auto: true }]);
  const [known, setKnown] = useState(null);
  const [lookup, setLookup] = useState("idle"); // idle | loading | found | new
  const autoFill = useRef({ name: "", gstin: "" }); // values filled from the customer lookup
  const [showGstin, setShowGstin] = useState(false);
  const [busy, setBusy] = useState(false);
  const cust = cart.customer || { phone: "", name: "", gstin: "" };
  const custRef = useRef(cust);
  custRef.current = cust;
  const sellerId = cart.salesman_id || user.id;
  const gstOnBill = !cart.gst_hidden;

  useEffect(() => {
    if (!open) return;
    setPays([{ method: "upi", amount: String(due), reference: "", auto: true }]);
    setDiscText(cart.bill_disc ? String(cart.bill_disc) : "");
    setDiscMode(cart.bill_disc ? "rs" : "pct");
    setShowGstin(!!cust.gstin);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // bill discount → rupees in cart (drives the live preview)
  const applyDisc = (text, mode = discMode) => {
    setDiscText(text);
    const n = Number(text) || 0;
    const base = r2(preview.gross - preview.item_disc);
    const rs = mode === "pct" ? r2((base * Math.min(n, 100)) / 100) : Math.min(n, base);
    setCart((c) => ({ ...c, bill_disc: rs }));
  };

  // an untouched first payment takes whatever the other rows leave of the bill
  const balance = (ps) => {
    if (!ps.length || !ps[0].auto) return ps;
    const others = ps.slice(1).reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const amount = String(Math.max(0, r2(due - others)));
    return ps[0].amount === amount ? ps : [{ ...ps[0], amount }, ...ps.slice(1)];
  };

  // keep it balanced when the total moves (e.g. after a bill discount)
  useEffect(() => {
    setPays(balance);
  }, [total, due]); // eslint-disable-line react-hooks/exhaustive-deps

  // returning customer lookup by phone → pre-fill name (and GSTIN)
  useEffect(() => {
    const p = (cust.phone || "").replace(/\D/g, "");
    setKnown(null);
    // number changed: drop what was auto-filled for the previous number (typed names stay)
    const a = autoFill.current;
    autoFill.current = { name: "", gstin: "" };
    const clear = {};
    if (a.name && cust.name === a.name) clear.name = "";
    if (a.gstin && cust.gstin === a.gstin) clear.gstin = "";
    if (Object.keys(clear).length) setCust(clear);
    if (p.length !== 10) {
      setLookup("idle");
      return;
    }
    setLookup("loading");
    let live = true;
    api("findCustomer", { phone: p })
      .then((r) => {
        if (!live) return;
        if (!r.data) return setLookup("new");
        setKnown(r.data);
        setLookup("found");
        if (r.data.gstin) setShowGstin(true);
        const cu = custRef.current; // latest values — the salesman may have typed while we waited
        autoFill.current = { name: cu.name ? "" : r.data.name, gstin: cu.gstin ? "" : r.data.gstin };
        setCust({ name: cu.name || r.data.name, gstin: cu.gstin || r.data.gstin });
      })
      .catch(() => live && setLookup("idle"));
    return () => {
      live = false;
    };
  }, [cust.phone]); // eslint-disable-line react-hooks/exhaustive-deps

  const setCust = (patch) => setCart((c) => ({ ...c, customer: { ...c.customer, ...patch } }));

  const rows = useMemo(() => pays.map((p) => ({ ...p, amount: Number(p.amount) || 0 })), [pays]);
  const tendered = r2(rows.reduce((s, p) => s + p.amount, 0));
  const cash = r2(rows.filter((p) => p.method === "cash").reduce((s, p) => s + p.amount, 0));
  const change = r2(tendered - due);
  const short = r2(due - tendered);
  const nonCashOver = r2(tendered - cash) > due;
  const canPay = total >= 0 && short <= 0 && change <= cash && !nonCashOver;

  const setPay = (i, patch) => setPays((ps) => balance(ps.map((p, j) => (j === i ? { ...p, ...patch } : p))));
  const removePay = (i) => setPays((ps) => balance(ps.filter((_, j) => j !== i)));
  // a new row starts empty unless the rows above leave something unpaid
  const addSplit = () =>
    setPays((ps) => {
      const paid = ps.reduce((s, p) => s + (Number(p.amount) || 0), 0);
      const left = r2(due - paid);
      const used = new Set(ps.map((p) => p.method));
      return [...ps, { method: METHODS.find((m) => !used.has(m)) || "upi", amount: left > 0 ? String(left) : "", reference: "", auto: false }];
    });

  const complete = async () => {
    const phone = (cust.phone || "").replace(/\D/g, "");
    if (phone && phone.length !== 10) return toast("Enter a 10-digit mobile number or leave it empty", "error");
    const ref = cart.client_ref || newClientRef();
    if (!cart.client_ref) setCart((c) => ({ ...c, client_ref: ref }));
    setBusy(true);
    try {
      const r = await runBusy(swap ? "Saving exchange…" : "Saving sale…", () => api(swap ? "exchange" : "completeSale", {
        client_ref: ref,
        lines: cart.lines.filter((l) => catalog.byVariant.has(l.variant_id)).map((l) => ({ variant_id: l.variant_id, qty: l.qty, discount: l.discount || 0 })),
        bill_disc: cart.bill_disc || 0,
        customer: { phone, name: (cust.name || "").trim(), gstin: showGstin ? (cust.gstin || "").trim().toUpperCase() : "" },
        salesman_id: sellerId,
        payments: rows.map((p) => ({ method: p.method, amount: p.amount, reference: p.reference })),
        notes: cart.notes || "",
        held_id: cart.held_id || null,
        gst_hidden: !!cart.gst_hidden,
        // the swap: what is coming back, and how any difference goes out
        ...(swap
          ? { sale_id: swap.sale_id, items: swap.items, reason: swap.reason, refund_method: backMethod, override: swap.override || false }
          : {}),
      }));
      const d = r.data;
      // a swap moves stock both ways: the replacement leaves the shelf, what came back returns to it
      const patches = d.items.map((i) => {
        const it = catalog.byVariant.get(i.variant_id);
        return { id: i.variant_id, stock_qty: r2((it ? it.stock : 0) - i.qty) };
      });
      (swap ? swap.back || [] : []).forEach((b) => {
        const row = patches.find((x) => x.id === b.variant_id);
        if (row) row.stock_qty = r2(row.stock_qty + b.qty); // same product back out again
        else {
          const it = catalog.byVariant.get(b.variant_id);
          patches.push({ id: b.variant_id, stock_qty: r2((it ? it.stock : 0) + b.qty) });
        }
      });
      patchStock(patches);
      clearCart();
      onDone(d);
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
      title="Checkout"
      full
      footer={
        <>
          {short > 0 && <div className="err small center mb bad-text">Short by {inr(short)}</div>}
          {nonCashOver && <div className="small center mb bad-text">UPI/Card can't be more than the bill</div>}
          {change > 0 && change <= cash && (
            <div className="center mb bold" style={{ fontSize: 17 }}>
              Return change: <span className="ok-text">{inr(change)}</span>
            </div>
          )}
          <Button className="big block" loading={busy} disabled={!canPay || !online} onClick={complete}>
            {!online
              ? "Offline — can't save"
              : swap
                ? back > 0
                  ? `Exchange · give back ${inr(back)}`
                  : due > 0
                    ? `Exchange · collect ${inr(due)}`
                    : "Complete exchange"
                : `Complete · ${inr(total)}`}
          </Button>
        </>
      }
    >
      <div className="card">
        <div className="field">
          <label>Customer mobile (optional)</label>
          <div className="input-wrap">
            <span className="prefix" style={{ left: 12 }}>+91</span>
            <input
              className="input"
              style={{ paddingLeft: 46 }}
              type="tel"
              inputMode="numeric"
              maxLength={10}
              placeholder="Walk-in customer"
              value={cust.phone || ""}
              onChange={(e) => setCust({ phone: e.target.value.replace(/\D/g, "").slice(0, 10) })}
            />
          </div>
          {lookup === "loading" && (
            <div className="hint row gap-s">
              <Spinner size={14} /> Looking up customer…
            </div>
          )}
          {lookup === "found" && known && (
            <div className="hint ok-text row gap-s">
              <UserCheck size={14} /> Returning customer · {known.bills} bills · {inr(known.total_spent)}
            </div>
          )}
          {lookup === "new" && <div className="hint">New customer — the name will be saved with this bill</div>}
        </div>
        {(cust.phone || "").length > 0 && (
          <Field label="Customer name">
            <input className="input" value={cust.name || ""} onChange={(e) => setCust({ name: e.target.value })} autoCapitalize="words" />
          </Field>
        )}
        {showGstin ? (
          <Field label="Customer GSTIN (business bill)">
            <input className="input" value={cust.gstin || ""} maxLength={15} onChange={(e) => setCust({ gstin: e.target.value.toUpperCase() })} />
          </Field>
        ) : (
          <button className="btn ghost small" onClick={() => setShowGstin(true)}>
            <Building2 size={16} /> Business customer? Add GSTIN
          </button>
        )}
      </div>

      <div className="card">
        <Field label="Sold by">
          {role === "salesperson" ? (
            <input className="input" value={user.name} disabled />
          ) : (
            <select className="input" value={sellerId} onChange={(e) => setCart((c) => ({ ...c, salesman_id: Number(e.target.value) }))}>
              {sellers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} {s.id === user.id ? "(me)" : ""}
                </option>
              ))}
            </select>
          )}
        </Field>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Bill discount</label>
          <div className="row">
            <div style={{ width: 110 }}>
              <Seg
                value={discMode}
                onChange={(m) => {
                  setDiscMode(m);
                  applyDisc(discText, m);
                }}
                options={[
                  { value: "rs", label: "₹" },
                  { value: "pct", label: "%" },
                ]}
              />
            </div>
            <div className="grow">
              {discMode === "rs" ? (
                <MoneyInput value={discText} onChange={(v) => applyDisc(v)} />
              ) : (
                <input className="input" inputMode="decimal" placeholder="0" value={discText} onChange={(e) => applyDisc(e.target.value.replace(/[^\d.]/g, ""))} />
              )}
            </div>
          </div>
          {role === "salesperson" && <div className="hint">Up to {settings.salesman_max_disc_pct || 10}% in total</div>}
        </div>
      </div>

      <div className="card">
        <div className="kv"><span className="k">Items total</span><span className="money">{inr(preview.gross)}</span></div>
        {preview.item_disc + preview.bill_disc > 0 && (
          <div className="kv"><span className="k">Discount</span><span className="money ok-text">−{inr(r2(preview.item_disc + preview.bill_disc))}</span></div>
        )}
        <label className="kv" style={{ alignItems: "center", cursor: "pointer" }}>
          <span className="row gap-s">
            <input
              type="checkbox"
              checked={gstOnBill}
              onChange={(e) => setCart((c) => ({ ...c, gst_hidden: !e.target.checked }))}
              style={{ width: 20, height: 20, accentColor: "var(--brown)" }}
            />
            <span className="k">Show GST on bill</span>
          </span>
          {gstOnBill ? <span className="money">incl. {inr(preview.tax, { paise: true })}</span> : <span className="small muted">Not printed</span>}
        </label>
        {preview.round_off !== 0 && (
          <div className="kv"><span className="k">Round off</span><span className="money">{inr(preview.round_off, { paise: true })}</span></div>
        )}
        <div className={"kv" + (swap ? "" : " total")}><span>{swap ? "Replacement" : "To pay"}</span><span className="money">{inr(total)}</span></div>
        {swap && (
          <>
            <div className="kv"><span className="k">Exchange credit · {swap.invoice_no}</span><span className="money">-{inr(r2(credit - back))}</span></div>
            <div className="kv total">
              <span>{back > 0 ? "Back to customer" : "To pay"}</span>
              <span className="money">{inr(back > 0 ? back : due)}</span>
            </div>
          </>
        )}
      </div>

      {back > 0 ? (
        <>
          <div className="section-label">Give back {inr(back)} by</div>
          <Seg value={backMethod} onChange={setBackMethod} options={METHODS.map((m) => ({ value: m, label: METHOD_LABEL[m] }))} />
          <div className="hint">The replacement costs less than what came back, so the difference goes to the customer.</div>
        </>
      ) : due === 0 && swap ? (
        <div className="card mt center small">An even swap — nothing to collect.</div>
      ) : (
        <div className="section-label">Payment</div>
      )}
      {back === 0 && !(swap && due === 0) && pays.map((p, i) => (
        <div className="card" key={i}>
          <div className="row">
            <div className="grow">
              <Seg value={p.method} onChange={(m) => setPay(i, { method: m })} options={METHODS.map((m) => ({ value: m, label: METHOD_LABEL[m] }))} />
            </div>
            {pays.length > 1 && (
              <button className="icon-btn" onClick={() => removePay(i)} aria-label="Remove payment">
                <X size={20} />
              </button>
            )}
          </div>
          <div className="row mt">
            <div className="grow">
              <MoneyInput
                value={p.amount}
                placeholder="0"
                onChange={(v) => setPay(i, { amount: v, auto: false })}
                aria-label={(p.method === "cash" ? "Cash received" : METHOD_LABEL[p.method] + " amount")}
              />
            </div>
          </div>
          {p.method !== "cash" && (
            <input
              className="input mt"
              placeholder={p.method === "upi" ? "UPI ref / last 4 digits (optional)" : "Card last 4 digits (optional)"}
              value={p.reference}
              onChange={(e) => setPay(i, { reference: e.target.value })}
            />
          )}
        </div>
      ))}
      {pays.length < 3 && (
        <button className="btn secondary block mt" onClick={addSplit}>
          <Plus size={18} /> Split payment
        </button>
      )}
      <Field label="Note (optional)">
        <input className="input mt" value={cart.notes || ""} onChange={(e) => setCart((c) => ({ ...c, notes: e.target.value }))} placeholder="e.g. gift wrap" />
      </Field>
    </Sheet>
  );
}

import { useEffect, useState } from "react";
import { Trash2, PauseCircle, Tag, Plus } from "lucide-react";
import { useApp } from "../../store";
import { api } from "../../lib/api";
import { runBusy } from "../../lib/busy";
import { removeLine, setLine } from "../../lib/cart";
import { inr, r2 } from "../../lib/format";
import { Button, MoneyInput, Sheet, Stepper, Thumb, useConfirm } from "../../components/ui";

export default function CartSheet({ open, onClose, preview, onCheckout, onHeld }) {
  const { cart, setCart, clearCart, catalog, settings, toast, role } = useApp();
  const [discFor, setDiscFor] = useState(null);
  const [holding, setHolding] = useState(false);
  // this sheet stays mounted between openings, so an item's discount field left open would come back
  // with the bill — autofocused, keyboard and all. Nothing renders while closed, so this is unseen.
  useEffect(() => {
    if (!open) setDiscFor(null);
  }, [open]);
  const [confirm, confirmNode] = useConfirm();
  const allowNeg = settings.allow_negative_stock === "yes";

  const hold = async () => {
    setHolding(true);
    try {
      const c = cart.customer || {};
      const label = c.name || c.phone || `Bill ${new Date().toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}`;
      await runBusy("Holding bill…", () => api("holdBill", { label, cart: { ...cart, client_ref: null } }));
      clearCart();
      toast("Bill held — find it under the clock icon", "success");
      onHeld();
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setHolding(false);
    }
  };

  const clear = async () => {
    if (await confirm({ title: "Clear this bill?", text: "All items will be removed.", okText: "Clear", danger: true })) {
      clearCart();
      onClose();
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Current bill"
      full
      headerRight={
        cart.lines.length > 0 && (
          <button className="icon-btn" onClick={clear} aria-label="Clear bill">
            <Trash2 size={20} />
          </button>
        )
      }
      footer={
        <>
          {/* the way back to the products. Without it the only route out is the ✕ beside the bin,
              which reads as throwing the bill away rather than going back to add more. */}
          <button className="btn secondary block mb" onClick={onClose}>
            <Plus size={18} /> Add more items
          </button>
          <div className="kv">
            <span className="k">Items total</span>
            <span className="money">{inr(preview.gross)}</span>
          </div>
          {preview.item_disc > 0 && (
            <div className="kv">
              <span className="k">Item discounts</span>
              <span className="money ok-text">−{inr(preview.item_disc)}</span>
            </div>
          )}
          <div className="row mt">
            <Button className="secondary" loading={holding} onClick={hold} disabled={!cart.lines.length} aria-label="Hold bill">
              <PauseCircle size={18} /> Hold
            </Button>
            <button className="btn big grow" onClick={onCheckout} disabled={!cart.lines.length}>
              Checkout · {inr(r2(preview.gross - preview.item_disc))}
            </button>
          </div>
        </>
      }
    >
      {cart.lines.length === 0 && <div className="empty">The bill is empty. Tap or scan products to add them.</div>}
      <div className="list">
        {cart.lines.map((l) => {
          const it = catalog.byVariant.get(l.variant_id);
          if (!it) return null;
          const lineGross = r2(it.price * l.qty);
          // a size this branch no longer sells ("Sold at"): only what is left, whatever the setting says
          const max = allowNeg && it.here !== false ? 100000 : it.stock;
          return (
            <div key={l.variant_id} className="list-item" style={{ cursor: "default", alignItems: "flex-start", flexWrap: "wrap" }}>
              <Thumb item={it} size={46} />
              <div className="grow">
                <div className="title">{it.name}</div>
                <div className="sub">
                  {it.size} · {inr(it.price)}
                  {it.unit === "ml" ? "/ml" : ""}
                </div>
                <div className="row mt" style={{ marginTop: 8 }}>
                  <Stepper
                    value={l.qty}
                    min={it.unit === "ml" ? 0.5 : 1}
                    max={max}
                    step={1}
                    decimals={it.unit === "ml" ? 1 : 0}
                    onChange={(v) => setCart((c) => ({ ...c, lines: setLine(c.lines, l.variant_id, { qty: v, discount: Math.min(l.discount || 0, r2(it.price * v)) }) }))}
                  />
                  {it.unit === "ml" && <span className="small muted">ml</span>}
                </div>
              </div>
              <div className="right">
                <div className="bold money">{inr(r2(lineGross - (l.discount || 0)))}</div>
                {l.discount > 0 && <div className="tiny muted" style={{ textDecoration: "line-through" }}>{inr(lineGross)}</div>}
                <div className="row" style={{ justifyContent: "flex-end", gap: 0, marginTop: 6 }}>
                  <button className="icon-btn" style={{ width: 38, height: 38 }} onClick={() => setDiscFor(discFor === l.variant_id ? null : l.variant_id)} aria-label="Item discount">
                    <Tag size={18} />
                  </button>
                  <button className="icon-btn" style={{ width: 38, height: 38 }} onClick={() => setCart((c) => ({ ...c, lines: removeLine(c.lines, l.variant_id) }))} aria-label="Remove item">
                    <Trash2 size={18} />
                  </button>
                </div>
              </div>
              {discFor === l.variant_id && (
                <div style={{ flexBasis: "100%" }} className="row">
                  <span className="small bold">Discount on this item</span>
                  <div className="grow">
                    <MoneyInput
                      autoFocus
                      value={l.discount ? String(l.discount) : ""}
                      onChange={(v) => setCart((c) => ({ ...c, lines: setLine(c.lines, l.variant_id, { discount: Math.min(Number(v) || 0, lineGross) }) }))}
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {role === "salesperson" && cart.lines.length > 0 && (
        <div className="tiny muted mt center">You can give up to {settings.salesman_max_disc_pct || 10}% discount. Ask a manager for more.</div>
      )}
      {confirmNode}
    </Sheet>
  );
}

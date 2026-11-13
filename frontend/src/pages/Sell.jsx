import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Clock, SearchX, Repeat2, Star, X } from "lucide-react";
import { useApp } from "../store";
import TopBar from "../components/TopBar";
import CameraScanner from "../components/CameraScanner";
import { Chips, Empty, LazyImg, SearchBar } from "../components/ui";
import { NeedBranch } from "../components/Branch";
import { useBarcodeScanner } from "../hooks/useBarcodeScanner";
import { searchItems, lookupBarcode, imageUrl } from "../lib/catalog";
import { PAGE, MIN_SEARCH, useSearchQuery, useMoreOnScroll } from "../lib/listing";
import { addLine, computeBill, offerFill, offersOf, qtyInCart } from "../lib/cart";
import { beepError, beepOk, unlockAudio } from "../lib/feedback";
import { inr, initials } from "../lib/format";
import CartSheet from "./sell/CartSheet";
import CheckoutSheet from "./sell/CheckoutSheet";
import LooseSheet from "./sell/LooseSheet";
import SuccessSheet from "./sell/SuccessSheet";
import HeldSheet from "./sell/HeldSheet";
import ReviewSheet from "./sell/ReviewSheet";

export default function Sell() {
  const { catalog, cart, setCart, settings, toast, isAllBranches, role } = useApp();
  const [q, setQ] = useState("");
  const query = useSearchQuery(q);
  const [drawn, setDrawn] = useState(PAGE);
  const [cat, setCat] = useState("all");
  const [scanOpen, setScanOpen] = useState(false);
  const [sheet, setSheet] = useState(null); // cart | checkout | held
  const [loose, setLoose] = useState(null);
  const [done, setDone] = useState(null);
  const [review, setReview] = useState(null); // a Google review being recorded: {} or that bill's customer
  const searchRef = useRef(null);
  const allowNeg = settings.allow_negative_stock === "yes";

  const sellable = useMemo(() => catalog.items.filter((i) => i.active), [catalog]);
  const catOptions = useMemo(() => {
    const used = new Set(sellable.map((i) => i.category_id));
    return [{ value: "all", label: "All" }, ...catalog.categories.filter((c) => used.has(c.id)).map((c) => ({ value: c.id, label: c.name }))];
  }, [catalog, sellable]);

  const shown = useMemo(() => {
    let list = cat === "all" ? sellable : sellable.filter((i) => i.category_id === cat);
    list = searchItems(list, query);
    // in-stock first
    return [...list.filter((i) => i.stock > 0), ...list.filter((i) => i.stock <= 0)];
  }, [sellable, cat, query]);

  // a new search or category starts from the top again
  useEffect(() => setDrawn(PAGE), [query, cat]);
  const more = useMoreOnScroll(drawn < shown.length, () => setDrawn((n) => n + PAGE));

  // add qty (merges with an existing line); returns {ok,label} for scan feedback
  const addQty = (item, qty) => {
    if (!item.active) return { ok: false, label: `${item.name} is not for sale` };
    const inCart = qtyInCart(cart.lines, item.id);
    if (!allowNeg && inCart + qty > item.stock) {
      return { ok: false, label: item.stock <= 0 ? `${item.name} ${item.size} is out of stock` : `Only ${item.stock} of ${item.name} ${item.size} in stock` };
    }
    setCart((c) => ({ ...c, lines: addLine(c.lines, item.id, qty) }));
    return { ok: true, label: `${item.name} ${item.size} × ${inCart + qty}` };
  };

  // tap / scan: loose attar asks for ml, everything else adds 1
  const addItem = (item) => {
    if (item.loose) {
      if (!item.active) return { ok: false, label: `${item.name} is not for sale` };
      setLoose(item);
      return { ok: true, label: `${item.name} — choose ml` };
    }
    return addQty(item, 1);
  };

  const onBarcode = (code) => {
    const item = lookupBarcode(catalog, code);
    if (!item) return { ok: false, label: `No product with barcode ${code}` };
    return addItem(item);
  };

  // Bluetooth / USB scanner
  useBarcodeScanner(
    (code, target) => {
      if (target === searchRef.current) setQ("");
      const res = onBarcode(code);
      if (res.ok) beepOk();
      else beepError();
      toast(res.label, res.ok ? "success" : "error", 1600);
    },
    !scanOpen && !sheet && !loose && !done,
  );

  const tap = (item) => {
    unlockAudio();
    const res = addItem(item);
    if (!res.ok) {
      beepError();
      toast(res.label, "error", 1800);
    }
  };

  const preview = useMemo(() => {
    const lines = cart.lines
      .map((l) => {
        const it = catalog.byVariant.get(l.variant_id);
        return it ? { ...l, price: it.price, gst_rate: it.gst, unit: it.unit } : null;
      })
      .filter(Boolean);
    // an offer still on its own amount is worked out on the bill as it is now: items added or taken off
    // after it was picked change what it is worth
    const offer = cart.offer_auto ? offersOf(settings).find((o) => o.id === cart.offer_id && o.active !== false) : null;
    const billDisc = offer ? offerFill(offer, lines, role === "salesperson", Number(settings.salesman_max_disc_pct || 10)) : Number(cart.bill_disc) || 0;
    return computeBill(lines, billDisc, settings.round_off !== "no");
  }, [cart, catalog, settings, role]);
  const pieces = cart.lines.reduce((s, l) => s + (catalog.byVariant.get(l.variant_id)?.unit === "ml" ? 1 : l.qty), 0);

  if (isAllBranches)
    return (
      <>
        <TopBar title="New Sale" />
        <div className="page">
          <NeedBranch what="sell" />
        </div>
      </>
    );

  return (
    <>
      <TopBar
        title="New Sale"
        right={
          <>
            {/* a Google review from anyone at the counter, buying or not */}
            <button className="icon-btn" onClick={() => setReview({})} aria-label="Google review">
              <Star />
            </button>
            <button className="icon-btn" onClick={() => setSheet("held")} aria-label="Held bills">
              <Clock />
            </button>
          </>
        }
      />
      <div className={"page" + (cart.lines.length ? " has-bar" : "")}>
        {cart.exchange && (
          <div className="card mb row gap-s" style={{ background: "var(--gold-soft)", alignItems: "flex-start" }}>
            <Repeat2 size={18} style={{ flex: "none", marginTop: 2 }} />
            <div className="grow">
              <div className="bold">Exchange · {inr(cart.exchange.credit)} credit</div>
              <div className="tiny">From bill {cart.exchange.invoice_no} — choose the replacement, then Checkout settles the difference.</div>
            </div>
            <button
              className="icon-btn"
              aria-label="Cancel exchange"
              onClick={() => {
                setCart((c) => ({ ...c, exchange: null }));
                toast("Exchange called off — this is an ordinary bill now", "success");
              }}
            >
              <X size={20} />
            </button>
          </div>
        )}
        <SearchBar
          inputRef={searchRef}
          value={q}
          onChange={setQ}
          placeholder="Search name, brand, size or barcode"
          onScan={() => {
            unlockAudio();
            setScanOpen(true);
          }}
        />
        <div className="mt">
          <Chips options={catOptions} value={cat} onChange={setCat} />
        </div>
        {q.trim().length > 0 && q.trim().length < MIN_SEARCH && (
          <div className="small muted mt center">Type at least {MIN_SEARCH} letters to search, or scan the barcode</div>
        )}

        {shown.length === 0 ? (
          <Empty icon={SearchX} title="No products found" text={q ? "Try a different word, or scan the barcode." : "Add products in Stock first."} />
        ) : (
          <div className="pgrid mt">
            {shown.slice(0, drawn).map((it) => {
              const inCart = qtyInCart(cart.lines, it.id);
              return <ProductCard key={it.id} item={it} inCart={inCart} onTap={() => tap(it)} />;
            })}
          </div>
        )}
        {drawn < shown.length && <div ref={more} className="muted small center mt">Showing {drawn} of {shown.length} — keep scrolling, or search to narrow down.</div>}
      </div>

      {cart.lines.length > 0 && !sheet && (
        <button className="cartbar" onClick={() => setSheet("cart")}>
          <span className="count">{Math.round(pieces)}</span>
          <div>
            <div className="tiny" style={{ color: "var(--gold)" }}>{cart.lines.length} item{cart.lines.length > 1 ? "s" : ""} in bill</div>
            <div className="total">{inr(preview.grand_total)}</div>
          </div>
          <span className="go">
            View bill <ChevronRight size={18} />
          </span>
        </button>
      )}

      <CameraScanner open={scanOpen} onClose={() => setScanOpen(false)} onCode={onBarcode} title="Scan to add to bill" />
      <LooseSheet item={loose} onClose={() => setLoose(null)} onAdd={(item, ml) => addQty(item, ml)} />
      <CartSheet open={sheet === "cart"} onClose={() => setSheet(null)} preview={preview} onCheckout={() => setSheet("checkout")} onHeld={() => setSheet(null)} />
      <CheckoutSheet
        open={sheet === "checkout"}
        onClose={() => setSheet("cart")}
        preview={preview}
        onDone={(detail) => {
          setSheet(null);
          setDone(detail);
        }}
      />
      <HeldSheet open={sheet === "held"} onClose={() => setSheet(null)} />
      <SuccessSheet detail={done} onClose={() => setDone(null)} onReview={(s) => setReview({ phone: s.customer_phone || "", name: s.customer_name || "", sale_id: s.id, salesman_id: s.salesman_id })} />
      <ReviewSheet review={review} onClose={() => setReview(null)} />
    </>
  );
}

function ProductCard({ item, inCart, onTap }) {
  const url = imageUrl(item.image, 200); // same size the lists ask for, so it is already cached
  const out = item.stock <= 0;
  return (
    <button className={"pcard" + (inCart ? " in-cart" : "") + (out ? " out" : "")} onClick={onTap}>
      <div className="thumb">{url ? <LazyImg src={url} /> : <div className="placeholder-mono">{initials(item.brand || item.name)}</div>}</div>
      {inCart > 0 && <span className="qty-badge">{item.unit === "ml" ? `${inCart}ml` : `×${inCart}`}</span>}
      <div className="body">
        {item.brand && <div className="brand-label ellipsis">{item.brand}</div>}
        <div className="name">{item.name}</div>
        <div className="small muted">{item.size}</div>
        <div className="meta">
          <div>
            <div className="price">
              {inr(item.price)}
              {item.unit === "ml" && <span className="tiny muted">/ml</span>}
            </div>
            {item.mrp > item.price && <div className="mrp">{inr(item.mrp)}</div>}
          </div>
          <span className={"tiny bold " + (out ? "bad-text" : item.reorder > 0 && item.stock <= item.reorder ? "" : "muted")}>
            {out ? "Out" : item.unit === "ml" ? `${item.stock}ml` : `${item.stock} left`}
          </span>
        </div>
      </div>
    </button>
  );
}


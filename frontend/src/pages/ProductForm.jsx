import { useMemo, useRef, useState } from "react";
import { ScanLine, Wand2, Plus, Trash2, Camera, EyeOff, Eye, ImageOff, Hash } from "lucide-react";
import { useApp } from "../store";
import { api } from "../lib/api";
import { runBusy } from "../lib/busy";
import { goBack, useRoute } from "../lib/router";
import { imageUrl, soldList } from "../lib/catalog";
import { compressImage } from "../lib/files";
import { beepOk } from "../lib/feedback";
import TopBar from "../components/TopBar";
import CameraScanner from "../components/CameraScanner";
import { useBarcodeScanner } from "../hooks/useBarcodeScanner";
import { Button, Chips, Field, MoneyInput, Seg, Spinner, useConfirm } from "../components/ui";

const GST = [0, 5, 12, 18, 28];
// `sold`: the branch ids ticked under "Sold at" — a new size is sold at every branch; `sold0`: as it opened
const blankVariant = (barcode = "", sold = []) => ({ id: 0, size_label: "", size_ml: "", sku: "", barcode, mrp: "", sell_price: "", cost: "", opening_stock: "", reorder_level: "3", max_level: "", active: 1, sold, sold0: sold.join(",") });

// "Sold at" as ticks over the open branches: blank (every branch) ticks them all
const soldTicks = (soldAt, openIds) => {
  const list = soldList(soldAt);
  return list.length ? openIds.filter((id) => list.includes(id)) : openIds;
};

// "Fill up to" has to be above the low stock alert, or a low item would have nothing to fill
const levelError = (v) => {
  const max = Number(v.max_level) || 0;
  const low = Number(v.reorder_level) || 0;
  return max > 0 && low > 0 && max <= low ? "Must be more than the low stock alert" : "";
};

export default function ProductForm({ id }) {
  const { rawCatalog, catalog, refreshCatalog, toast, isManager, isAdmin, branches, branchId, branch, multiBranch } = useApp();
  const openIds = branches.map((b) => b.id);
  const route = useRoute();
  const existing = id ? rawCatalog.products.find((p) => p.id === id) : null;
  const [confirm, confirmNode] = useConfirm();

  const [p, setP] = useState(() => {
    if (existing) {
      const brand = catalog.brandById.get(existing.brand_id);
      return { ...existing, brand_name: brand ? brand.name : "" };
    }
    const cat = catalog.categories.find((c) => c.active && c.name === "Eau De Parfum") || catalog.categories.find((c) => c.active) || catalog.categories[0];
    return { name: "", brand_name: "", category_id: cat ? cat.id : "", gender: "", sale_type: "packed", hsn: cat ? cat.default_hsn : "", gst_rate: cat ? cat.default_gst : 18, image: "", description: "" };
  });
  const [vars, setVars] = useState(() => {
    if (existing)
      return rawCatalog.variants
        .filter((v) => v.product_id === existing.id)
        .map((v) => {
          // "Sold at" is sent only when a tick changes, so the server keeps what is saved otherwise
          const sold = soldTicks(v.sold_at, openIds);
          return {
            ...v, cost: v.avg_cost ?? "", opening_stock: "", size_ml: v.size_ml || "", sku: v.sku || "",
            // a catalogue saved on this phone before "Fill up to" existed has none: left undefined, it is
            // not sent unless typed in, and the server keeps what is saved
            max_level: v.max_level === undefined ? undefined : v.max_level > 0 ? String(v.max_level) : "",
            sold, sold0: sold.join(","),
          };
        });
    return [blankVariant(route.params.get("barcode") || "", openIds)];
  });
  const [scanFor, setScanFor] = useState(null);
  const [gen, setGen] = useState(""); // which code is being generated: "sku-2" / "bar-0"
  const [busy, setBusy] = useState(false);
  const [imgBusy, setImgBusy] = useState(false);
  const [preview, setPreview] = useState("");
  const fileRef = useRef(null);

  // Add product: a scanner scan only fills a Barcode box (stock is added in Stock In, never here)
  useBarcodeScanner((code, target) => {
    // the scanner also typed the code into whatever box had focus (e.g. Product name) — take it back out
    if (target && target.tagName === "INPUT" && typeof target.value === "string" && target.value.endsWith(code)) {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setValue.call(target, target.value.slice(0, -code.length));
      target.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const i = vars.findIndex((v) => !v.barcode);
    if (i < 0) return toast("Tap the Barcode box of the size first", "warn");
    setV(i, { barcode: code });
    beepOk();
  }, !existing && scanFor === null);

  const set = (patch) => setP((x) => ({ ...x, ...patch }));
  const setV = (i, patch) => setVars((vs) => vs.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  const loose = p.sale_type === "loose";

  // "Sold at" (only with two or more branches open): did a tick change, and what stops the save
  const soldChanged = (v) => multiBranch && v.sold.join(",") !== v.sold0;
  const soldError = (v) => {
    if (!soldChanged(v)) return "";
    if (!v.sold.length) return "Tick at least one branch that sells it. To stop selling it everywhere, hide it instead.";
    if (!v.id && Number(v.opening_stock) > 0 && branchId && !v.sold.includes(branchId))
      return `Opening stock goes in at ${branch ? branch.name : "this branch"}, which isn't ticked. Tick it, or leave opening stock empty.`;
    return "";
  };
  const toggleSold = (i, id, on) => setV(i, { sold: openIds.filter((x) => (x === id ? on : vars[i].sold.includes(x))) });

  const onCategory = (cid) => {
    const c = catalog.categories.find((x) => x.id === Number(cid));
    set({ category_id: Number(cid), hsn: c ? c.default_hsn : p.hsn, gst_rate: c ? c.default_gst : p.gst_rate, sale_type: c && /loose/i.test(c.name) ? "loose" : p.sale_type });
  };

  // barcode clash with another item?
  const clash = (code, vid) => {
    if (!code) return "";
    const it = catalog.byBarcode.get(code);
    if (it && it.id !== vid) return `Already used by ${it.name} ${it.size}`;
    if (vars.filter((v) => v.barcode === code).length > 1) return "Same barcode used twice here";
    return "";
  };

  // SKU clash with another size (ignoring case)?
  const skuClash = (sku, vid) => {
    const k = String(sku || "").trim().toUpperCase();
    if (!k) return "";
    const it = catalog.items.find((x) => String(x.sku || "").toUpperCase() === k);
    if (it && it.id !== vid) return `SKU already used by ${it.name} ${it.size}`;
    if (vars.filter((v) => String(v.sku || "").trim().toUpperCase() === k).length > 1) return "Same SKU used twice here";
    return "";
  };

  // both take a second or two — show a spinner and refuse a second tap (numbers are never re-used)
  const generateSku = async (i) => {
    if (gen) return;
    setGen("sku-" + i);
    try {
      const r = await api("generateSku");
      setV(i, { sku: r.data.sku });
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setGen("");
    }
  };

  const generate = async (i) => {
    if (gen) return;
    setGen("bar-" + i);
    try {
      const r = await api("generateBarcode");
      setV(i, { barcode: r.data.barcode });
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setGen("");
    }
  };

  const pickPhoto = async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    setImgBusy(true);
    try {
      const img = await compressImage(f);
      setPreview(img.preview);
      const r = await api("uploadImage", { data: img.data, mime: img.mime, name: (p.name || "product") + ".jpg" });
      set({ image: r.data.image });
    } catch (ex) {
      toast(ex.message, "error");
      setPreview("");
    } finally {
      setImgBusy(false);
    }
  };

  const save = async () => {
    if (!p.name.trim()) return toast("Enter the product name", "error");
    if (!p.category_id) return toast("Choose a category", "error");
    for (const v of vars) {
      const c = clash(v.barcode, v.id) || skuClash(v.sku, v.id);
      if (c) return toast(c, "error");
      if (levelError(v)) return toast(`Fill up to must be more than the low stock alert${loose ? "" : ` (${v.size_label || "size"})`}`, "error");
      const s = soldError(v);
      if (s) return toast(loose ? s : `${v.size_label || "Size"}: ${s}`, "error", 4000);
    }
    setBusy(true);
    try {
      const payload = {
        ...p,
        id: existing ? existing.id : undefined,
        brand_id: undefined,
        variants: vars.map((v) => ({
          id: v.id || undefined,
          size_label: loose ? v.size_label || "Loose (per ml)" : v.size_label,
          size_ml: v.size_ml,
          sku: v.sku, // always sent, so editing never wipes it
          barcode: v.barcode,
          mrp: v.mrp,
          sell_price: v.sell_price,
          cost: v.cost,
          opening_stock: v.id ? 0 : v.opening_stock,
          reorder_level: v.reorder_level,
          max_level: v.max_level, // undefined (left out) when this phone's catalogue doesn't know it yet
          sold_at: soldChanged(v) ? v.sold : undefined, // left out unless a tick changed: the saved one is kept
          active: v.active,
        })),
      };
      const r = await runBusy("Saving product…", async () => {
        const res = await api("saveProduct", payload);
        await refreshCatalog();
        return res;
      });
      toast(r.message, "success");
      goBack("stock");
    } catch (e) {
      toast(e.message, "error", 4000);
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async () => {
    const hide = existing.active;
    if (hide && !(await confirm({ title: "Hide this product?", text: "It won't show on the Sell screen. Sales history is kept. You can show it again any time.", okText: "Hide" }))) return;
    try {
      const r = await runBusy(existing.active ? "Hiding product…" : "Showing product…", async () => {
        const res = await api("toggleProduct", { id: existing.id });
        await refreshCatalog();
        return res;
      });
      toast(r.message, "success");
      goBack("stock");
    } catch (e) {
      toast(e.message, "error");
    }
  };

  // only for products added by mistake — the server refuses anything already used in bills or stock
  const remove = async () => {
    const ok = await confirm({
      title: "Delete this product?",
      text: "Only for products added by mistake. Products already used in bills or stock can only be hidden.",
      okText: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await runBusy("Deleting product…", () => api("deleteProduct", { id: existing.id }));
      goBack("stock");
      refreshCatalog();
      toast(r.message, "success");
    } catch (e) {
      toast(e.message, "error", 4000);
    }
  };

  const brandNames = useMemo(() => catalog.brands.map((b) => b.name), [catalog]);
  if (!isManager) return null;
  const img = preview || imageUrl(p.image, 400);

  return (
    <>
      <TopBar
        title={existing ? "Edit product" : "Add product"}
        back="stock"
        right={
          existing && (
            <button className="icon-btn" onClick={toggleActive} aria-label={existing.active ? "Hide product" : "Show product"}>
              {existing.active ? <EyeOff size={20} /> : <Eye size={20} />}
            </button>
          )
        }
      />
      <div className="page has-bar">
        <div className="card">
          <div className="row mb">
            <button
              type="button"
              onClick={() => !imgBusy && fileRef.current.click()}
              style={{ width: 88, height: 88, borderRadius: 12, border: "2px dashed var(--line)", background: "var(--bg)", overflow: "hidden", display: "grid", placeItems: "center", flex: "none", cursor: "pointer" }}
              aria-label="Add photo"
            >
              {imgBusy ? <span className="spinner" /> : img ? <img src={img} alt="" loading="lazy" decoding="async" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <Camera color="var(--muted)" />}
            </button>
            <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={pickPhoto} />
            <div className="grow small muted">
              Tap to take a photo or choose from gallery.
              {p.image && (
                <button className="btn ghost small" onClick={() => { set({ image: "" }); setPreview(""); }}>
                  <ImageOff size={15} /> Remove photo
                </button>
              )}
            </div>
          </div>
          <Field label="Product name">
            <input className="input" value={p.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Asad Eau De Parfum" autoCapitalize="words" />
          </Field>
          <Field label="Brand" hint="Pick from the list or type a new brand">
            <input className="input" list="brand-list" value={p.brand_name} onChange={(e) => set({ brand_name: e.target.value })} placeholder="e.g. Lattafa" autoCapitalize="words" />
            <datalist id="brand-list">
              {brandNames.map((b) => (
                <option key={b} value={b} />
              ))}
            </datalist>
          </Field>
          <Field label="Category">
            <select className="input" value={p.category_id} onChange={(e) => onCategory(e.target.value)}>
              {catalog.categories.filter((c) => c.active || c.id === p.category_id).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="field">
            <label>For</label>
            <Chips value={p.gender || ""} onChange={(g) => set({ gender: g })} options={[{ value: "men", label: "Men" }, { value: "women", label: "Women" }, { value: "unisex", label: "Unisex" }, { value: "", label: "—" }]} />
          </div>
          <div className="field">
            <label>How is it sold?</label>
            <Seg value={p.sale_type} onChange={(v) => set({ sale_type: v })} options={[{ value: "packed", label: "Packed (pieces)" }, { value: "loose", label: "Loose attar (per ml)" }]} />
          </div>
          <div className="grid-2">
            <Field label="HSN code">
              <input className="input" inputMode="numeric" value={p.hsn} onChange={(e) => set({ hsn: e.target.value })} />
            </Field>
            <Field label="GST %">
              <select className="input" value={p.gst_rate} onChange={(e) => set({ gst_rate: Number(e.target.value) })}>
                {GST.map((g) => (
                  <option key={g} value={g}>
                    {g}%
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {!p.image && !preview && (
            <Field label="…or image link (optional)" hint="e.g. copy image address from groovyfragrances.in">
              <input className="input" inputMode="url" value={p.image} onChange={(e) => set({ image: e.target.value.trim() })} placeholder="https://" />
            </Field>
          )}
        </div>

        <div className="section-label">{loose ? "Price & stock (per ml)" : "Sizes"}</div>
        {vars.map((v, i) => {
          const err = clash(v.barcode, v.id);
          return (
            <div className="card" key={i}>
              {!loose && (
                <div className="row between mb">
                  <b>Size {i + 1}</b>
                  {!v.id && vars.length > 1 && (
                    <button className="icon-btn" onClick={() => setVars((vs) => vs.filter((_, j) => j !== i))} aria-label="Remove size">
                      <Trash2 size={18} />
                    </button>
                  )}
                  {v.id > 0 && (
                    <label className="row small">
                      <input type="checkbox" checked={!!v.active} onChange={(e) => setV(i, { active: e.target.checked ? 1 : 0 })} /> For sale
                    </label>
                  )}
                </div>
              )}
              {!loose && (
                <div className="grid-2">
                  <Field label="Size">
                    <input className="input" value={v.size_label} onChange={(e) => setV(i, { size_label: e.target.value })} placeholder="100ml" />
                  </Field>
                  <Field label="ml (optional)">
                    <input className="input" inputMode="decimal" value={v.size_ml} onChange={(e) => setV(i, { size_ml: e.target.value.replace(/[^\d.]/g, "") })} />
                  </Field>
                </div>
              )}
              <Field label="Barcode" error={err} hint="Scan the box, type it, or generate a code for items without one">
                <div className="row gap-s">
                  <input
                    className="input grow"
                    inputMode="numeric"
                    value={v.barcode}
                    data-scan-ignore
                    onChange={(e) => setV(i, { barcode: e.target.value.replace(/\s/g, "") })}
                    onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), beepOk())}
                    placeholder="Scan or type"
                  />
                  <button className="icon-btn filled" onClick={() => setScanFor(i)} aria-label="Scan barcode with camera">
                    <ScanLine size={20} />
                  </button>
                  <button className="icon-btn soft" disabled={!!gen} onClick={() => generate(i)} aria-label="Generate barcode" title="Generate a barcode for items without one">
                    {gen === "bar-" + i ? <Spinner size={18} /> : <Wand2 size={19} />}
                  </button>
                </div>
              </Field>
              <Field label="SKU (optional)" error={skuClash(v.sku, v.id)} hint="Your item code. If this product is also on your website, use the same SKU there — imports find items by it.">
                <div className="row gap-s">
                  <input className="input grow" value={v.sku || ""} onChange={(e) => setV(i, { sku: e.target.value.trim() })} placeholder="e.g. SKU-0001" autoCapitalize="characters" />
                  <button className="icon-btn soft" disabled={!!gen} onClick={() => generateSku(i)} aria-label="Generate SKU" title="Generate SKU (next in the SKU-#### series)">
                    {gen === "sku-" + i ? <Spinner size={18} /> : <Hash size={19} />}
                  </button>
                </div>
              </Field>
              <div className="grid-2">
                <Field label={loose ? "MRP per ml" : "MRP"}>
                  <MoneyInput value={String(v.mrp ?? "")} onChange={(x) => setV(i, { mrp: x })} />
                </Field>
                <Field label={loose ? "Selling price per ml" : "Selling price"}>
                  <MoneyInput value={String(v.sell_price ?? "")} onChange={(x) => setV(i, { sell_price: x })} />
                </Field>
                <Field label={loose ? "Cost per ml" : "Cost price"} hint="Hidden from salespeople">
                  <MoneyInput value={String(v.cost ?? "")} onChange={(x) => setV(i, { cost: x })} />
                </Field>
                {!v.id ? (
                  <Field label={loose ? "Opening stock (ml)" : "Opening stock"}>
                    <input className="input" inputMode="decimal" value={v.opening_stock} onChange={(e) => setV(i, { opening_stock: e.target.value.replace(/[^\d.]/g, "") })} placeholder="0" />
                  </Field>
                ) : (
                  <Field label="In stock" hint="Use Stock In / Adjust to change">
                    <input className="input" value={`${v.stock_qty}${loose ? " ml" : ""}`} disabled />
                  </Field>
                )}
                <Field label={loose ? "Low stock alert (ml)" : "Low stock alert at"}>
                  <input className="input" inputMode="numeric" value={v.reorder_level} onChange={(e) => setV(i, { reorder_level: e.target.value.replace(/[^\d.]/g, "") })} />
                </Field>
                <Field label={loose ? "Fill up to (ml)" : "Fill up to"} error={levelError(v)} hint="When low, shows how many to put back">
                  <input className="input" inputMode="numeric" value={v.max_level ?? ""} onChange={(e) => setV(i, { max_level: e.target.value.replace(/[^\d.]/g, "") })} placeholder="Not set" />
                </Field>
              </div>
              {multiBranch && <SoldAt v={v} branches={branches} error={soldError(v)} onToggle={(id, on) => toggleSold(i, id, on)} />}
              {Number(v.sell_price) > 0 && Number(v.cost) > 0 && (
                <div className="tiny muted">
                  Margin {Math.round(((Number(v.sell_price) - Number(v.cost)) / Number(v.sell_price)) * 100)}% (before GST)
                </div>
              )}
            </div>
          );
        })}
        {!loose && (
          <button className="btn secondary block mt" onClick={() => setVars((vs) => [...vs, blankVariant("", openIds)])}>
            <Plus size={18} /> Add another size
          </button>
        )}
        {existing && isAdmin && (
          <button className="btn ghost block mt" style={{ color: "var(--bad)" }} onClick={remove}>
            <Trash2 size={18} /> Delete product
          </button>
        )}
      </div>
      <div className="cartbar" style={{ background: "#fff", boxShadow: "var(--shadow-up)", padding: 8, cursor: "default" }}>
        <Button className="block big grow" loading={busy} onClick={save}>
          {existing ? "Save changes" : "Add product"}
        </Button>
      </div>
      <CameraScanner
        open={scanFor !== null}
        onClose={() => setScanFor(null)}
        continuous={false}
        title="Scan product barcode"
        onCode={(code) => {
          setV(scanFor, { barcode: code });
          const c = catalog.byBarcode.get(code);
          return c ? { ok: false, label: `Already used by ${c.name} ${c.size}` } : { ok: true, label: code };
        }}
      />
      {confirmNode}
    </>
  );
}

// "Sold at": one tick per open branch. A branch unticked while it still has some keeps selling them until
// they are gone (the server's rule), so the form only says so — it refuses nothing for it.
function SoldAt({ v, branches, error, onToggle }) {
  const was = v.sold0.split(",").map(Number);
  const left = v.id ? branches.filter((b) => was.includes(b.id) && !v.sold.includes(b.id) && ((v.stock_by_branch || {})[b.id] || 0) > 0) : [];
  const unit = v.unit === "ml" ? " ml" : "";
  return (
    <Field
      label="Sold at"
      error={error}
      hint={
        left.length
          ? left.map((b) => `${b.name} still has ${v.stock_by_branch[b.id]}${unit} — they stay on sale there until gone.`).join(" ")
          : "Untick a branch that doesn't sell this size: it won't show there, or count as out of stock."
      }
    >
      <div className="row" style={{ flexWrap: "wrap", gap: "2px 18px" }}>
        {branches.map((b) => (
          <label key={b.id} className="row small" style={{ minHeight: 36 }}>
            <input type="checkbox" checked={v.sold.includes(b.id)} onChange={(e) => onToggle(b.id, e.target.checked)} style={{ width: 20, height: 20, accentColor: "var(--brown)" }} />
            {b.name}
          </label>
        ))}
      </div>
    </Field>
  );
}

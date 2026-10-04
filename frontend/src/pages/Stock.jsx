import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, PackagePlus, Upload, Pencil, History, SlidersHorizontal, Boxes, Download, ArrowRightLeft } from "lucide-react";
import { useApp } from "../store";
import { api } from "../lib/api";
import { useCachedFetch } from "../lib/cached";
import { runBusy } from "../lib/busy";
import { navigate, useRoute } from "../lib/router";
import { searchItems, lookupBarcode } from "../lib/catalog";
import { PAGE, MIN_SEARCH, useSearchQuery, useMoreOnScroll } from "../lib/listing";
import { inr, fmtDateTime, qtyLabel, r3, plural, istDate } from "../lib/format";
import { beepError, beepOk } from "../lib/feedback";
import { parseCSV, downloadText, IMPORT_TEMPLATE, isWebsiteExport, fromWebsiteExport, catalogToImportCSV, withoutInfoColumns, importParts, checkImport } from "../lib/files";
import { useBarcodeScanner } from "../hooks/useBarcodeScanner";
import TopBar from "../components/TopBar";
import CameraScanner from "../components/CameraScanner";
import { Button, Chips, Empty, Field, SearchBar, Seg, Sheet, SkeletonList, StockBadge, Thumb, useConfirm } from "../components/ui";

export default function Stock({ tab }) {
  const { isManager, isMover, canTransfer, multiBranch } = useApp();
  // a stock mover has the product list and the transfers, never what was bought in (it shows cost)
  const t = (isManager && tab === "batches") || (canTransfer && tab === "transfers" && multiBranch) ? tab : "products";
  return (
    <>
      <TopBar title={canTransfer ? "Stock" : "Products"} />
      <div className="page">
        {(isManager || (isMover && multiBranch)) && (
          <div className="mb">
            <Seg
              value={t}
              onChange={(v) => navigate(v === "products" ? "stock" : "stock/" + v, { replace: true })}
              options={[
                { value: "products", label: "Products" },
                ...(isManager ? [{ value: "batches", label: multiBranch ? "Stock In" : "Stock In history" }] : []),
                ...(multiBranch ? [{ value: "transfers", label: "Transfers" }] : []),
              ]}
            />
          </div>
        )}
        {t === "products" ? <Products /> : t === "transfers" ? <Transfers /> : <Batches />}
      </div>
    </>
  );
}

function Products() {
  const { catalog, isManager, isMover, toast, multiBranch } = useApp();
  const route = useRoute();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState(route.params.get("filter") || "all");
  const query = useSearchQuery(q);
  const [shown, setShown] = useState(PAGE);
  const [scan, setScan] = useState(false);
  const [open, setOpen] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const [confirm, confirmNode] = useConfirm();

  const list = useMemo(() => {
    let l = catalog.items;
    if (filter === "low") l = l.filter((i) => i.active && (i.stock <= 0 || (i.reorder > 0 && i.stock <= i.reorder)));
    else if (filter === "out") l = l.filter((i) => i.active && i.stock <= 0);
    else if (filter === "hidden") l = l.filter((i) => !i.active);
    else l = l.filter((i) => i.active);
    return searchItems(l, query);
  }, [catalog, query, filter]);

  // a new search or pill starts from the top again
  useEffect(() => setShown(PAGE), [query, filter]);
  const more = useMoreOnScroll(shown < list.length, () => setShown((n) => n + PAGE));

  const onCode = (code) => {
    const it = lookupBarcode(catalog, code);
    if (it) {
      setOpen(it);
      setScan(false);
      return { ok: true, label: `${it.name} ${it.size}` };
    }
    setScan(false);
    if (isManager)
      confirm({ title: "New barcode", text: `No product has barcode ${code}. Create a new product with it?`, okText: "Create product" }).then(
        (yes) => yes && navigate(`stock/product/new?barcode=${encodeURIComponent(code)}`),
      );
    return { ok: false, label: `Barcode ${code} not found` };
  };

  useBarcodeScanner((code, target) => {
    if (target && target.tagName === "INPUT") setQ("");
    const r = onCode(code);
    r.ok ? beepOk() : beepError();
    if (!r.ok && !isManager) toast(r.label, "error");
  }, !scan && !open && !importOpen);

  return (
    <>
      <SearchBar value={q} onChange={setQ} placeholder="Search products or barcode" onScan={() => setScan(true)} />
      <div className="mt">
        <Chips
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: `All (${catalog.items.filter((i) => i.active).length})` },
            { value: "low", label: "Low stock" },
            { value: "out", label: "Out of stock" },
            ...(isManager ? [{ value: "hidden", label: "Hidden" }] : []),
          ]}
        />
      </div>
      {isManager && (
        <div className="row mt">
          <button className="btn dark grow" onClick={() => navigate("stock/in")}>
            <PackagePlus size={18} /> Stock In
          </button>
          {multiBranch && (
            <button className="btn secondary" onClick={() => navigate("stock/transfer")} aria-label="Transfer stock to another branch">
              <ArrowRightLeft size={18} /> Transfer
            </button>
          )}
          <button className="btn secondary" onClick={() => setImportOpen(true)} aria-label="Import or export products (CSV)">
            <Upload size={18} /> Import
          </button>
        </div>
      )}
      {isMover && multiBranch && (
        <button className="btn dark block mt" onClick={() => navigate("stock/transfer")}>
          <ArrowRightLeft size={18} /> Transfer stock
        </button>
      )}

      {q.trim().length > 0 && q.trim().length < MIN_SEARCH && (
        <div className="small muted mt center">Type at least {MIN_SEARCH} letters to search</div>
      )}

      {list.length === 0 ? (
        <Empty icon={Boxes} title="No products" text={query ? "Nothing matches your search." : isManager ? "Add your first product with the + button." : ""} />
      ) : (
        <div className="list mt">
          {list.slice(0, shown).map((it) => (
            <button key={it.id} className="list-item" onClick={() => setOpen(it)}>
              <Thumb item={it} />
              <div className="grow">
                <div className="title ellipsis">{it.name}</div>
                <div className="sub ellipsis">
                  {[it.brand, it.size].filter(Boolean).join(" · ")} · {inr(it.price)}
                  {it.unit === "ml" ? "/ml" : ""}
                </div>
              </div>
              <StockBadge item={it} />
            </button>
          ))}
          {shown < list.length && <div ref={more} className="small muted center" style={{ padding: "12px 0" }}>Loading more…</div>}
          <div className="small muted center" style={{ padding: "8px 0" }}>
            {shown < list.length ? `Showing ${shown} of ${plural("product", list.length)}` : plural("product", list.length)}
          </div>
        </div>
      )}

      {isManager && (
        <button className="fab" onClick={() => navigate("stock/product/new")}>
          <Plus size={20} /> Add product
        </button>
      )}
      <CameraScanner open={scan} onClose={() => setScan(false)} onCode={onCode} continuous={false} title="Scan to find product" />
      {/* mounted only while a product is open, and keyed by it, so every opening starts clean. Kept
          mounted, its state outlived the sheet: close it with the outer ✕ while Adjust stock was open
          and the next product opened with Adjust already open underneath it, its field grabbing the
          keyboard, and the Adjust button doing nothing because it was already "on". */}
      {open && <ItemSheet key={open.id} item={open} onClose={() => setOpen(null)} />}
      <ImportSheet open={importOpen} onClose={() => setImportOpen(false)} />
      {confirmNode}
    </>
  );
}

function ItemSheet({ item, onClose }) {
  const { isManager, isMover, catalog, multiBranch, branches, branchId } = useApp();
  const [adjust, setAdjust] = useState(false);
  const [moves, setMoves] = useState(null);
  const live = item ? catalog.byVariant.get(item.id) || item : null;

  if (!item) return null;
  const loadMoves = async () => {
    setMoves("loading");
    try {
      const r = await api("movements", { variant_id: item.id, limit: 50 });
      setMoves(r.data);
    } catch {
      setMoves([]);
    }
  };
  return (
    <Sheet open onClose={onClose} title={live.name}>
      <div className="row mb">
        <Thumb item={live} size={64} />
        <div className="grow">
          <div className="brand-label">{live.brand}</div>
          <div className="bold">{live.size}</div>
          <StockBadge item={live} />
        </div>
      </div>
      <div className="card">
        <div className="kv"><span className="k">Selling price</span><b>{inr(live.price)}{live.unit === "ml" ? " /ml" : ""}</b></div>
        <div className="kv"><span className="k">MRP</span><span>{inr(live.mrp)}</span></div>
        {isManager && live.cost !== undefined && <div className="kv"><span className="k">Avg cost</span><span>{inr(live.cost, { paise: true })}</span></div>}
        <div className="kv"><span className="k">{multiBranch && branchId ? "In stock here" : "In stock"}</span><b>{qtyLabel(live.stock, live.unit)}</b></div>
        {multiBranch && (
          <div className="kv">
            <span className="k">{branchId ? "Other branches" : "By branch"}</span>
            <span className="right small">
              {branches
                .filter((b) => b.id !== branchId)
                .map((b) => `${b.name} ${qtyLabel(live.stockBy[b.id] || 0, live.unit)}`)
                .join(" · ")}
            </span>
          </div>
        )}
        <div className="kv"><span className="k">Barcode</span><span className="money">{live.barcode || "—"}</span></div>
        <div className="kv"><span className="k">Category</span><span>{live.category}</span></div>
        <div className="kv"><span className="k">GST</span><span>{live.gst}% · HSN {live.hsn || "—"}</span></div>
      </div>
      {isManager && (
        <div className="grid-2 mt">
          <button className="btn secondary" onClick={() => navigate(`stock/product/${live.product_id}`)}>
            <Pencil size={17} /> Edit
          </button>
          <button className="btn secondary" onClick={() => setAdjust(true)} disabled={multiBranch && !branchId} title={multiBranch && !branchId ? "Choose a branch first" : undefined}>
            <SlidersHorizontal size={17} /> Adjust stock
          </button>
        </div>
      )}
      {/* a stock mover corrects the count (a bottle broken on the way), but does not edit the product */}
      {isMover && (
        <button className="btn secondary block mt" onClick={() => setAdjust(true)}>
          <SlidersHorizontal size={17} /> Adjust stock
        </button>
      )}
      {/* the history names every sale of the item, which is not a stock mover's to see */}
      {!isMover && (
        <button className="btn ghost block mt" onClick={loadMoves}>
          <History size={17} /> Stock history
        </button>
      )}
      {moves === "loading" && <SkeletonList rows={3} height={44} />}
      {Array.isArray(moves) && (moves.length === 0 ? <div className="muted small center">No movements yet</div> : (
        <div className="list">
          {moves.map((m) => (
            <div key={m.id} className="list-item" style={{ minHeight: 50, cursor: "default" }}>
              <div className="grow">
                <div className="title small">{MOVE_LABEL[m.type] || m.type} {m.note ? <span className="muted">· {m.note}</span> : null}</div>
                <div className="sub">{fmtDateTime(m.at)} · {m.user_name}{multiBranch ? " · " + m.branch_name : ""}</div>
              </div>
              <div className="right">
                <b className={m.qty < 0 ? "bad-text" : "ok-text"}>{m.qty > 0 ? "+" : ""}{m.qty}</b>
                <div className="tiny muted">bal {m.balance}</div>
              </div>
            </div>
          ))}
        </div>
      ))}
      <AdjustSheet open={adjust} item={live} onClose={() => setAdjust(false)} />
    </Sheet>
  );
}

const MOVE_LABEL = {
  opening: "Opening stock", stock_in: "Stock in", sale: "Sold", return: "Returned", void: "Bill voided", adjust: "Adjusted",
  damage: "Damaged", tester: "Tester use", transfer_out: "Sent to branch", transfer_in: "Received from branch",
};

function AdjustSheet({ open, item, onClose }) {
  const { patchStock, toast } = useApp();
  const [mode, setMode] = useState("remove");
  const [reason, setReason] = useState("damage");
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setMode("remove");
      setReason("damage");
      setQty("");
      setNote("");
    }
  }, [open]);
  if (!item) return null;
  const n = Number(qty) || 0;
  const after = mode === "set" ? n : mode === "add" ? r3(item.stock + n) : r3(item.stock - n);
  const save = async () => {
    setBusy(true);
    try {
      const r = await runBusy("Saving stock change…", () => api("adjustStock", { variant_id: item.id, mode, qty: n, reason: mode === "set" ? "count" : reason, note }));
      patchStock([{ id: item.id, stock_qty: r.data.stock_qty }]);
      toast(r.message, "success");
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
      title="Adjust stock"
      footer={
        <Button className="block big" loading={busy} disabled={qty === "" || (mode !== "set" && n <= 0)} onClick={save}>
          Save · new stock {after}
        </Button>
      }
    >
      <div className="small muted mb">
        {item.name} {item.size} · now <b>{qtyLabel(item.stock, item.unit)}</b>
      </div>
      <Seg
        value={mode}
        onChange={setMode}
        options={[
          { value: "remove", label: "Remove" },
          { value: "add", label: "Add" },
          { value: "set", label: "Set count" },
        ]}
      />
      {mode === "remove" && (
        <div className="chips mt">
          {[
            ["damage", "Damaged / leaked"],
            ["tester", "Used as tester"],
            ["other", "Other"],
          ].map(([v, l]) => (
            <button key={v} className={"chip" + (reason === v ? " active" : "")} onClick={() => setReason(v)}>
              {l}
            </button>
          ))}
        </div>
      )}
      <Field label={mode === "set" ? `Actual count on shelf (${item.unit})` : `Quantity (${item.unit})`} hint={mode === "set" ? "Use after a physical stock count" : ""}>
        <input className="input" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d.]/g, ""))} autoFocus />
      </Field>
      <Field label="Note (optional)">
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Sheet>
  );
}

function ImportSheet({ open, onClose }) {
  const { refreshCatalog, toast, catalog, branches } = useApp();
  const [rows, setRows] = useState(null);
  const [website, setWebsite] = useState(null); // {skipped} when the file is the website's product export
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setRows(null);
      setWebsite(null);
      setResult(null);
    }
  }, [open]);
  // what the chosen file would do, before anything is saved
  const check = useMemo(() => (rows && rows.length ? checkImport(rows, catalog) : null), [rows, catalog]);
  // the file's summary sits below the long explanation: bring it into view once a file is chosen
  const summary = useRef(null);
  useEffect(() => {
    if (rows && summary.current && summary.current.scrollIntoView) summary.current.scrollIntoView({ block: "nearest" });
  }, [rows]);
  const exportAll = () => {
    downloadText(`groovy-products-${istDate()}.csv`, catalogToImportCSV(catalog, branches));
    toast(`Exported ${plural("row", catalog.items.length)}`, "success");
  };
  const pick = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      const parsed = parseCSV(String(rd.result));
      if (isWebsiteExport(parsed)) {
        const m = fromWebsiteExport(parsed);
        setRows(m.rows);
        setWebsite({ skipped: m.skipped, notKiosk: m.notKiosk, noKioskColumn: !!m.noKioskColumn });
      } else {
        setRows(withoutInfoColumns(parsed));
        setWebsite(null);
      }
      setResult(null);
    };
    rd.readAsText(f);
  };
  const run = async () => {
    setBusy(true);
    // a file within the server's limit goes in one request, as it always has; a bigger one in parts
    const parts = importParts(rows);
    const sum = { products: 0, variants: 0, updated: 0, unchanged: 0, stock_ignored: 0, barcodes_filled: 0, errors: [] };
    let done = 0;
    try {
      for (const part of parts) {
        const r = await runBusy(parts.length > 1 ? `Importing products… part ${done + 1} of ${parts.length}` : "Importing products…", () => api("importCatalog", { rows: part }));
        if (parts.length === 1) {
          setResult(r.data);
          toast(r.message, r.data.errors.length ? "warn" : "success", 4000);
        } else {
          ["products", "variants", "updated", "unchanged", "stock_ignored", "barcodes_filled"].forEach((k) => (sum[k] += r.data[k] || 0));
          sum.errors = sum.errors.concat(r.data.errors);
        }
        done++;
      }
      if (parts.length > 1) {
        setResult(sum);
        toast(`Added ${sum.variants} sizes, updated ${sum.updated}, ${sum.unchanged} unchanged` + (sum.errors.length ? `, ${sum.errors.length} rows skipped` : ""), sum.errors.length ? "warn" : "success", 4000);
      }
      refreshCatalog();
    } catch (e) {
      toast(e.message, "error", 5000);
      // some parts are saved already: show them, and say the rest is still to do
      if (done > 0) {
        setResult({ ...sum, stopped: `Stopped after part ${done} of ${parts.length}. Import the same file again to finish — rows already saved are left as they are.` });
        refreshCatalog();
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Import / export products (CSV)"
      footer={
        rows && (!result || result.stopped) ? (
          <>
            {/* next to the button, so it is read before pressing it; the details are in the card above */}
            {check && (
              <div className={"small center mb " + (check.damaged.length ? "bad-text" : "muted")} data-import-summary>
                {check.damaged.length
                  ? "This file can't be imported: Excel has changed its barcodes. See above."
                  : `${check.matched} match products you have · ${check.fresh.length} new`}
              </div>
            )}
            <Button className="block big" loading={busy} onClick={run} disabled={!rows.length || (check && check.damaged.length > 0)}>
              Import {rows.length} rows
            </Button>
          </>
        ) : null
      }
    >
      <p className="small muted" style={{ marginTop: 0 }}>
        One row per size. Rows with the same brand + product become sizes of one product. Leave barcode empty and generate codes later if needed. For loose attar use sale_type
        “loose” and prices per ml.
        <br />
        Uploading again is safe: existing sizes (same barcode, or same brand + product + size) get their prices updated — blank cells keep the current value — and are
        never duplicated. Opening stock is only used for new sizes; use Stock In for more stock.
        <br />
        You can also upload the product export from your website as it is — its columns are matched automatically, and SKU or barcode finds existing items. Only rows with
        On_Kiosk = yes are imported; the others are left out. A row with no
        barcode gets its Product Id as one, so the item can still be scanned, and a row with no minimum quantity gets a reorder level of 2 so it still
        warns when stock runs low. Anything already saved here — a barcode, a reorder level you set — is never replaced.
        <br />
        To change many products at once: export all products, change prices or details in Excel or Google Sheets, save as CSV and choose that file here. A file can change
        prices, MRP, cost, reorder level, category, gender, HSN, GST and image. It cannot rename a product, brand or size, change a barcode or SKU that is already set, hide
        or delete a product, or change stock; the columns starting with “info_” are only for reading.
      </p>
      <button className="btn secondary block" onClick={exportAll} disabled={!catalog.items.length}>
        <Download size={18} /> Export all products
      </button>
      <button className="btn ghost block mt" onClick={() => downloadText("groovy-products-template.csv", IMPORT_TEMPLATE)}>
        <Download size={18} /> Download template
      </button>
      <div className="field mt">
        <label>Choose CSV file (from Excel / Google Sheets: File → Download → CSV)</label>
        <input className="input" type="file" accept=".csv,text/csv" onChange={pick} />
      </div>
      {rows && !result && (
        <div className="card" ref={summary}>
          {website && website.noKioskColumn && (
            <div className="bad-text small mb" style={{ fontWeight: 700 }}>
              This website file has no On_Kiosk column — export it again with On_Kiosk filled in. Nothing will be imported.
            </div>
          )}
          {website && !website.noKioskColumn && (
            <div className="small mb" style={{ color: "var(--ok)", fontWeight: 700 }}>
              Website product export recognised — columns matched automatically.
              <div className="muted" style={{ fontWeight: 400 }}>
                Only On_Kiosk = yes: {rows.length} {rows.length === 1 ? "row" : "rows"} to import{website.notKiosk ? ", " + website.notKiosk + " not on kiosk ignored" : ""}.
              </div>
            </div>
          )}
          <b>{rows.length} rows found.</b>
          <div className="small muted">
            First row: {rows[0] ? `${rows[0].brand || ""} ${rows[0].product || ""} ${rows[0].size_label || ""}${rows[0].sku ? " · " + rows[0].sku : ""}` : "—"}
          </div>
          {check && (
            <div className="small mt" data-import-check>
              <b>{check.matched}</b> match products you already have · <b>{check.fresh.length}</b> would be added as new
              {check.fresh.length > 0 && (
                <>
                  <div className="muted">
                    New means no size with that barcode, SKU, or brand + product + size was found. A changed name or size in the file is added as a new product, not renamed.
                  </div>
                  {check.fresh.slice(0, 20).map((e) => (
                    <div key={e.row}>
                      Row {e.row}: {e.label || "—"}
                    </div>
                  ))}
                  {check.fresh.length > 20 && <div className="muted">…and {check.fresh.length - 20} more</div>}
                </>
              )}
              {check.newCategories.length > 0 && <div className="mt">New categories that would be created: {check.newCategories.join(", ")}</div>}
              {check.damaged.length > 0 && (
                <div className="bad-text mt" style={{ fontWeight: 700 }}>
                  {plural("row", check.damaged.length)} {check.damaged.length === 1 ? "has" : "have"} a barcode or SKU that Excel turned into a number like 6.29E+12 (first: row {check.damaged[0].row}
                  {check.damaged[0].label ? ", " + check.damaged[0].label : ""}). Nothing can be imported from this file. Export again, make your changes and save it once as CSV.
                </div>
              )}
            </div>
          )}
          {website && website.skipped.length > 0 && (
            <>
              <div className="bad-text small mt">{website.skipped.length} rows will be skipped:</div>
              {website.skipped.slice(0, 20).map((e) => (
                <div key={e.row} className="small">
                  Row {e.row}: {e.message}
                </div>
              ))}
            </>
          )}
        </div>
      )}
      {result && (
        <div className="card">
          <b>
            Added {result.variants} sizes in {result.products} new products · Updated {result.updated || 0} · {result.unchanged || 0} unchanged
          </b>
          {result.stopped && <div className="bad-text small mt">{result.stopped}</div>}
          {result.barcodes_filled > 0 && (
            <div className="small muted mt">
              {result.barcodes_filled} {result.barcodes_filled === 1 ? "size had" : "sizes had"} no barcode — the website Product Id was used, so {result.barcodes_filled === 1 ? "it can" : "they can"} be scanned.
            </div>
          )}
          {result.stock_ignored > 0 && (
            <div className="small muted mt">
              Opening stock was ignored for {result.stock_ignored} existing {result.stock_ignored === 1 ? "size" : "sizes"} — use Stock In to add stock.
            </div>
          )}
          {result.errors.length > 0 && (
            <>
              <div className="bad-text small mt">{result.errors.length} rows skipped:</div>
              {result.errors.slice(0, 50).map((e) => (
                <div key={e.row} className="small">
                  Row {e.row}: {e.message}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </Sheet>
  );
}

function Batches() {
  const { toast, multiBranch } = useApp();
  // these two tabs are flipped between constantly; each keeps what it last showed
  const { data: list } = useCachedFetch("gp_batches", () => api("stockInBatches").then((r) => r.data), [], (e) => toast(e.message, "error"));
  if (!list) return <SkeletonList />;
  return (
    <>
      <button className="btn dark block mb" onClick={() => navigate("stock/in")}>
        <PackagePlus size={18} /> New Stock In
      </button>
      {list.length === 0 ? (
        <Empty icon={PackagePlus} title="No stock received yet" text="Use Stock In to scan and add new stock." />
      ) : (
        <div className="list">
          {list.map((b) => (
            <div key={b.id} className="list-item" style={{ cursor: "default" }}>
              <div className="grow">
                <div className="title">{b.supplier_note || "Stock In #" + b.id}</div>
                <div className="sub">
                  {fmtDateTime(b.at)} · {b.user_name} {b.bill_ref ? "· Bill " + b.bill_ref : ""}
                  {multiBranch ? " · " + b.branch_name : ""}
                </div>
              </div>
              <div className="right">
                <b>{b.total_qty} units</b>
                <div className="tiny muted">{b.lines} items{b.total_cost ? " · " + inr(b.total_cost) : ""}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function Transfers() {
  const { toast, catalog } = useApp();
  const { data: list } = useCachedFetch("gp_transfers", () => api("listTransfers").then((r) => r.data), [], (e) => toast(e.message, "error"));
  if (!list) return <SkeletonList />;
  return (
    <>
      <button className="btn dark block mb" onClick={() => navigate("stock/transfer")}>
        <ArrowRightLeft size={18} /> New transfer
      </button>
      {list.length === 0 ? (
        <Empty icon={ArrowRightLeft} title="No transfers yet" text="Send stock from this branch to another with New transfer." />
      ) : (
        <div className="list">
          {list.map((t) => (
            <div key={t.id} className="list-item" style={{ cursor: "default", alignItems: "flex-start" }}>
              <div className="grow">
                <div className="title">
                  {t.from_name} → {t.to_name}
                </div>
                <div className="sub">
                  {t.transfer_no} · {fmtDateTime(t.at)} · {t.user_name}
                  {t.note ? " · " + t.note : ""}
                </div>
                <div className="tiny muted" style={{ marginTop: 4 }}>
                  {t.items
                    .map((i) => {
                      const it = catalog.byVariant.get(i.variant_id);
                      return it ? `${it.name} ${it.unit === "ml" ? "" : it.size} × ${qtyLabel(i.qty, it.unit)}` : "";
                    })
                    .filter(Boolean)
                    .join(", ")}
                </div>
              </div>
              <b className="nowrap">{plural("unit", t.total_qty)}</b>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

import { useEffect, useMemo, useState } from "react";
import { Trash2, PackagePlus, ScanLine } from "lucide-react";
import { useApp } from "../store";
import { api } from "../lib/api";
import { runBusy } from "../lib/busy";
import { navigate } from "../lib/router";
import { searchItems, lookupBarcode, notSoldText, STOCKIN_PENDING as PENDING } from "../lib/catalog";
import { inr, r2, r3, qtyLabel } from "../lib/format";
import { beepError, beepOk, unlockAudio } from "../lib/feedback";
import { useBarcodeScanner } from "../hooks/useBarcodeScanner";
import TopBar from "../components/TopBar";
import CameraScanner from "../components/CameraScanner";
import { Button, Empty, Field, MoneyInput, SearchBar, Stepper, Thumb, useConfirm } from "../components/ui";
import { NeedBranch } from "../components/Branch";

const draftKey = (branchId) => "gp_stockin_" + branchId; // goods are received at one branch
const loadDraft = (key) => {
  try {
    return JSON.parse(sessionStorage.getItem(key)) || { lines: [], supplier_note: "", bill_ref: "" };
  } catch {
    return { lines: [], supplier_note: "", bill_ref: "" };
  }
};

export default function StockIn() {
  const { catalog, patchStock, toast, isManager, branchId, branch, isAllBranches } = useApp();
  const KEY = draftKey(branchId);
  const [draft, setDraftState] = useState(() => loadDraft(KEY));
  const [q, setQ] = useState("");
  const [scan, setScan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, confirmNode] = useConfirm();

  const setDraft = (fn) =>
    setDraftState((d) => {
      const n = typeof fn === "function" ? fn(d) : fn;
      sessionStorage.setItem(KEY, JSON.stringify(n));
      return n;
    });

  const add = (item, qty = 1) => {
    const ex = draft.lines.find((l) => l.variant_id === item.id);
    setDraft((d) => {
      const i = d.lines.findIndex((l) => l.variant_id === item.id);
      if (i >= 0) {
        const lines = d.lines.slice();
        lines[i] = { ...lines[i], qty: r3(Number(lines[i].qty) + qty) };
        // move the line to the top so the last scanned item is visible
        return { ...d, lines: [lines[i], ...lines.filter((_, j) => j !== i)] };
      }
      return { ...d, lines: [{ variant_id: item.id, qty, unit_cost: item.cost ? String(item.cost) : "" }, ...d.lines] };
    });
    return { ok: true, label: `${item.name} ${item.size} × ${ex ? r3(Number(ex.qty) + qty) : qty || "added"}` };
  };

  // item handed over (loose item scanned on Add product, or product just created from here) → put it on the list
  useEffect(() => {
    const code = sessionStorage.getItem(PENDING);
    if (!code || isAllBranches) return; // wait until a branch is chosen
    const it = lookupBarcode(catalog, code);
    if (it) {
      sessionStorage.removeItem(PENDING);
      // "Sold at": only a branch that sells the size takes it in
      if (!it.here) {
        toast(notSoldText(it, branch ? branch.name : "this branch"), "error", 4500);
        return;
      }
      const loose = it.unit === "ml";
      add(it, loose ? 0 : 1);
      toast(loose ? `${it.name} added to the list — enter the ml, then tap Save stock in` : `${it.name} ${it.size} added to the list — tap Save stock in to update stock`, "success", 3500);
    }
  }, [catalog, isAllBranches]); // eslint-disable-line react-hooks/exhaustive-deps

  const unknown = async (code) => {
    setScan(false);
    if (await confirm({ title: "New barcode", text: `No product has barcode ${code}. Create it now? It will be added to this stock in.`, okText: "Create product" })) {
      sessionStorage.setItem(PENDING, code);
      navigate(`stock/product/new?barcode=${encodeURIComponent(code)}`);
    }
  };

  const onCode = (code) => {
    const it = lookupBarcode(catalog, code);
    if (!it) {
      unknown(code);
      return { ok: false, label: `Unknown barcode ${code}` };
    }
    if (!it.here) return { ok: false, label: notSoldText(it, branch ? branch.name : "this branch"), notSold: true };
    return add(it, it.unit === "ml" ? 0 : 1);
  };

  useBarcodeScanner((code, target) => {
    if (target && target.tagName === "INPUT") setQ("");
    const r = onCode(code);
    if (r.ok) {
      beepOk();
      toast(r.label, "success", 1200);
    } else {
      beepError();
      if (r.notSold) toast(r.label, "error", 4500);
    }
  }, !scan);

  // only what this branch sells can be taken in here ("Sold at")
  const results = useMemo(() => (q.trim() ? searchItems(catalog.items.filter((i) => i.here), q).slice(0, 12) : []), [q, catalog]);
  const lines = draft.lines.map((l) => ({ ...l, item: catalog.byVariant.get(l.variant_id) })).filter((l) => l.item);
  const units = r3(lines.reduce((s, l) => s + (Number(l.qty) || 0), 0));
  const cost = r2(lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unit_cost) || 0), 0));

  const save = async () => {
    if (lines.some((l) => !(Number(l.qty) > 0))) return toast("Every item needs a quantity above 0", "error");
    // a list started before a size stopped being sold here
    const notHere = lines.find((l) => !l.item.here);
    if (notHere) return toast(notSoldText(notHere.item, branch ? branch.name : "this branch") + " Or remove it from this list.", "error", 5000);
    setBusy(true);
    try {
      const r = await runBusy("Saving stock in…", () => api("stockIn", {
        supplier_note: draft.supplier_note,
        bill_ref: draft.bill_ref,
        lines: lines.map((l) => ({ variant_id: l.variant_id, qty: Number(l.qty), unit_cost: Number(l.unit_cost) || 0 })),
      }));
      patchStock(r.data.stock);
      sessionStorage.removeItem(KEY);
      setDraftState({ lines: [], supplier_note: "", bill_ref: "" });
      toast(r.message, "success", 3000);
      navigate("stock/batches", { replace: true });
    } catch (e) {
      toast(e.message, "error", 4000);
    } finally {
      setBusy(false);
    }
  };

  if (!isManager) return null;
  if (isAllBranches)
    return (
      <>
        <TopBar title="Stock In" back="stock" />
        <div className="page">
          <NeedBranch what="receive stock" />
        </div>
      </>
    );
  return (
    <>
      <TopBar title="Stock In" back="stock" />
      <div className="page has-bar">
        <div className="card">
          <div className="grid-2">
            <Field label="Supplier / from">
              <input className="input" value={draft.supplier_note} onChange={(e) => setDraft((d) => ({ ...d, supplier_note: e.target.value }))} placeholder="e.g. Lattafa distributor" />
            </Field>
            <Field label="Bill no. (optional)">
              <input className="input" value={draft.bill_ref} onChange={(e) => setDraft((d) => ({ ...d, bill_ref: e.target.value }))} />
            </Field>
          </div>
        </div>

        <div className="mt">
          <SearchBar
            value={q}
            onChange={setQ}
            placeholder="Search to add, or scan"
            onScan={() => {
              unlockAudio();
              setScan(true);
            }}
          />
        </div>
        {results.length > 0 && (
          <div className="list mt">
            {results.map((it) => (
              <button
                key={it.id}
                className="list-item"
                onClick={() => {
                  add(it, it.unit === "ml" ? 0 : 1);
                  setQ("");
                }}
              >
                <Thumb item={it} size={40} />
                <div className="grow">
                  <div className="title ellipsis">{it.name}</div>
                  <div className="sub">
                    {it.size} · stock {qtyLabel(it.stock, it.unit)}
                  </div>
                </div>
                <PackagePlus size={20} color="var(--brown)" />
              </button>
            ))}
          </div>
        )}

        {lines.length === 0 ? (
          <Empty
            icon={ScanLine}
            title="Scan items to receive stock"
            text="Scan each box with the camera or Bluetooth scanner. Scanning the same item again adds 1 more."
          />
        ) : (
          <>
            <div className="section-label">
              {lines.length} items · {units} units
            </div>
            <div className="list">
              {lines.map((l) => (
                <div key={l.variant_id} className="list-item" style={{ cursor: "default", flexWrap: "wrap" }}>
                  <Thumb item={l.item} size={42} />
                  <div className="grow">
                    <div className="title">{l.item.name}</div>
                    <div className="sub">
                      {l.item.size} · now {qtyLabel(l.item.stock, l.item.unit)}
                    </div>
                    {/* a list started before this size stopped being sold here ("Sold at") */}
                    {!l.item.here && (
                      <div className="small bad-text bold">
                        Not sold at {branch ? branch.name : "this branch"} — remove it, or tick {branch ? branch.name : "this branch"} in the product
                      </div>
                    )}
                  </div>
                  <button className="icon-btn" onClick={() => setDraft((d) => ({ ...d, lines: d.lines.filter((x) => x.variant_id !== l.variant_id) }))} aria-label="Remove">
                    <Trash2 size={18} />
                  </button>
                  <div className="row" style={{ flexBasis: "100%", marginTop: 8 }}>
                    <Stepper
                      value={Number(l.qty) || 0}
                      min={0}
                      decimals={l.item.unit === "ml" ? 1 : 0}
                      step={l.item.unit === "ml" ? 10 : 1}
                      onChange={(v) => setDraft((d) => ({ ...d, lines: d.lines.map((x) => (x.variant_id === l.variant_id ? { ...x, qty: v } : x)) }))}
                    />
                    <span className="small muted">{l.item.unit === "ml" ? "ml" : "pcs"}</span>
                    <div className="grow">
                      <MoneyInput
                        value={l.unit_cost}
                        placeholder={l.item.unit === "ml" ? "Cost/ml" : "Cost each"}
                        onChange={(v) => setDraft((d) => ({ ...d, lines: d.lines.map((x) => (x.variant_id === l.variant_id ? { ...x, unit_cost: v } : x)) }))}
                        aria-label="Unit cost"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      {lines.length > 0 && (
        <div className="cartbar" style={{ background: "#fff", color: "var(--ink)", boxShadow: "var(--shadow-up)", padding: 8, cursor: "default" }}>
          <div style={{ paddingLeft: 8 }}>
            <div className="bold">{units} units</div>
            {cost > 0 && <div className="tiny muted">Cost {inr(cost)}</div>}
          </div>
          <Button className="big grow" loading={busy} onClick={save}>
            Save stock in
          </Button>
        </div>
      )}
      <CameraScanner open={scan} onClose={() => setScan(false)} onCode={onCode} title="Scan items received" />
      {confirmNode}
    </>
  );
}

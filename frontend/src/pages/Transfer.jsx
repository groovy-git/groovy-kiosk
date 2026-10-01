import { useMemo, useState } from "react";
import { Trash2, ArrowRightLeft, ScanLine, Send } from "lucide-react";
import { useApp } from "../store";
import { api } from "../lib/api";
import { runBusy } from "../lib/busy";
import { navigate } from "../lib/router";
import { searchItems, lookupBarcode } from "../lib/catalog";
import { r3, qtyLabel } from "../lib/format";
import { beepError, beepOk, unlockAudio } from "../lib/feedback";
import { useBarcodeScanner } from "../hooks/useBarcodeScanner";
import TopBar from "../components/TopBar";
import CameraScanner from "../components/CameraScanner";
import { Button, Chips, Empty, Field, SearchBar, Stepper, Thumb } from "../components/ui";
import { NeedBranch } from "../components/Branch";

const draftKey = (b) => "gp_transfer_" + b;
const emptyDraft = { to: 0, note: "", lines: [] };

// Send stock from the branch you're working at to another branch (one step: it arrives immediately)
export default function Transfer() {
  const { catalog, patchStock, toast, canTransfer, branchId, branch, branches, isAllBranches } = useApp();
  const KEY = draftKey(branchId);
  const [draft, setDraftState] = useState(() => {
    try {
      return JSON.parse(sessionStorage.getItem(KEY)) || emptyDraft;
    } catch {
      return emptyDraft;
    }
  });
  const [q, setQ] = useState("");
  const [scan, setScan] = useState(false);
  const [busy, setBusy] = useState(false);

  const setDraft = (fn) =>
    setDraftState((d) => {
      const n = typeof fn === "function" ? fn(d) : fn;
      sessionStorage.setItem(KEY, JSON.stringify(n));
      return n;
    });

  const targets = branches.filter((b) => b.id !== branchId);
  const to = draft.to || (targets.length === 1 ? targets[0].id : 0);

  // repeat scans add 1; can't send more than this branch has
  const add = (item, qty) => {
    const ex = draft.lines.find((l) => l.variant_id === item.id);
    const next = r3((ex ? ex.qty : 0) + qty);
    if (next > item.stock) return { ok: false, label: `Only ${qtyLabel(item.stock, item.unit)} of ${item.name} ${item.size} here` };
    setDraft((d) => {
      const others = d.lines.filter((l) => l.variant_id !== item.id);
      return { ...d, lines: [{ variant_id: item.id, qty: next }, ...others] };
    });
    return { ok: true, label: `${item.name} ${item.size} × ${qtyLabel(next, item.unit)}` };
  };
  const addOne = (item) => add(item, item.unit === "ml" ? Math.min(10, item.stock) : 1);

  const onCode = (code) => {
    const it = lookupBarcode(catalog, code);
    if (!it) return { ok: false, label: `Unknown barcode ${code}` };
    return addOne(it);
  };

  useBarcodeScanner((code, target) => {
    if (target && target.tagName === "INPUT") setQ("");
    const r = onCode(code);
    r.ok ? beepOk() : beepError();
    toast(r.label, r.ok ? "success" : "error", 1300);
  }, !scan);

  const results = useMemo(() => (q.trim() ? searchItems(catalog.items.filter((i) => i.stock > 0), q).slice(0, 12) : []), [q, catalog]);
  const lines = draft.lines.map((l) => ({ ...l, item: catalog.byVariant.get(l.variant_id) })).filter((l) => l.item);
  const units = r3(lines.reduce((s, l) => s + l.qty, 0));

  const send = async () => {
    if (!to) return toast("Choose the branch to send to", "error");
    setBusy(true);
    try {
      const r = await runBusy("Transferring stock…", () => api("transferStock", { to_branch_id: to, note: draft.note, lines: lines.map((l) => ({ variant_id: l.variant_id, qty: l.qty })) }));
      patchStock(r.data.stock);
      sessionStorage.removeItem(KEY);
      setDraftState(emptyDraft);
      toast(r.message, "success", 3500);
      navigate("stock/transfers", { replace: true });
    } catch (e) {
      toast(e.message, "error", 4000);
    } finally {
      setBusy(false);
    }
  };

  if (!canTransfer) return null;
  if (isAllBranches)
    return (
      <>
        <TopBar title="Transfer stock" back="stock" />
        <div className="page">
          <NeedBranch what="send stock from" />
        </div>
      </>
    );
  const toName = (branches.find((b) => b.id === to) || {}).name;

  return (
    <>
      <TopBar title="Transfer stock" back="stock" />
      <div className="page has-bar">
        <div className="card">
          <div className="small muted">From</div>
          <div className="bold serif" style={{ fontSize: 17 }}>{branch ? branch.name : ""}</div>
          <div className="field mt" style={{ marginBottom: 0 }}>
            <label>Send to</label>
            {targets.length === 0 ? (
              <div className="small muted">Add another branch in Settings → Branches first.</div>
            ) : (
              <Chips value={to} onChange={(v) => setDraft((d) => ({ ...d, to: v }))} options={targets.map((b) => ({ value: b.id, label: b.name }))} />
            )}
          </div>
          <Field label="Note (optional)">
            <input className="input" value={draft.note} onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))} placeholder="e.g. Weekend demand" />
          </Field>
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
                  const r = addOne(it);
                  if (!r.ok) toast(r.label, "error");
                  setQ("");
                }}
              >
                <Thumb item={it} size={40} />
                <div className="grow">
                  <div className="title ellipsis">{it.name}</div>
                  <div className="sub">
                    {it.size} · here {qtyLabel(it.stock, it.unit)}
                  </div>
                </div>
                <ArrowRightLeft size={20} color="var(--brown)" />
              </button>
            ))}
          </div>
        )}

        {lines.length === 0 ? (
          <Empty icon={ScanLine} title="Scan items to send" text="Scan each box. Scanning the same item again adds 1 more." />
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
                      {l.item.size} · here {qtyLabel(l.item.stock, l.item.unit)}
                    </div>
                  </div>
                  <button className="icon-btn" onClick={() => setDraft((d) => ({ ...d, lines: d.lines.filter((x) => x.variant_id !== l.variant_id) }))} aria-label="Remove">
                    <Trash2 size={18} />
                  </button>
                  <div className="row" style={{ flexBasis: "100%", marginTop: 8 }}>
                    <Stepper
                      value={l.qty}
                      min={l.item.unit === "ml" ? 1 : 1}
                      max={l.item.stock}
                      decimals={l.item.unit === "ml" ? 1 : 0}
                      step={l.item.unit === "ml" ? 10 : 1}
                      onChange={(v) => setDraft((d) => ({ ...d, lines: d.lines.map((x) => (x.variant_id === l.variant_id ? { ...x, qty: v } : x)) }))}
                    />
                    <span className="small muted">{l.item.unit === "ml" ? "ml" : "pcs"}</span>
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
            <div className="tiny muted">{toName ? `to ${toName}` : "choose branch"}</div>
          </div>
          <Button className="big grow" loading={busy} disabled={!to} onClick={send}>
            <Send size={18} /> Send stock
          </Button>
        </div>
      )}
      <CameraScanner open={scan} onClose={() => setScan(false)} onCode={onCode} title="Scan items to send" />
    </>
  );
}

import { useEffect, useState } from "react";
import { Users, Phone, MessageCircle, Plus, Pencil } from "lucide-react";
import { useApp } from "../store";
import { api } from "../lib/api";
import { useCachedFetch } from "../lib/cached";
import { runBusy } from "../lib/busy";
import { navigate } from "../lib/router";
import { inr, relDay, fmtDateTime } from "../lib/format";
import TopBar, { Updating } from "../components/TopBar";
import { Avatar, Button, Empty, Field, SearchBar, Sheet, SkeletonList } from "../components/ui";
import { STATUS } from "./Sales";

export default function Customers() {
  const { toast } = useApp();
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(null);
  const [edit, setEdit] = useState(null);

  // ask only once typing stops, and keep the previous list on screen meanwhile
  useEffect(() => {
    const t = setTimeout(() => setQ(typed), typed ? 350 : 0);
    return () => clearTimeout(t);
  }, [typed]);

  const { data: list, loading, reload: load } = useCachedFetch(
    `gp_customers_${q || "all"}`,
    () => api("listCustomers", { q }).then((r) => r.data),
    [q],
    (e) => toast(e.message, "error"),
  );

  return (
    <>
      <TopBar title="Customers" back="more" right={loading && list ? <Updating /> : null} />
      <div className="page">
        <SearchBar value={typed} onChange={setTyped} placeholder="Name or mobile number" />
        {!list ? (
          <div className="mt">
            <SkeletonList />
          </div>
        ) : list.length === 0 ? (
          <Empty icon={Users} title="No customers yet" text="Customers are saved automatically when you enter a mobile number at checkout." />
        ) : (
          <div className="list mt">
            {list.map((c) => (
              <button key={c.id} className="list-item" onClick={() => setOpen(c)}>
                <Avatar name={c.name || c.phone} />
                <div className="grow">
                  <div className="title">{c.name || "—"}</div>
                  <div className="sub">
                    {c.phone} · {c.bills} bills{c.last_visit ? " · " + relDay(c.last_visit) : ""}
                  </div>
                </div>
                <b className="money">{inr(c.total_spent)}</b>
              </button>
            ))}
          </div>
        )}
      </div>
      <button className="fab" onClick={() => setEdit({ name: "", phone: "", gstin: "" })}>
        <Plus size={20} /> Customer
      </button>
      <CustomerSheet c={open} onClose={() => setOpen(null)} onEdit={(c) => setEdit(c)} />
      <EditSheet
        c={edit}
        onClose={() => setEdit(null)}
        onSaved={(c) => {
          setEdit(null);
          setOpen(c);
          load();
        }}
      />
    </>
  );
}

function CustomerSheet({ c, onClose, onEdit }) {
  const [h, setH] = useState(null);
  useEffect(() => {
    setH(null);
    if (c && c.id)
      api("customerHistory", { id: c.id })
        .then((r) => setH(r.data))
        .catch(() => setH({ sales: [] }));
  }, [c]);
  if (!c) return null;
  return (
    <Sheet open onClose={onClose} title={c.name || c.phone}>
      <div className="grid-3">
        <div className="stat">
          <div className="label">Spent</div>
          <div className="value" style={{ fontSize: 17 }}>{inr(c.total_spent)}</div>
        </div>
        <div className="stat">
          <div className="label">Bills</div>
          <div className="value" style={{ fontSize: 17 }}>{c.bills}</div>
        </div>
        <div className="stat">
          <div className="label">Avg bill</div>
          <div className="value" style={{ fontSize: 17 }}>{inr(c.bills ? Math.round(c.total_spent / c.bills) : 0)}</div>
        </div>
      </div>
      <div className="grid-3 mt">
        <a className="btn secondary small" href={`tel:+91${c.phone}`}>
          <Phone size={16} /> Call
        </a>
        <a className="btn wa small" href={`https://wa.me/91${c.phone}`} target="_blank" rel="noreferrer">
          <MessageCircle size={16} /> Chat
        </a>
        <button className="btn secondary small" onClick={() => onEdit(c)}>
          <Pencil size={16} /> Edit
        </button>
      </div>
      {c.gstin && <div className="small muted mt">GSTIN: {c.gstin}</div>}
      <div className="section-label">Purchase history</div>
      {!h ? (
        <SkeletonList rows={3} height={52} />
      ) : h.sales.length === 0 ? (
        <div className="muted small">No bills yet.</div>
      ) : (
        <div className="list">
          {h.sales.map((s) => (
            <button key={s.id} className="list-item" onClick={() => navigate(`sales/${s.id}`)}>
              <div className="grow">
                <div className="title small">{s.invoice_no}</div>
                <div className="sub">
                  {fmtDateTime(s.date)} · {s.salesman_name}
                </div>
              </div>
              <div className="right">
                <b className="money">{inr(s.grand_total - s.refunded)}</b>
                {s.status !== "completed" && <div><span className={"badge " + STATUS[s.status].cls}>{STATUS[s.status].label}</span></div>}
              </div>
            </button>
          ))}
        </div>
      )}
    </Sheet>
  );
}

function EditSheet({ c, onClose, onSaved }) {
  const { toast } = useApp();
  const [f, setF] = useState(c || {});
  const [busy, setBusy] = useState(false);
  useEffect(() => setF(c || {}), [c]);
  if (!c) return null;
  const save = async () => {
    setBusy(true);
    try {
      const r = await runBusy("Saving customer…", () => api("saveCustomer", f));
      toast(r.message, "success");
      onSaved(r.data);
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open onClose={onClose} title={c.id ? "Edit customer" : "New customer"} footer={<Button className="block big" loading={busy} onClick={save}>Save</Button>}>
      <Field label="Mobile number">
        <input className="input" type="tel" inputMode="numeric" maxLength={10} value={f.phone || ""} onChange={(e) => setF({ ...f, phone: e.target.value.replace(/\D/g, "") })} />
      </Field>
      <Field label="Name">
        <input className="input" value={f.name || ""} onChange={(e) => setF({ ...f, name: e.target.value })} autoCapitalize="words" />
      </Field>
      <Field label="GSTIN (business customers)">
        <input className="input" maxLength={15} value={f.gstin || ""} onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase() })} />
      </Field>
    </Sheet>
  );
}

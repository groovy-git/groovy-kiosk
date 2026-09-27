import { useEffect, useState } from "react";
import { Plus, Wallet, Trash2 } from "lucide-react";
import { useApp } from "../store";
import { api } from "../lib/api";
import { useCachedFetch } from "../lib/cached";
import { runBusy } from "../lib/busy";
import { inr, istDate, monthStart, relDay, METHOD_LABEL } from "../lib/format";
import TopBar, { Updating } from "../components/TopBar";
import { Button, Chips, DateField, Empty, Field, MoneyInput, Seg, Sheet, SkeletonList, useConfirm } from "../components/ui";

function lastMonth() {
  const [y, m] = istDate().split("-").map(Number);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  const days = new Date(py, pm, 0).getDate();
  const mm = String(pm).padStart(2, "0");
  return [`${py}-${mm}-01`, `${py}-${mm}-${days}`];
}

export default function Expenses() {
  const { toast, isAllBranches, multiBranch } = useApp();
  const [preset, setPreset] = useState("month");
  const [edit, setEdit] = useState(null);
  const [from, to] = preset === "month" ? [monthStart(), istDate()] : preset === "last" ? lastMonth() : [istDate(), istDate()];

  const { data, loading, reload: load } = useCachedFetch(
    `gp_expenses_${from}_${to}`,
    () => api("listExpenses", { from, to }).then((r) => r.data),
    [from, to],
    (e) => toast(e.message, "error"),
  );

  return (
    <>
      <TopBar title="Expenses" back="more" right={loading && data ? <Updating /> : null} />
      <div className="page">
        <Chips
          value={preset}
          onChange={setPreset}
          options={[
            { value: "today", label: "Today" },
            { value: "month", label: "This month" },
            { value: "last", label: "Last month" },
          ]}
        />
        {data && (
          <div className="stat brown mt">
            <div className="label">Total spent</div>
            <div className="value">{inr(data.total)}</div>
          </div>
        )}
        {!data ? (
          <div className="mt">
            <SkeletonList />
          </div>
        ) : data.expenses.length === 0 ? (
          <Empty icon={Wallet} title="No expenses" text="Add shop expenses like rent, salary, tea or packaging." />
        ) : (
          <div className="list mt">
            {data.expenses.map((e) => (
              <button key={e.id} className="list-item" onClick={() => setEdit(e)}>
                <div className="grow">
                  <div className="title">{e.title}</div>
                  <div className="sub">
                    {relDay(e.date)} · {e.category} · {METHOD_LABEL[e.method]} · {e.user_name}
                    {multiBranch && isAllBranches ? " · " + e.branch_name : ""}
                  </div>
                </div>
                <b className="money">{inr(e.amount)}</b>
              </button>
            ))}
          </div>
        )}
      </div>
      {!isAllBranches && (
      <button className="fab" onClick={() => setEdit({ date: istDate(), category: "", title: "", amount: "", method: "cash", notes: "" })}>
        <Plus size={20} /> Expense
      </button>
      )}
      <ExpenseSheet
        e={edit}
        onClose={() => setEdit(null)}
        onSaved={() => {
          setEdit(null);
          load();
        }}
      />
    </>
  );
}

function ExpenseSheet({ e, onClose, onSaved }) {
  const { settings, toast } = useApp();
  const [f, setF] = useState(e || {});
  const [busy, setBusy] = useState(false);
  const [confirm, confirmNode] = useConfirm();
  useEffect(() => setF(e || {}), [e]);
  if (!e) return null;
  const cats = String(settings.expense_categories || "Other").split(",").map((s) => s.trim()).filter(Boolean);
  const save = async () => {
    setBusy(true);
    try {
      const r = await runBusy("Saving expense…", () => api("saveExpense", { ...f, category: f.category || cats[cats.length - 1] }));
      toast(r.message, "success");
      onSaved();
    } catch (ex) {
      toast(ex.message, "error");
    } finally {
      setBusy(false);
    }
  };
  const del = async () => {
    if (!(await confirm({ title: "Delete expense?", text: `${e.title} · ${inr(e.amount)}`, okText: "Delete", danger: true }))) return;
    try {
      await runBusy("Deleting expense…", () => api("deleteExpense", { id: e.id }));
      toast("Expense deleted", "success");
      onSaved();
    } catch (ex) {
      toast(ex.message, "error");
    }
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={e.id ? "Edit expense" : "Add expense"}
      headerRight={
        e.id && (
          <button className="icon-btn" onClick={del} aria-label="Delete expense">
            <Trash2 size={20} />
          </button>
        )
      }
      footer={<Button className="block big" loading={busy} onClick={save}>Save</Button>}
    >
      <Field label="Amount">
        <MoneyInput value={String(f.amount ?? "")} onChange={(v) => setF({ ...f, amount: v })} autoFocus={!e.id} />
      </Field>
      <div className="field">
        <label>Category</label>
        <div className="chips" style={{ flexWrap: "wrap" }}>
          {cats.map((c) => (
            <button key={c} className={"chip" + (f.category === c ? " active" : "")} onClick={() => setF({ ...f, category: c, title: f.title || c })}>
              {c}
            </button>
          ))}
        </div>
      </div>
      <Field label="What for?">
        <input className="input" value={f.title || ""} onChange={(ev) => setF({ ...f, title: ev.target.value })} placeholder="e.g. Electricity bill" />
      </Field>
      <div className="grid-2">
        <Field label="Date">
          <DateField max={istDate()} value={f.date || istDate()} onChange={(ev) => setF({ ...f, date: ev.target.value })} aria-label="Date" />
        </Field>
        <div className="field">
          <label>Paid by</label>
          <Seg value={f.method || "cash"} onChange={(m) => setF({ ...f, method: m })} options={["cash", "upi", "card"].map((m) => ({ value: m, label: METHOD_LABEL[m] }))} />
        </div>
      </div>
      <Field label="Note (optional)">
        <input className="input" value={f.notes || ""} onChange={(ev) => setF({ ...f, notes: ev.target.value })} />
      </Field>
      {confirmNode}
    </Sheet>
  );
}

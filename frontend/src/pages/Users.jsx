import { useEffect, useMemo, useState } from "react";
import { Plus, UserCog } from "lucide-react";
import { useApp } from "../store";
import { api } from "../lib/api";
import { useCachedFetch } from "../lib/cached";
import { runBusy } from "../lib/busy";
import { ROLE_LABEL } from "../lib/format";
import TopBar, { Updating } from "../components/TopBar";
import { Avatar, Button, Empty, Field, Seg, Sheet, SkeletonList, useConfirm } from "../components/ui";

const ROLE_ORDER = { owner: 0, admin: 0, manager: 1, salesperson: 2, stock_mover: 3 };

export default function UsersPage() {
  const { toast, user, setSellers, branches, multiBranch } = useApp();
  const branchName = (id) => (branches.find((b) => b.id === id) || {}).name || "";
  const [edit, setEdit] = useState(null);

  // the staff list as it was last time, then refreshed
  const { data: list, loading, reload: load } = useCachedFetch(
    "gp_users",
    () => api("listUsers").then((r) => r.data),
    [],
    (e) => toast(e.message, "error"),
  );
  // the "sold by" picker elsewhere in the app reads this (a stock mover never sells, so is not in it)
  useEffect(() => {
    if (list) setSellers(list.filter((u) => u.active && u.role !== "stock_mover").map((u) => ({ id: u.id, name: u.name, role: u.role })));
  }, [list, setSellers]);

  // active first, then owners, managers, salespeople, then by name. An unknown role sorts last rather
  // than breaking the page. The copy is because sort() would otherwise mutate state in place.
  const ordered = useMemo(
    () =>
      list
        ? [...list].sort(
            (a, b) =>
              (a.active ? 0 : 1) - (b.active ? 0 : 1) ||
              (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9) ||
              String(a.name || "").localeCompare(String(b.name || "")),
          )
        : null,
    [list],
  );

  return (
    <>
      <TopBar title="Staff" back="more" right={loading && list ? <Updating /> : null} />
      <div className="page">
        <p className="small muted" style={{ marginTop: 0 }}>
          Everyone can sell. Managers also handle stock, returns, expenses and reports. Only the owner manages staff and settings.
          {multiBranch && " A Stock Mover only moves and adjusts stock, and sees no sales."}
        </p>
        {!list ? (
          <SkeletonList />
        ) : ordered.length === 0 ? (
          <Empty icon={UserCog} title="No staff" />
        ) : (
          <div className="list">
            {ordered.map((u) => (
              <button key={u.id} className="list-item" onClick={() => setEdit(u)} style={u.active ? null : { opacity: 0.55 }}>
                <Avatar name={u.name} gold={u.role === "owner"} />
                <div className="grow">
                  <div className="title">
                    {u.name} {u.id === user.id && <span className="muted small">(you)</span>}
                  </div>
                  <div className="sub ellipsis">
                    {u.email}
                    {multiBranch && u.role !== "owner" && u.branch_id ? " · " + branchName(u.branch_id) : ""}
                  </div>
                </div>
                <span className={"badge " + (u.active ? (u.role === "owner" ? "dark" : u.role === "manager" ? "gold" : "") : "bad")}>
                  {u.active ? ROLE_LABEL[u.role] : "Inactive"}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      <button className="fab" onClick={() => setEdit({ name: "", email: "", phone: "", role: "salesperson", branch_id: branches[0] ? branches[0].id : 0, works_at: [] })}>
        <Plus size={20} /> Add staff
      </button>
      <UserSheet
        u={edit}
        onClose={() => setEdit(null)}
        onSaved={() => {
          setEdit(null);
          load();
        }}
      />
    </>
  );
}

function UserSheet({ u, onClose, onSaved }) {
  const { toast, user, branches, multiBranch } = useApp();
  const [f, setF] = useState(u || {});
  const [pwd, setPwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, confirmNode] = useConfirm();
  useEffect(() => {
    // staff added before branches existed have no home branch yet → default to the first one
    setF(u ? { ...u, branch_id: u.branch_id || (branches[0] || {}).id, works_at: u.works_at || [] } : {});
    setPwd("");
  }, [u]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!u) return null;
  const self = u.id === user.id;
  // moving stock needs a second branch to move it to; someone already a stock mover keeps the choice
  const moverChoice = multiBranch || u.role === "stock_mover" || f.role === "stock_mover";

  const run = async (action, payload, msg) => {
    setBusy(true);
    try {
      const r = await runBusy(action === "deleteUser" ? "Deleting staff…" : "Saving staff…", () => api(action, payload));
      toast(msg || r.message, "success");
      onSaved();
    } catch (e) {
      toast(e.message, "error", 4000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={u.id ? "Edit staff" : "Add staff"}
      footer={
        <Button
          className="block big"
          loading={busy}
          onClick={() => run("saveUser", { ...f, password: pwd || undefined, branch_ids: (f.works_at || []).length ? f.works_at : [] })}
        >
          Save
        </Button>
      }
    >
      <Field label="Name">
        <input className="input" value={f.name || ""} onChange={(e) => setF({ ...f, name: e.target.value })} autoCapitalize="words" />
      </Field>
      <Field label="Email (used to log in)">
        <input className="input" type="email" inputMode="email" value={f.email || ""} onChange={(e) => setF({ ...f, email: e.target.value })} />
      </Field>
      <Field label="Mobile">
        <input className="input" type="tel" inputMode="numeric" value={f.phone || ""} onChange={(e) => setF({ ...f, phone: e.target.value })} />
      </Field>
      <div className="field">
        <label>Role</label>
        <Seg
          value={f.role}
          onChange={(r) => !self && setF({ ...f, role: r })}
          wrap={moverChoice}
          options={[
            { value: "salesperson", label: "Salesperson" },
            { value: "manager", label: "Manager" },
            { value: "owner", label: "Owner" },
            ...(moverChoice ? [{ value: "stock_mover", label: "Stock Mover" }] : []),
          ]}
        />
        {f.role === "stock_mover" && (
          <div className="hint">Sees products and stock at the branches ticked below, moves stock between branches and adjusts it. No sales, customers or reports.</div>
        )}
      </div>
      {multiBranch && f.role !== "owner" && (
        <>
          <Field label="Home branch" hint="Where the app opens after login">
            <select className="input" value={f.branch_id || ""} onChange={(e) => setF({ ...f, branch_id: Number(e.target.value) })}>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="field">
            <label>Works at (can switch to)</label>
            <label className="row small" style={{ minHeight: 36 }}>
              <input
                type="checkbox"
                checked={!(f.works_at || []).length}
                onChange={(e) => setF({ ...f, works_at: e.target.checked ? [] : [f.branch_id || branches[0].id] })}
                style={{ width: 20, height: 20, accentColor: "var(--brown)" }}
              />
              All branches
            </label>
            {(f.works_at || []).length > 0 &&
              branches.map((b) => (
                <label key={b.id} className="row small" style={{ minHeight: 36, paddingLeft: 26 }}>
                  <input
                    type="checkbox"
                    checked={f.works_at.includes(b.id) || b.id === f.branch_id}
                    disabled={b.id === f.branch_id}
                    onChange={(e) =>
                      setF({ ...f, works_at: e.target.checked ? [...f.works_at, b.id] : f.works_at.filter((x) => x !== b.id) })
                    }
                    style={{ width: 20, height: 20, accentColor: "var(--brown)" }}
                  />
                  {b.name} {b.id === f.branch_id && <span className="muted">(home)</span>}
                </label>
              ))}
          </div>
        </>
      )}
      <Field label={u.id ? "New password (leave empty to keep)" : "Password"} hint="At least 6 characters. Share it with the staff member privately.">
        <input className="input" type="text" autoComplete="new-password" value={pwd} onChange={(e) => setPwd(e.target.value)} />
      </Field>
      {u.id && !self && (
        <div className="grid-2 mt">
          <button className="btn secondary" disabled={busy} onClick={() => run("toggleUser", { id: u.id })}>
            {u.active ? "Deactivate" : "Activate"}
          </button>
          <button
            className="btn danger"
            disabled={busy || u.has_sales}
            onClick={async () => (await confirm({ title: `Delete ${u.name}?`, text: "This cannot be undone.", okText: "Delete", danger: true })) && run("deleteUser", { id: u.id })}
          >
            Delete
          </button>
        </div>
      )}
      {u.has_sales && <div className="tiny muted mt">Has sales — deactivate instead of deleting so their sales history stays.</div>}
      {confirmNode}
    </Sheet>
  );
}

import { useState } from "react";
import { Banknote, Check, HandCoins, Plus, RefreshCw, Undo2 } from "lucide-react";
import { useApp } from "../store";
import { api } from "../lib/api";
import { useCachedFetch } from "../lib/cached";
import { runBusy } from "../lib/busy";
import { inr, fmtDateTime, r2, relDay } from "../lib/format";
import TopBar, { Updating } from "../components/TopBar";
import { Button, Field, MoneyInput, Sheet, SkeletonList, useConfirm } from "../components/ui";

/**
 * Cash at the kiosk (backend/cash.gs). UPI and card go to the bank; cash waits in the drawer for the owner.
 * The figure is what should be there now: what was left at the owner's last count, plus cash sales, less
 * cash refunds and cash expenses since. Only the owner counts, takes or puts in cash; managers look.
 */

// "₹50 short" / "₹20 extra" — a count set against what the app expected
export function DiffBadge({ diff }) {
  if (!diff) return null;
  return <span className={"badge " + (diff < 0 ? "bad" : "ok")}>{inr(Math.abs(diff))} {diff < 0 ? "short" : "extra"}</span>;
}

const TITLE = { take: "Took cash", count: "Counted", add: "Put cash in" };

export default function Cash() {
  const { toast, isAdmin, branchId, isAllBranches } = useApp();
  const key = `gp_cash_${branchId}`;
  const { data: d, loading, reload, replace } = useCachedFetch(key, () => api("cashBook").then((r) => r.data), [branchId], (e) => toast(e.message, "error"));
  const [sheet, setSheet] = useState(null); // "take" | "count" | "add"
  const [confirm, confirmNode] = useConfirm();

  // a save answers with the book as it now stands: shown at once, and a load still on its way (asked for
  // before the save, so older) is not let back over it
  const saved = (r) => {
    replace(r.data);
    setSheet(null);
    toast(r.message, "success", 5000);
  };

  const undo = async (e) => {
    const what = e.type === "take" ? `${TITLE.take}: ${inr(e.amount)}` : e.type === "add" ? `${TITLE.add}: ${inr(e.amount)}` : `${TITLE.count}: ${inr(e.counted)}`;
    if (!(await confirm({ title: "Undo this entry?", text: `${what} · ${fmtDateTime(e.at)}. The drawer goes back to what it was before it.`, okText: "Undo", danger: true }))) return;
    try {
      saved(await runBusy("Undoing…", () => api("undoCash", { id: e.id, at: e.at })));
    } catch (ex) {
      toast(ex.message, "error");
    }
  };

  const b = d && !isAllBranches ? d.branches[0] : null;

  return (
    <>
      <TopBar
        title="Cash at kiosk"
        back="more"
        right={
          loading && d ? (
            <Updating />
          ) : (
            <button className="icon-btn" onClick={reload} aria-label="Refresh">
              <RefreshCw size={20} />
            </button>
          )
        }
      />
      <div className="page">
        {!d ? (
          <SkeletonList rows={4} height={80} />
        ) : isAllBranches ? (
          <>
            <div className="card">
              <div className="card-title">
                <h3>Cash in each drawer</h3>
              </div>
              {d.branches.map((x) => (
                <div key={x.branch_id} className="kv">
                  <span>
                    <b>{x.branch_name}</b>
                    <div className="tiny muted">{x.started ? `Since the count on ${fmtDateTime(x.since_at)}` : "Not counted yet"}</div>
                  </span>
                  <b className="money">{x.started ? inr(x.now) : "—"}</b>
                </div>
              ))}
              <div className="tiny muted mt">Switch to a branch at the top to count or take its cash.</div>
            </div>
            <History entries={d.entries} showBranch />
          </>
        ) : !b.started ? (
          <div className="card center">
            <Banknote size={40} color="var(--brown)" />
            <h3 className="mt">Count the drawer to start</h3>
            <p className="small muted">
              Count the cash in this branch's drawer once. From then on the app adds cash sales and takes off cash refunds and cash expenses, so you always know what should be
              there.
            </p>
            {isAdmin ? (
              <Button className="block big" onClick={() => setSheet("count")}>
                Count the drawer
              </Button>
            ) : (
              <div className="small muted">The owner counts the drawer once to start.</div>
            )}
          </div>
        ) : (
          <>
            <div className="stat brown">
              <div className="label">Cash in drawer now</div>
              <div className="value">{inr(b.now)}</div>
              <div className="tiny" style={{ color: "var(--cream)" }}>
                Expected · since the count on {fmtDateTime(b.since_at)}
              </div>
            </div>
            <div className="card mt">
              <div className="kv small">
                <span className="k">Left at that count</span>
                <span className="money">{inr(b.left)}</span>
              </div>
              <div className="kv small">
                <span className="k">Cash sales since</span>
                <span className="money">+{inr(b.cash_in)}</span>
              </div>
              {b.cash_out > 0 && (
                <div className="kv small">
                  <span className="k">Cash refunds and voids</span>
                  <span className="money">−{inr(b.cash_out)}</span>
                </div>
              )}
              {b.expenses > 0 && (
                <div className="kv small">
                  <span className="k">Cash expenses</span>
                  <span className="money">−{inr(b.expenses)}</span>
                </div>
              )}
              <div className="kv total">
                <span>Expected now</span>
                <span className="money">{inr(b.now)}</span>
              </div>
            </div>
            {/* every cash expense taken off since the count, and who added it: to check as you count */}
            {(b.expense_list || []).length > 0 && (
              <div className="card mt">
                <div className="card-title">
                  <h3>Cash expenses since the count</h3>
                  <span className="small muted money">−{inr(b.expenses)}</span>
                </div>
                {b.expense_list.map((x) => (
                  <div key={x.id} className="kv small">
                    <span className="grow">
                      {x.title}
                      <div className="tiny muted">
                        {relDay(x.date)} · {x.user_name}
                      </div>
                    </span>
                    <span className="money">{inr(x.amount)}</span>
                  </div>
                ))}
                <div className="tiny muted mt">Check these as you count. A manager or you can change or delete one in Expenses.</div>
              </div>
            )}
            {isAdmin && (
              <>
                <Button className="block big mt" onClick={() => setSheet("take")}>
                  <HandCoins size={20} /> Count &amp; take cash
                </Button>
                <div className="grid-2 mt">
                  <button className="btn secondary" onClick={() => setSheet("count")}>
                    Count only
                  </button>
                  <button className="btn secondary" onClick={() => setSheet("add")}>
                    <Plus size={18} /> Put cash in
                  </button>
                </div>
              </>
            )}
            <History entries={d.entries} onUndo={isAdmin && d.can_edit ? undo : null} />
          </>
        )}
      </div>
      {sheet && b && <CashSheet type={sheet} drawer={b} onClose={() => setSheet(null)} onSaved={saved} />}
      {confirmNode}
    </>
  );
}

function History({ entries, onUndo, showBranch }) {
  if (!entries.length) return null;
  return (
    <>
      <div className="section-label">History</div>
      <div className="list">
        {entries.map((e) => (
          <div key={e.id} className="list-item" style={{ cursor: "default" }}>
            <div className="grow">
              <div className="title">
                {e.type === "take" ? `${TITLE.take}: ${inr(e.amount)}` : e.type === "add" ? `${TITLE.add}: ${inr(e.amount)}` : e.first ? "First count" : TITLE.count}
              </div>
              <div className="sub">
                {fmtDateTime(e.at)} · {e.user_name}
                {showBranch ? ` · ${e.branch_name}` : ""}
              </div>
              {e.type !== "add" && (
                <div className="sub">
                  Counted {inr(e.counted)}
                  {!e.first && e.difference === 0 ? " · as expected" : ""}
                  {e.handed_by ? ` · handed over by ${e.handed_by}` : ""}
                </div>
              )}
              {e.notes && <div className="sub">{e.notes}</div>}
            </div>
            <div className="badge-stack">
              <b className="money">Left {inr(e.balance)}</b>
              <DiffBadge diff={e.difference} />
              {onUndo && e.latest && (
                <button className="btn ghost small" onClick={() => onUndo(e)}>
                  <Undo2 size={16} /> Undo
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/** The owner at the drawer: count it, take cash (after counting), or put cash in. */
function CashSheet({ type, drawer, onClose, onSaved }) {
  const { sellers, toast, user } = useApp();
  const [f, setF] = useState({ counted: "", amount: "", handed_by: "", notes: "" });
  const staff = sellers.filter((s) => s.id !== user.id); // who handed it over: anyone but the one taking it
  const [busy, setBusy] = useState(false);
  // the box takes digits and dots only, so "2.40.0" can be typed: it is not a number, and must not be saved as ₹0
  const bad = (s) => s !== "" && !/^(\d+\.?\d{0,2}|\.\d{1,2})$/.test(s);
  const countedBad = bad(f.counted);
  const amountBad = bad(f.amount);
  const notNumber = "That isn't an amount. Check the dots.";
  const counted = f.counted === "" || countedBad ? null : r2(Number(f.counted));
  const amount = amountBad ? 0 : r2(Number(f.amount) || 0);
  // the very first count has nothing to be set against
  const diff = drawer.started && counted !== null ? r2(counted - drawer.now) : 0;
  const left = counted === null ? null : r2(counted - amount);
  const tooMuch = type === "take" && counted !== null && amount > counted;

  const save = async () => {
    if (countedBad || amountBad) return toast(notNumber, "error");
    if (type !== "add" && counted === null) return toast("Count the cash in the drawer and enter it", "error");
    if (type !== "count" && !(amount > 0)) return toast(type === "take" ? "Enter the cash you are taking" : "Enter the cash you are putting in", "error");
    if (tooMuch) return toast(`You can't take more than the ${inr(counted)} in the drawer`, "error");
    setBusy(true);
    try {
      const r = await runBusy("Saving…", () => api("cashEntry", { type, counted: type === "add" ? "" : counted, amount: type === "count" ? 0 : amount, handed_by: f.handed_by, notes: f.notes.trim() }));
      onSaved(r);
    } catch (ex) {
      toast(ex.message, "error");
    } finally {
      setBusy(false);
    }
  };

  const title = type === "take" ? "Count & take cash" : type === "add" ? "Put cash in" : drawer.started ? "Count the drawer" : "First count";
  const button = type === "take" ? (amount > 0 ? `Take ${inr(amount)}` : "Take cash") : type === "add" ? (amount > 0 ? `Put in ${inr(amount)}` : "Put in") : "Save count";

  return (
    <Sheet
      open
      onClose={onClose}
      title={title}
      footer={
        <Button className="block big" loading={busy} onClick={save} disabled={tooMuch || countedBad || amountBad}>
          {button}
        </Button>
      }
    >
      {drawer.started && (
        <div className="kv">
          <span className="k">Expected in the drawer</span>
          <b className="money">{inr(drawer.now)}</b>
        </div>
      )}
      {type !== "add" && (
        <Field
          label="Counted in the drawer"
          error={countedBad ? notNumber : ""}
          hint={drawer.started ? "Count every note and coin. Any difference is kept as short or extra." : "What is in the drawer now. The app starts from this."}
        >
          {/* left empty on purpose: a box already showing the expected amount is easy to save without counting,
              and then every count reads "as expected". The button below is the quick way once it matches. */}
          <MoneyInput value={f.counted} onChange={(v) => setF({ ...f, counted: v })} placeholder="Count and enter" autoFocus />
        </Field>
      )}
      {type !== "add" && drawer.started && drawer.now >= 0 && counted !== drawer.now && (
        <button type="button" className="btn secondary small" style={{ marginTop: -6, marginBottom: 14 }} onClick={() => setF({ ...f, counted: String(drawer.now) })}>
          <Check size={16} /> Counted, matches {inr(drawer.now)}
        </button>
      )}
      {type !== "add" && drawer.started && counted !== null && (
        <div className="kv small" style={{ marginTop: -6 }}>
          <span className="k">Against what was expected</span>
          {diff ? <DiffBadge diff={diff} /> : <span className="badge ok">Matches</span>}
        </div>
      )}
      {type === "take" && (
        <Field label="Taking" error={amountBad ? notNumber : tooMuch ? `More than the ${inr(counted)} counted` : ""}>
          <MoneyInput value={f.amount} onChange={(v) => setF({ ...f, amount: v })} />
        </Field>
      )}
      {type === "add" && (
        <Field label="Putting in" hint="Change you brought for the drawer" error={amountBad ? notNumber : ""}>
          <MoneyInput value={f.amount} onChange={(v) => setF({ ...f, amount: v })} autoFocus />
        </Field>
      )}
      {type === "take" && left !== null && !tooMuch && (
        <div className="kv total" style={{ marginTop: 0 }}>
          <span>Stays at the kiosk</span>
          <span className="money">{inr(left)}</span>
        </div>
      )}
      {type === "add" && amount > 0 && (
        <div className="kv total" style={{ marginTop: 0 }}>
          <span>In the drawer after</span>
          <span className="money">{inr(r2(drawer.now + amount))}</span>
        </div>
      )}
      {type !== "add" && (
        <Field label="Handed over by (optional)">
          <select className="input" value={f.handed_by} onChange={(e) => setF({ ...f, handed_by: e.target.value })}>
            <option value="">—</option>
            {staff.map((s) => (
              <option key={s.id} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Note (optional)">
        <input className="input" maxLength={200} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
      </Field>
    </Sheet>
  );
}

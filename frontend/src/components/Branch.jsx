import { useState } from "react";
import { MapPin, ChevronDown, Check, Store, Layers } from "lucide-react";
import { useApp } from "../store";
import { Sheet } from "./ui";

// "📍 Kondhwa ▾" under the screen title — tap to switch branch
export function BranchChip() {
  const { multiBranch, branch, myBranches, isAdmin } = useApp();
  const [open, setOpen] = useState(false);
  if (!multiBranch) return null;
  const canSwitch = myBranches.length > 1 || isAdmin;
  return (
    <>
      <button className="branch-chip" onClick={() => canSwitch && setOpen(true)} disabled={!canSwitch} aria-label="Change branch">
        <MapPin size={13} />
        <span className="ellipsis">{branch ? branch.name : "All branches"}</span>
        {canSwitch && <ChevronDown size={14} />}
      </button>
      <BranchSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function BranchList({ onPick }) {
  const { myBranches, branchId, isAdmin } = useApp();
  const options = [...myBranches.map((b) => ({ id: b.id, name: b.name, sub: b.address })), ...(isAdmin ? [{ id: 0, name: "All branches", sub: "Combined reports (no selling)" }] : [])];
  return (
    <div className="list">
      {options.map((o) => (
        <button key={o.id} className="list-item" onClick={() => onPick(o.id)}>
          <div className={"avatar" + (o.id === branchId ? " gold" : "")}>{o.id ? <Store size={19} /> : <Layers size={19} />}</div>
          <div className="grow">
            <div className="title">{o.name}</div>
            {o.sub && <div className="sub ellipsis">{o.sub}</div>}
          </div>
          {o.id === branchId && <Check color="var(--ok)" />}
        </button>
      ))}
    </div>
  );
}

export function BranchSheet({ open, onClose }) {
  const { switchBranch, branchId, isMover } = useApp();
  return (
    <Sheet open={open} onClose={onClose} title="Switch branch">
      <BranchList
        onPick={(id) => {
          onClose();
          if (id !== branchId) switchBranch(id);
        }}
      />
      <p className="tiny muted center">
        {isMover ? "Stock and transfers follow the branch you choose." : "Stock, bills and reports follow the branch you choose. A bill in progress stays with its branch."}
      </p>
    </Sheet>
  );
}

// shown once per phone after login when the person can work at more than one branch
export function BranchPicker() {
  const { pickBranch, setPickBranch, switchBranch, user, branchId } = useApp();
  if (!pickBranch) return null;
  return (
    <Sheet
      open
      onClose={() => {
        localStorage.setItem("gp_branch_picked_" + user.id, "1");
        setPickBranch(false);
      }}
      title="Where are you working today?"
    >
      <BranchList onPick={(id) => (id === branchId ? (localStorage.setItem("gp_branch_picked_" + user.id, "1"), setPickBranch(false)) : switchBranch(id))} />
      <p className="tiny muted center">You can change this any time from the branch name at the top.</p>
    </Sheet>
  );
}

// the owner on "All branches" must pick a branch before selling / moving stock
export function NeedBranch({ what = "continue" }) {
  const { myBranches, switchBranch } = useApp();
  return (
    <div className="card mt center">
      <Store size={36} color="var(--gold-dark)" />
      <h3 className="mt">Choose a branch to {what}</h3>
      <p className="small muted">You're viewing all branches. Selling and stock changes happen at one branch.</p>
      <div className="col">
        {myBranches.map((b) => (
          <button key={b.id} className="btn secondary block" onClick={() => switchBranch(b.id)}>
            <MapPin size={16} /> {b.name}
          </button>
        ))}
      </div>
    </div>
  );
}

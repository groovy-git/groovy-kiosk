import { ArrowLeft, RefreshCw } from "lucide-react";
import { goBack } from "../lib/router";
import { BranchChip } from "./Branch";

// top-bar sign that a list already on screen is being refreshed — the same turning icon as Home's
// refresh button, but only a sign: shown while updating, gone when done, nothing to tap
export function Updating() {
  return (
    <span className="icon-btn" role="status" aria-label="Updating" style={{ cursor: "default" }}>
      <RefreshCw size={20} className="spin" />
    </span>
  );
}

export default function TopBar({ title, back, right, branch = true }) {
  return (
    <header className="topbar">
      {back ? (
        <button className="icon-btn" onClick={() => goBack(typeof back === "string" ? back : "home")} aria-label="Back">
          <ArrowLeft />
        </button>
      ) : (
        <img className="logo menu-logo" src="./logo.svg" alt="Groovy Fragrances" />
      )}
      <div className="title-wrap">
        <h1>{title}</h1>
        {branch && <BranchChip />}
      </div>
      {right}
    </header>
  );
}

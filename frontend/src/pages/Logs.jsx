import { useEffect, useState } from "react";
import { History } from "lucide-react";
import { useApp } from "../store";
import { api } from "../lib/api";
import { useCachedFetch } from "../lib/cached";
import { fmtDateTime } from "../lib/format";
import TopBar, { Updating } from "../components/TopBar";
import { Empty, SearchBar, SkeletonList } from "../components/ui";

export default function Logs() {
  const { toast } = useApp();
  const [q, setQ] = useState("");
  const [typed, setTyped] = useState("");
  // wait for typing to stop before asking the server, and keep the last answer on screen meanwhile
  useEffect(() => {
    const t = setTimeout(() => setQ(typed), typed ? 350 : 0);
    return () => clearTimeout(t);
  }, [typed]);
  const { data: list, loading } = useCachedFetch(
    `gp_logs_${q || "all"}`,
    () => api("listLogs", { q, limit: 300 }).then((r) => r.data),
    [q],
    (e) => toast(e.message, "error"),
  );
  return (
    <>
      <TopBar title="Activity log" back="more" right={loading && list ? <Updating /> : null} />
      <div className="page">
        <SearchBar value={typed} onChange={setTyped} placeholder="Search name, action, bill no" />
        {!list ? (
          <div className="mt"><SkeletonList /></div>
        ) : list.length === 0 ? (
          <Empty icon={History} title="Nothing found" />
        ) : (
          <div className="list mt">
            {list.map((l) => (
              <div key={l.id} className="list-item" style={{ cursor: "default" }}>
                <div className="grow">
                  <div className="title small">
                    <span className="badge">{l.action}</span> {l.details || l.entity}
                  </div>
                  <div className="sub">
                    {l.user_name} · {fmtDateTime(l.at)} · {l.entity}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

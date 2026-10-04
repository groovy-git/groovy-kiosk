import { useState } from "react";
import { useApp } from "../store";
import { api } from "../lib/api";
import { runBusy } from "../lib/busy";
import { ROLE_LABEL } from "../lib/format";
import TopBar from "../components/TopBar";
import { Avatar, Button, Field } from "../components/ui";

export default function Account() {
  const { user, toast, logout, setWeakPassword } = useApp();
  const [cur, setCur] = useState("");
  const [pwd, setPwd] = useState("");
  const [pwd2, setPwd2] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (pwd !== pwd2) return toast("New passwords don't match", "error");
    setBusy(true);
    try {
      const r = await runBusy("Changing password…", () => api("changePassword", { current_password: cur, new_password: pwd }));
      toast(r.message + ". Other devices were logged out.", "success", 4000);
      setWeakPassword(false); // the server took the new one, so it is not an easy one
      setCur("");
      setPwd("");
      setPwd2("");
    } catch (ex) {
      toast(ex.message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <TopBar title="My account" back="more" />
      <div className="page">
        <div className="card row">
          <Avatar name={user.name} gold />
          <div>
            <div className="bold serif" style={{ fontSize: 17 }}>{user.name}</div>
            <div className="small muted">
              {ROLE_LABEL[user.role]} · {user.email}
            </div>
          </div>
        </div>
        <form className="card" onSubmit={submit}>
          <h3 className="mb">Change password</h3>
          <Field label="Current password">
            <input className="input" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required />
          </Field>
          <Field label="New password" hint="At least 8 characters. Not your name, email or phone, and not a common one like 12345678.">
            <input className="input" type="password" autoComplete="new-password" value={pwd} onChange={(e) => setPwd(e.target.value)} minLength={8} required />
          </Field>
          <Field label="Repeat new password">
            <input className="input" type="password" autoComplete="new-password" value={pwd2} onChange={(e) => setPwd2(e.target.value)} minLength={8} required />
          </Field>
          <Button className="block" loading={busy} type="submit">
            Change password
          </Button>
        </form>
        <button className="btn secondary block mt" onClick={logout}>
          Log out
        </button>
      </div>
    </>
  );
}

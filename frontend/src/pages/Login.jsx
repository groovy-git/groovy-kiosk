import { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useApp } from "../store";
import { api } from "../lib/api";
import { Button, Field, Sheet } from "../components/ui";
import { unlockAudio } from "../lib/feedback";

// Whether the shop offers "Forgot password?" is the owner's setting, and this screen is shown before anyone
// is logged in — so it is asked for on its own, and remembered so the screen does not jump next time.
const FORGOT_KEY = "gp_forgot";

export default function Login() {
  const { login, toast } = useApp();
  const [forgotOn, setForgotOn] = useState(() => {
    try {
      return localStorage.getItem(FORGOT_KEY) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    let live = true;
    api("loginOptions")
      .then((r) => {
        if (!live) return;
        const on = !!(r.data && r.data.forgot_password);
        setForgotOn(on);
        try {
          localStorage.setItem(FORGOT_KEY, on ? "1" : "0");
        } catch {
          /* private mode: asked again next time */
        }
      })
      .catch(() => {}); // offline, or a server from before this setting: keep what was remembered
    return () => {
      live = false;
    };
  }, []);
  const [email, setEmail] = useState(() => localStorage.getItem("gp_last_email") || "");
  const [pwd, setPwd] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [forgot, setForgot] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    unlockAudio();
    setErr("");
    setBusy(true);
    try {
      localStorage.setItem("gp_last_email", email.trim());
      await login(email.trim(), pwd);
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <img className="logo" src="./logo.svg" alt="Groovy Fragrances" />
      <div className="tagline">Smell Of Perfection</div>
      <form className="card" onSubmit={submit}>
        <h2 style={{ marginBottom: 16 }}>Staff login</h2>
        <Field label="Email">
          <input className="input" type="email" autoComplete="username" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label="Password" error={err}>
          <div className="input-wrap">
            <input className="input" type={show ? "text" : "password"} autoComplete="current-password" value={pwd} onChange={(e) => setPwd(e.target.value)} required />
            <button type="button" className="icon-btn suffix-btn" onClick={() => setShow(!show)} aria-label={show ? "Hide password" : "Show password"}>
              {show ? <EyeOff size={20} /> : <Eye size={20} />}
            </button>
          </div>
        </Field>
        <Button className="block big" loading={busy} type="submit">
          Log in
        </Button>
        {forgotOn ? (
          <button type="button" className="btn ghost block mt" onClick={() => setForgot(true)}>
            Forgot password?
          </button>
        ) : (
          <p className="small muted center mt" style={{ marginBottom: 0 }}>
            Forgot your password? Ask the owner to reset it.
          </p>
        )}
      </form>
      <ForgotSheet open={forgot} onClose={() => setForgot(false)} defaultEmail={email} toast={toast} />
    </div>
  );
}

function ForgotSheet({ open, onClose, defaultEmail, toast }) {
  const [step, setStep] = useState(1);
  const [email, setEmail] = useState(defaultEmail);
  const [otp, setOtp] = useState("");
  const [pwd, setPwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const run = async (fn) => {
    setErr("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Reset password">
      {step === 1 ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const r = await api("forgotPassword", { email: email.trim() });
              toast(r.message, "success", 4000);
              setStep(2);
            });
          }}
        >
          {/* conditional on purpose: the server never says whether an address is registered, so this
              must not promise a code that a typo will never receive */}
          <p className="muted small" style={{ marginTop: 0 }}>We'll send an 8-digit code if this email belongs to a staff account.</p>
          <Field label="Email" error={err}>
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </Field>
          <Button className="block" loading={busy} type="submit">Send code</Button>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const r = await api("resetPassword", { email: email.trim(), otp, password: pwd });
              toast(r.message, "success");
              setStep(1);
              onClose();
            });
          }}
        >
          {/* the condition stays on screen: the toast saying it is gone in four seconds, and a typo
              otherwise leaves you waiting on this step for a code that was never sent */}
          <p className="muted small" style={{ marginTop: 0 }}>
            If <b>{email.trim()}</b> is registered, the code is on its way. Nothing in a minute? The address may be wrong.
          </p>
          <Field label="8-digit code from email">
            <input className="input" inputMode="numeric" maxLength={8} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))} required />
          </Field>
          <Field label="New password" hint="At least 8 characters, and not easy to guess" error={err}>
            <input className="input" type="password" autoComplete="new-password" value={pwd} onChange={(e) => setPwd(e.target.value)} minLength={8} required />
          </Field>
          <Button className="block" loading={busy} type="submit">Change password</Button>
          <button type="button" className="btn ghost block mt" onClick={() => { setErr(""); setOtp(""); setStep(1); }}>
            Use a different email
          </button>
        </form>
      )}
    </Sheet>
  );
}

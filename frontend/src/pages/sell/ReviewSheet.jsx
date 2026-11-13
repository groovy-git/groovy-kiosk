import { useEffect, useRef, useState } from "react";
import { UserCheck } from "lucide-react";
import { useApp } from "../../store";
import { api } from "../../lib/api";
import { runBusy } from "../../lib/busy";
import { isMaskedPhone } from "../../lib/format";
import { Button, Field, Sheet, Spinner } from "../../components/ui";

/**
 * A Google review taken at the counter (backend/reviews.gs). The branch's review page as a QR code for the
 * customer to scan with their own phone; then who it was — the mobile number (each number counts once per
 * branch) and, if easy, their name on Google — whether a sample perfume went with it, and who took it.
 * `review`: {} from the Sell screen (anyone, buying or not), or {phone, name, sale_id, salesman_id} after a
 * sale — the bill's salesperson is then who took it, unless a manager or the owner picks someone else.
 */
export default function ReviewSheet({ review, onClose }) {
  const { branch, role, user, sellers, toast } = useApp();
  const [f, setF] = useState({ phone: "", google_name: "", sample: false, salesman_id: null });
  const [qr, setQr] = useState("");
  const [known, setKnown] = useState(null);
  const [busy, setBusy] = useState(false);
  const autoName = useRef(""); // a name put in from the customer lookup, not typed
  const link = (branch && branch.review_link) || "";

  useEffect(() => {
    if (review) setF({ phone: review.phone || "", google_name: review.name || "", sample: false, salesman_id: review.salesman_id || null });
  }, [review]);

  // the QR code is drawn on the phone; its library is loaded only when this sheet first opens
  useEffect(() => {
    if (!review || !link) return setQr("");
    let live = true;
    import("qrcode-generator")
      .then(({ default: qrcode }) => {
        if (!live) return;
        const q = qrcode(0, "M");
        q.addData(link);
        q.make();
        setQr(q.createDataURL(6, 2));
      })
      .catch(() => live && setQr(""));
    return () => {
      live = false;
    };
  }, [review, link]);

  // a number carried from a bill this person only sees masked stays as it is; the server takes that bill's customer
  const masked = isMaskedPhone(f.phone);
  const digits = masked ? "" : f.phone.replace(/\D/g, "");
  // a returning customer: say so, and put their name in an empty name box. A name put in for one number
  // goes again when the number changes (a corrected typo must not carry someone else's name)
  useEffect(() => {
    setKnown(null);
    const was = autoName.current;
    autoName.current = "";
    if (was) setF((x) => (x.google_name === was ? { ...x, google_name: "" } : x));
    if (digits.length !== 10) return;
    let live = true;
    api("findCustomer", { phone: digits })
      .then((r) => {
        if (!live || !r.data) return;
        setKnown(r.data);
        setF((x) => {
          if (x.google_name || !r.data.name) return x;
          autoName.current = r.data.name;
          return { ...x, google_name: r.data.name };
        });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [digits]);

  if (!review) return null;
  const takerId = f.salesman_id || user.id;
  // linked to the bill only while it is that bill's customer (a companion's number is a review of its own)
  const linked = !!review.sale_id && f.phone === (review.phone || "");
  const save = async () => {
    if (!masked && digits.length !== 10) return toast("Enter the customer's 10-digit mobile number", "error");
    setBusy(true);
    try {
      const r = await runBusy("Recording review…", () =>
        api("addReview", {
          phone: masked ? f.phone : digits,
          google_name: f.google_name.trim(),
          sample: f.sample,
          salesman_id: takerId,
          sale_id: linked ? review.sale_id : 0,
          ...(masked ? { from_sale_id: review.sale_id } : {}),
        }),
      );
      toast(r.message, "success");
      onClose();
    } catch (e) {
      toast(e.message, "error", 5000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title="Google review"
      footer={
        <Button className="block big" loading={busy} onClick={save}>
          Save review
        </Button>
      }
    >
      <div className="card center">
        {link ? (
          <>
            {qr ? <img src={qr} alt="QR code of the Google review page" width={210} height={210} style={{ imageRendering: "pixelated" }} /> : <Spinner />}
            <div className="small mt">Scan with your phone camera to write a review</div>
          </>
        ) : (
          <div className="small muted">Ask the owner to add this branch's Google review link (Settings → Branches).</div>
        )}
      </div>
      <div className="card">
        <div className="field">
          <label>Customer mobile</label>
          <div className="input-wrap">
            <span className="prefix" style={{ left: 12 }}>+91</span>
            <input
              className="input"
              style={{ paddingLeft: 46 }}
              type="tel"
              inputMode="numeric"
              maxLength={10}
              placeholder="10-digit mobile"
              value={f.phone}
              readOnly={masked}
              onChange={(e) => setF({ ...f, phone: e.target.value.replace(/\D/g, "").slice(0, 10) })}
            />
          </div>
          {masked && (
            <div className="hint row between">
              <span>The customer of this bill</span>
              <button type="button" className="btn ghost small" onClick={() => setF({ ...f, phone: "", google_name: "" })}>
                Use another number
              </button>
            </div>
          )}
          {known && (
            <div className="hint ok-text row gap-s">
              <UserCheck size={14} /> Returning customer · {known.bills} bills
            </div>
          )}
        </div>
        <Field label="Name on Google (optional)" hint="First name as shown on Google, if easy">
          <input className="input" maxLength={60} value={f.google_name} onChange={(e) => setF({ ...f, google_name: e.target.value })} autoCapitalize="words" />
        </Field>
        <label className="kv" style={{ alignItems: "center", cursor: "pointer" }}>
          <span className="row gap-s">
            <input type="checkbox" checked={f.sample} onChange={(e) => setF({ ...f, sample: e.target.checked })} style={{ width: 20, height: 20, accentColor: "var(--brown)" }} />
            <span className="k">Sample perfume given</span>
          </span>
        </label>
        {role !== "salesperson" && (
          <Field label="Taken by">
            <select className="input" value={takerId} onChange={(e) => setF({ ...f, salesman_id: Number(e.target.value) })}>
              {sellers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
    </Sheet>
  );
}

import { useEffect, useState } from "react";
import { useApp } from "../../store";
import { upiLink } from "../../lib/upi";
import { inr } from "../../lib/format";
import { Button, Sheet, Spinner } from "../../components/ui";

/**
 * A UPI QR with the amount filled in, shown on the kiosk phone for the customer to scan with their own UPI
 * app (GPay, PhonePe, Paytm…). The money goes straight to the branch's UPI ID; the app never sees it, so
 * staff check it arrived — the soundbox or the UPI business app, never only the customer's screen — and
 * then complete the bill (the reminder for that is on the checkout, not here: the customer sees this).
 * `pay`: {amount, upi_id, branch} — or null, closed. Used at checkout and for the owner's ₹1 test in
 * Settings → Branches.
 */
export default function UpiQrSheet({ pay, onClose }) {
  const { settings } = useApp();
  const [qr, setQr] = useState("");
  const biz = settings.business_name || "Groovy Fragrances";
  const link = pay && pay.upi_id ? upiLink(pay.upi_id, biz, pay.amount, `${biz} ${pay.branch || ""}`) : "";

  // drawn on the phone (works offline); the library is loaded only when this first opens, as for reviews.
  // Drawn again if the amount changes while it is open
  useEffect(() => {
    if (!link) return setQr("");
    let live = true;
    import("qrcode-generator")
      .then(({ default: qrcode }) => {
        if (!live) return;
        const q = qrcode(0, "M");
        q.addData(link);
        q.make();
        // SVG stays sharp at any size; a white margin of 4 modules, as scanners want
        setQr("data:image/svg+xml;charset=utf-8," + encodeURIComponent(q.createSvgTag({ cellSize: 4, margin: 16, scalable: true })));
      })
      .catch(() => live && setQr(""));
    return () => {
      live = false;
    };
  }, [link]);

  if (!pay) return null;
  return (
    <Sheet open onClose={onClose} title="Pay by UPI" footer={<Button className="block big" onClick={onClose}>Done</Button>}>
      <div className="center">
        <div className="money bold" style={{ fontSize: 30 }}>{inr(pay.amount)}</div>
        <div data-upi={link} style={{ background: "#fff", borderRadius: 16, padding: 8, margin: "12px auto", width: "min(78vw, 300px)" }}>
          {qr ? (
            <img src={qr} alt={`UPI QR code for ${inr(pay.amount)}`} style={{ width: "100%", height: "auto", display: "block" }} />
          ) : (
            <div style={{ aspectRatio: "1", display: "grid", placeItems: "center" }}>
              <Spinner />
            </div>
          )}
        </div>
        <div className="bold">{biz}</div>
        <div className="small muted">
          {pay.upi_id}
          {pay.branch ? " · " + pay.branch : ""}
        </div>
        {/* the customer is shown this screen: nothing here is for staff (their reminder is on the checkout) */}
        <p className="small mt">Scan with any UPI app to pay</p>
      </div>
    </Sheet>
  );
}

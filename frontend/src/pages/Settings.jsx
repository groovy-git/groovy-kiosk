import { useEffect, useState } from "react";
import { Plus, Mail, Store } from "lucide-react";
import { useApp } from "../store";
import { api } from "../lib/api";
import { runBusy } from "../lib/busy";
import TopBar from "../components/TopBar";
import { Button, Chips, Field, Seg, Sheet, SkeletonList, useConfirm } from "../components/ui";

const GST = [0, 5, 12, 18, 28];

export default function SettingsPage() {
  const { settings, setSettings, toast, catalog, refreshCatalog } = useApp();
  const [f, setF] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState("shop");
  const [cat, setCat] = useState(null);
  const [brand, setBrand] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target ? e.target.value : e });

  const save = async () => {
    setBusy(true);
    try {
      const r = await runBusy("Saving settings…", () => api("saveSettings", { settings: f }));
      setSettings(r.data);
      setF((cur) => ({ ...cur, ...r.data })); // server may normalise values (e.g. email list)
      toast(r.message, "success", 4000);
    } catch (e) {
      toast(e.message, "error", 4000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <TopBar title="Settings" back="more" />
      <div className={"page" + (tab !== "catalog" && tab !== "branches" ? " has-bar" : "")}>
        <Chips
          value={tab}
          onChange={setTab}
          options={[
            { value: "shop", label: "Shop" },
            { value: "branches", label: "Branches" },
            { value: "rules", label: "Billing" },
            { value: "email", label: "Email" },
            { value: "catalog", label: "Categories" },
          ]}
        />
        {tab === "branches" && <BranchesSettings />}
        {tab === "email" && <EmailSettings f={f} setF={setF} saved={settings} />}
        {tab === "shop" && (
          <div className="card mt">
            <Field label="Shop name"><input className="input" value={f.business_name || ""} onChange={set("business_name")} /></Field>
            <Field label="Tagline"><input className="input" value={f.tagline || ""} onChange={set("tagline")} /></Field>
            <Field label="Address"><textarea className="input" value={f.address || ""} onChange={set("address")} /></Field>
            <div className="grid-2">
              <Field label="Phone"><input className="input" value={f.phone || ""} onChange={set("phone")} /></Field>
              <Field label="Email"><input className="input" value={f.email || ""} onChange={set("email")} /></Field>
            </div>
            <Field label="GSTIN" hint="Printed on bills. Leave empty to print a plain bill.">
              <input className="input" maxLength={15} value={f.gstin || ""} onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase() })} />
            </Field>
            <div className="grid-2">
              <Field label="State"><input className="input" value={f.state_name || ""} onChange={set("state_name")} /></Field>
              <Field label="State code"><input className="input" inputMode="numeric" value={f.state_code || ""} onChange={set("state_code")} /></Field>
            </div>
            <Field label="Bill footer message"><textarea className="input" value={f.receipt_footer || ""} onChange={set("receipt_footer")} /></Field>
          </div>
        )}
        {tab === "rules" && (
          <div className="card mt">
            <Field label="Invoice prefix" hint={`Bills look like ${f.invoice_prefix || "GF"}/26-27/00001 and restart every April`}>
              <input className="input" maxLength={4} value={f.invoice_prefix || ""} onChange={(e) => setF({ ...f, invoice_prefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })} />
            </Field>
            <Field label="Max discount a salesperson can give (%)" hint="Managers and the owner have no limit">
              <input className="input" inputMode="decimal" value={f.salesman_max_disc_pct || ""} onChange={set("salesman_max_disc_pct")} />
            </Field>
            <Field label="Max refund a salesperson can accept (₹)" hint="Per bill, earlier returns on it counted. 0 = only managers can accept returns">
              <input className="input" inputMode="decimal" value={f.salesperson_max_return || ""} onChange={set("salesperson_max_return")} />
            </Field>
            <Field label="Return window (days)"><input className="input" inputMode="numeric" value={f.return_days || ""} onChange={set("return_days")} /></Field>
            <Field label="1 tola = how many ml?"><input className="input" inputMode="decimal" value={f.tola_ml || ""} onChange={set("tola_ml")} /></Field>
            <div className="field">
              <label>Round bill total to nearest rupee</label>
              <Seg value={f.round_off || "yes"} onChange={set("round_off")} options={[{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]} />
            </div>
            <div className="field">
              <label>Allow selling when stock shows 0</label>
              <Seg value={f.allow_negative_stock || "no"} onChange={set("allow_negative_stock")} options={[{ value: "no", label: "No (safer)" }, { value: "yes", label: "Yes" }]} />
              <div className="hint">Turn on only while you are still entering your opening stock.</div>
            </div>
            <div className="field">
              <label>Save invoice PDFs to Google Drive automatically</label>
              <Seg value={f.invoice_pdfs || "yes"} onChange={set("invoice_pdfs")} options={[{ value: "yes", label: "On" }, { value: "no", label: "Off" }]} />
              <div className="hint">Every night at 2 am, the day’s bills and credit notes are saved as PDFs in the “Sales_Invoices” folder next to the Sheet. Checkout is not slowed down. Any bill can also be saved by hand from Sales → bill.</div>
            </div>
            <Field label="Expense categories" hint="Comma separated"><textarea className="input" value={f.expense_categories || ""} onChange={set("expense_categories")} /></Field>
          </div>
        )}
        {tab === "catalog" && (
          <>
            <div className="section-label">Categories · default HSN & GST</div>
            <div className="list">
              {catalog.categories.map((c) => (
                <button key={c.id} className="list-item" onClick={() => setCat(c)} style={c.active ? null : { opacity: 0.5 }}>
                  <div className="grow">
                    <div className="title">{c.name}</div>
                    <div className="sub">HSN {c.default_hsn || "—"} · GST {c.default_gst}%</div>
                  </div>
                </button>
              ))}
            </div>
            <button className="btn secondary block mt" onClick={() => setCat({ name: "", default_hsn: "", default_gst: 18, active: 1 })}>
              <Plus size={18} /> Add category
            </button>
            <div className="section-label">Brands</div>
            <div className="list">
              {catalog.brands.map((b) => (
                <button key={b.id} className="list-item" onClick={() => setBrand(b)} style={{ minHeight: 50, opacity: b.active ? 1 : 0.5 }}>
                  <div className="title grow">{b.name}</div>
                </button>
              ))}
            </div>
            <button className="btn secondary block mt" onClick={() => setBrand({ name: "", active: 1 })}>
              <Plus size={18} /> Add brand
            </button>
          </>
        )}
      </div>
      {tab !== "catalog" && tab !== "branches" && (
        <div className="cartbar" style={{ background: "#fff", boxShadow: "var(--shadow-up)", padding: 8, cursor: "default" }}>
          <Button className="block big grow" loading={busy} onClick={save}>
            Save settings
          </Button>
        </div>
      )}
      {cat && <CatSheet key={cat.id || "new"} c={cat} onClose={() => setCat(null)} onSaved={refreshCatalog} />}
      {brand && <BrandSheet key={brand.id || "new"} b={brand} onClose={() => setBrand(null)} onSaved={refreshCatalog} />}
    </>
  );
}

const HOURS = [17, 18, 19, 20, 21, 22, 23];
const hourLabel = (h) => `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;

// Day-close emails: who receives them, and the nightly automatic email (on/off)
function EmailSettings({ f, setF, saved }) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const on = f.nightly_report === "yes";
  const hour = Number(f.nightly_report_hour || 22);
  const unsaved = ["report_emails", "nightly_report", "nightly_report_hour", "nightly_report_skip_empty"].some((k) => (f[k] || "") !== (saved[k] || ""));

  const test = async () => {
    setBusy(true);
    try {
      const r = await api("emailDayClose", {});
      toast(r.message, "success", 3500);
    } catch (e) {
      toast(e.message, "error", 4000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="card mt">
        <Field label="Send day-close emails to" hint="Separate with commas. Leave empty to send to every Owner account.">
          <textarea
            className="input"
            inputMode="email"
            value={f.report_emails || ""}
            onChange={(e) => setF({ ...f, report_emails: e.target.value })}
            placeholder="owner@gmail.com, accountant@gmail.com"
          />
        </Field>
        <div className="tiny muted">Emails are sent from the Google account that owns the POS Google Sheet.</div>
      </div>

      <div className="card mt">
        <div className="row between">
          <div>
            <h3>Nightly email</h3>
            <div className="small muted">Whole-shop day close sent automatically every night</div>
          </div>
        </div>
        <div className="mt">
          <Seg
            value={on ? "yes" : "no"}
            onChange={(v) => setF({ ...f, nightly_report: v })}
            options={[
              { value: "yes", label: "On" },
              { value: "no", label: "Off" },
            ]}
          />
        </div>
        {on && (
          <>
            <Field label="Send at">
              <select className="input mt" value={hour} onChange={(e) => setF({ ...f, nightly_report_hour: e.target.value })}>
                {HOURS.map((h) => (
                  <option key={h} value={h}>
                    {hourLabel(h)} – {hourLabel((h + 1) % 24)}
                  </option>
                ))}
              </select>
            </Field>
            <div className="field">
              <label>Days with no sales</label>
              <Seg
                value={f.nightly_report_skip_empty === "no" ? "no" : "yes"}
                onChange={(v) => setF({ ...f, nightly_report_skip_empty: v })}
                options={[
                  { value: "yes", label: "Don't send" },
                  { value: "no", label: "Send anyway" },
                ]}
              />
            </div>
            <div className="tiny muted">Google sends it at some point within the chosen hour.</div>
          </>
        )}
        {unsaved && <div className="small mt" style={{ color: "var(--brown)" }}>Tap “Save settings” below to apply.</div>}
      </div>

      <Button className="secondary block mt" loading={busy} disabled={unsaved} onClick={test}>
        <Mail size={18} /> Send today's day close now
      </Button>
      {unsaved && <div className="tiny muted center">Save first to test with the new addresses.</div>}
    </>
  );
}

function CatSheet({ c, onClose, onSaved }) {
  const { toast, rawCatalog } = useApp();
  const [f, setF] = useState(c);
  const [busy, setBusy] = useState(false);
  const [confirm, confirmNode] = useConfirm();
  // hidden products count too — every product needs its category
  const used = c.id ? (rawCatalog?.products || []).filter((x) => x.category_id === c.id).length : 0;
  const onlyOne = (rawCatalog?.categories || []).length <= 1;
  const remove = async () => {
    if (!(await confirm({ title: `Delete ${c.name}?`, text: "This cannot be undone.", okText: "Delete", danger: true }))) return;
    setBusy(true);
    try {
      const r = await runBusy("Deleting category…", () => api("deleteCategory", { id: c.id }));
      toast(r.message, "success");
      await onSaved();
      onClose();
    } catch (e) {
      toast(e.message, "error", 4000);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    try {
      const r = await runBusy("Saving category…", () => api("saveCategory", f));
      toast(r.message, "success");
      await onSaved();
      onClose();
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open onClose={onClose} title={c.id ? "Edit category" : "New category"} footer={<Button className="block big" loading={busy} onClick={save}>Save</Button>}>
      <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <div className="grid-2">
        <Field label="Default HSN"><input className="input" inputMode="numeric" value={f.default_hsn} onChange={(e) => setF({ ...f, default_hsn: e.target.value })} /></Field>
        <Field label="Default GST %">
          <select className="input" value={f.default_gst} onChange={(e) => setF({ ...f, default_gst: Number(e.target.value) })}>
            {GST.map((g) => <option key={g} value={g}>{g}%</option>)}
          </select>
        </Field>
      </div>
      {c.id && (
        <div className="field">
          <label>Show in app</label>
          <Seg value={f.active ? 1 : 0} onChange={(v) => setF({ ...f, active: v })} options={[{ value: 1, label: "Active" }, { value: 0, label: "Hidden" }]} />
        </div>
      )}
      <div className="tiny muted">Changing defaults affects new products only. Confirm HSN and GST rates with your accountant.</div>
      {c.id && (
        <>
          <button className="btn danger block mt" disabled={busy || used > 0 || onlyOne} onClick={remove}>
            Delete category
          </button>
          {used > 0 && (
            <div className="tiny muted mt">
              Used by {used} {used === 1 ? "product" : "products"} — hide it instead (Show in app → Hidden).
            </div>
          )}
        </>
      )}
      {confirmNode}
    </Sheet>
  );
}

function BrandSheet({ b, onClose, onSaved }) {
  const { toast } = useApp();
  const [name, setName] = useState(b.name);
  const [active, setActive] = useState(b.active);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await runBusy("Saving brand…", () => api("saveBrand", { id: b.id, name, active }));
      toast(r.message, "success");
      await onSaved();
      onClose();
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open onClose={onClose} title={b.id ? "Edit brand" : "New brand"} footer={<Button className="block big" loading={busy} onClick={save}>Save</Button>}>
      <Field label="Brand name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      {b.id && (
        <div className="field">
          <label>Show in app</label>
          <Seg value={active ? 1 : 0} onChange={setActive} options={[{ value: 1, label: "Active" }, { value: 0, label: "Hidden" }]} />
        </div>
      )}
    </Sheet>
  );
}

// Branches: shops sharing the product list; each has its own stock, bills (series) and reports
function BranchesSettings() {
  const { toast, bootstrap, settings } = useApp();
  const [list, setList] = useState(null);
  const [edit, setEdit] = useState(null);
  const load = () =>
    api("listBranches")
      .then((r) => setList(r.data))
      .catch((e) => toast(e.message, "error"));
  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const prefix = settings.invoice_prefix || "GF";
  return (
    <>
      <p className="small muted">
        Branches share one product list and prices. Stock, bills, expenses and reports are kept per branch, and staff can switch between the branches they work at.
      </p>
      {!list ? (
        <SkeletonList rows={2} />
      ) : (
        <div className="list">
          {list.map((b) => (
            <button key={b.id} className="list-item" onClick={() => setEdit(b)} style={b.active ? null : { opacity: 0.5 }}>
              <div className="avatar gold">
                <Store size={19} />
              </div>
              <div className="grow">
                <div className="title">{b.name}</div>
                <div className="sub ellipsis">
                  Bills {prefix}
                  {b.code || ""}/26-27/00001{b.address ? " · " + b.address : ""}
                </div>
              </div>
              {b.gst_off ? <span className="badge">No GST</span> : null}
              {!b.active && <span className="badge">Inactive</span>}
            </button>
          ))}
        </div>
      )}
      <button className="btn secondary block mt" onClick={() => setEdit({ name: "", code: "", address: "", phone: "", report_emails: "", active: 1, gst_off: 0 })}>
        <Plus size={18} /> Add branch
      </button>
      {edit && (
        <BranchSheet
          key={edit.id || "new"}
          b={edit}
          prefix={prefix}
          onClose={() => setEdit(null)}
          onSaved={async () => {
            setEdit(null);
            load();
            await bootstrap(); // branch list + switcher everywhere
          }}
        />
      )}
    </>
  );
}

function BranchSheet({ b, prefix, onClose, onSaved }) {
  const { toast } = useApp();
  const [f, setF] = useState(b);
  const [busy, setBusy] = useState(false);
  const code = (f.code || "").toUpperCase();
  const save = async () => {
    setBusy(true);
    try {
      const r = await runBusy("Saving branch…", () => api("saveBranch", { ...f, code }));
      toast(r.message, "success");
      await onSaved();
    } catch (e) {
      toast(e.message, "error", 4500);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open onClose={onClose} title={b.id ? "Edit branch" : "New branch"} footer={<Button className="block big" loading={busy} onClick={save}>Save</Button>}>
      <Field label="Branch name">
        <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Kalyani Nagar" autoCapitalize="words" />
      </Field>
      <Field
        label="Bill code"
        hint={`Bills: ${prefix}${code}/26-27/00001 · Returns: ${code ? prefix + code + "C" : prefix + "/CN"}/26-27/0001. Only your main shop can leave it blank. It can't change once the branch has bills.`}
      >
        <input className="input" maxLength={3} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })} placeholder="e.g. KN" />
      </Field>
      <Field label="Address (printed on this branch's bills)">
        <textarea className="input" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
      </Field>
      <Field label="Phone">
        <input className="input" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
      </Field>
      <Field label="Day-close emails for this branch" hint="e.g. the branch manager. The owner list in Settings → Email also gets every branch.">
        <input className="input" inputMode="email" value={f.report_emails} onChange={(e) => setF({ ...f, report_emails: e.target.value })} placeholder="manager@gmail.com" />
      </Field>
      <div className="field">
        <label>GST</label>
        <Seg value={f.gst_off ? 0 : 1} onChange={(v) => setF({ ...f, gst_off: v ? 0 : 1 })} options={[{ value: 1, label: "Enabled" }, { value: 0, label: "Disabled" }]} />
        <div className="hint">
          {f.gst_off
            ? "This branch bills without GST: no GST on its bills, and they are left out of GST reports. Prices stay the same."
            : "Bills show GST as usual (checkout can still leave it off a single bill)."}
        </div>
      </div>
      {b.id && (
        <div className="field">
          <label>Status</label>
          <Seg value={f.active ? 1 : 0} onChange={(v) => setF({ ...f, active: v })} options={[{ value: 1, label: "Active" }, { value: 0, label: "Closed" }]} />
        </div>
      )}
    </Sheet>
  );
}

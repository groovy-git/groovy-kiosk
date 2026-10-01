/** Self-tests for the pure pricing logic. Run "Run self-tests" from the Groovy Kiosk menu. */

function runTests() {
    const results = [];
    const eq = (name, got, want) => {
        const ok = JSON.stringify(got) === JSON.stringify(want);
        results.push((ok ? "PASS " : "FAIL ") + name + (ok ? "" : " — got " + JSON.stringify(got) + ", want " + JSON.stringify(want)));
    };
    const throws = (name, fn) => {
        try {
            fn();
            results.push("FAIL " + name + " — expected an error");
        } catch (e) {
            results.push("PASS " + name);
        }
    };

    // GST inclusive split: ₹1,950 @18%
    let b = computeBill_([{ price: 1950, qty: 1, discount: 0, gst_rate: 18 }], 0, true);
    eq("gst taxable", b.taxable, 1652.54);
    eq("gst cgst", b.cgst, 148.73);
    eq("gst sgst", b.sgst, 148.73);
    eq("gst grand", b.grand_total, 1950);

    // mixed rates + bill discount spread by value + round off
    b = computeBill_(
        [
            { price: 699, qty: 2, discount: 0, gst_rate: 18 },
            { price: 99, qty: 1, discount: 0, gst_rate: 5 },
        ],
        100,
        true,
    );
    eq("bill gross", b.gross, 1497);
    eq("bill disc shares add up", r2_(b.lines[0].bill_disc_share + b.lines[1].bill_disc_share), 100);
    eq("bill net", b.net, 1397);
    eq("bill grand", b.grand_total, 1397);
    eq("lines tax adds up", r2_(b.lines[0].tax + b.lines[1].tax), r2_(b.cgst + b.sgst));

    // loose attar: 6 ml @ ₹25/ml, 12 ml tola
    b = computeBill_([{ price: 25, qty: 6, discount: 3.5, gst_rate: 18 }], 0, true);
    eq("loose net before round", b.net, 146.5);
    eq("loose rounds to rupee", b.grand_total, 147);
    eq("loose round off", b.round_off, 0.5);
    eq("tola to ml", tolaToMl_(0.5, 12), 6);

    throws("discount above price rejected", () => computeBill_([{ price: 100, qty: 1, discount: 150, gst_rate: 18 }], 0, true));
    throws("bill discount above total rejected", () => computeBill_([{ price: 100, qty: 1, discount: 0, gst_rate: 18 }], 101, true));

    // repeat scans merge into one line
    const m = mergeLines_([
        { variant_id: 7, qty: 1 },
        { variant_id: 3, qty: 1 },
        { variant_id: 7, qty: 1 },
        { variant_id: 7, qty: 1, discount: 10 },
    ]);
    eq("merge lines count", m.length, 2);
    eq("merge qty", m[0].qty, 3);
    eq("merge discount", m[0].discount, 10);

    // financial year + numbering
    eq("fy april", fyOf_("2026-04-01 00:10:00"), "26-27");
    eq("fy march", fyOf_("2027-03-31 23:59:59"), "26-27");
    eq("invoice no", invoiceNo_("GF", "26-27", 1), "GF/26-27/00001");
    eq("invoice no max 16 chars", invoiceNo_("GF", "26-27", 99999).length <= 16, true);
    eq("credit note no", creditNoteNo_("GF", "26-27", 12), "GF/CN/26-27/0012");
    eq("branch invoice no", invoiceNo_("GF", "26-27", 1, "KN"), "GFKN/26-27/00001");
    eq("branch credit note no", creditNoteNo_("GF", "26-27", 1, "KN"), "GFKNC/26-27/0001");
    eq("prefix+code of 4 chars fits 16", invoiceNo_("GF", "26-27", 99999, "KN").length <= 16 && creditNoteNo_("GF", "26-27", 9999, "KN").length <= 16, true);

    // phone normalisation
    eq("phone +91", normPhone_("+91 98765 43210"), "9876543210");
    eq("phone valid", validPhone_("9876543210"), true);
    eq("phone invalid", validPhone_("12345"), false);

    // IST day boundary
    eq("IST date", fmtDate_(new Date("2026-09-17T19:00:00Z")), "2026-09-18"); // 00:30 IST next day

    const failed = results.filter((r) => r.indexOf("FAIL") === 0).length;
    const msg = (failed ? failed + " FAILED" : "All " + results.length + " tests passed") + "\n\n" + results.join("\n");
    console.log(msg);
    alert_(msg);
    return msg;
}

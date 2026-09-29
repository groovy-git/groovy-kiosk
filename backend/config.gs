/**
 * Groovy Fragrances POS — schema & constants.
 * Every sheet is a table: row 1 = headers, one record per row.
 * Column types: n = number, s = text (stored as plain text so barcodes/phones keep leading zeros),
 *               d = IST datetime text "yyyy-MM-dd HH:mm:ss", j = JSON text.
 */

const APP = {
    NAME: "Groovy Fragrances POS",
    TZ: "Asia/Kolkata",
    SESSION_DAYS: 30,
    IMAGE_FOLDER: "GroovyPOS_Images",
};

const ROLES = ["owner", "manager", "salesperson"];

const SCHEMA = {
    Users: {
        id: "n", name: "s", email: "s", phone: "s", role: "s", pwd_hash: "s", salt: "s",
        active: "n", otp: "s", otp_exp: "s", created_at: "d", updated_at: "d",
        // home branch (0 for the owner) + comma list of branches they may work at ("" = all)
        branch_id: "n", branch_ids: "s",
    },
    Sessions: { token: "s", user_id: "n", created_at: "d", expires_at: "d", device: "s" },
    Settings: { key: "s", value: "s", updated_by: "n", updated_at: "d" },
    Brands: { id: "n", name: "s", active: "n", created_at: "d" },
    Categories: {
        id: "n", name: "s", default_hsn: "s", default_gst: "n", sort: "n", active: "n", created_at: "d",
    },
    Products: {
        id: "n", name: "s", brand_id: "n", category_id: "n", gender: "s", sale_type: "s",
        hsn: "s", gst_rate: "n", image: "s", description: "s", active: "n",
        created_by: "n", created_at: "d", updated_at: "d",
    },
    Variants: {
        id: "n", product_id: "n", sku: "s", barcode: "s", size_label: "s", size_ml: "n", unit: "s",
        // stock_qty = total across all branches (per-branch counts live in Branch_Stock)
        mrp: "n", sell_price: "n", avg_cost: "n", stock_qty: "n", reorder_level: "n", active: "n",
        created_at: "d", updated_at: "d",
    },
    Stock_Movements: {
        id: "n", variant_id: "n", type: "s", qty: "n", unit_cost: "n", balance: "n",
        ref_type: "s", ref_id: "s", note: "s", user_id: "n", at: "d",
        branch_id: "n", // balance = stock at this branch after the movement
    },
    Stock_In_Batches: {
        id: "n", supplier_note: "s", bill_ref: "s", lines: "n", total_qty: "n", total_cost: "n",
        user_id: "n", at: "d", branch_id: "n",
    },
    Customers: {
        id: "n", name: "s", phone: "s", gstin: "s", total_spent: "n", bills: "n",
        last_visit: "d", created_at: "d",
    },
    Sales: {
        id: "n", client_ref: "s", invoice_no: "s", fy: "s", date: "d",
        customer_id: "n", customer_name: "s", customer_phone: "s", customer_gstin: "s",
        salesman_id: "n", salesman_name: "s", created_by: "n",
        items: "n", gross: "n", item_disc: "n", bill_disc: "n", taxable: "n", cgst: "n", sgst: "n",
        round_off: "n", grand_total: "n", tendered: "n", change: "n", refunded: "n",
        status: "s", notes: "s", updated_at: "d",
        // 1 = GST breakup not printed on the customer's bill (tax still recorded & reported)
        gst_hidden: "n",
        branch_id: "n",
        pdf_url: "s", // invoice PDF in Drive (…#void once renamed -VOID)
    },
    Sale_Items: {
        id: "n", sale_id: "n", variant_id: "n", product_name: "s", brand: "s", size: "s",
        barcode: "s", hsn: "s", qty: "n", unit: "s", mrp: "n", price: "n", discount: "n",
        bill_disc_share: "n", line_total: "n", gst_rate: "n", taxable: "n", tax: "n",
        unit_cost: "n", returned_qty: "n",
    },
    Payments: {
        id: "n", sale_id: "n", return_id: "n", method: "s", amount: "n", reference: "s",
        user_id: "n", at: "d",
    },
    Returns: {
        id: "n", credit_note_no: "s", fy: "s", sale_id: "n", invoice_no: "s", salesman_id: "n",
        total: "n", taxable: "n", tax: "n", refund_method: "s", reason: "s", user_id: "n", at: "d",
        branch_id: "n",
        pdf_url: "s", // credit note PDF in Drive
        gst_off: "n", // 1 = against a bill made at a branch without GST: left out of GST reports
    },
    Return_Items: {
        id: "n", return_id: "n", sale_item_id: "n", variant_id: "n", qty: "n", amount: "n",
        taxable: "n", tax: "n", unit_cost: "n", restock: "n",
    },
    Held_Bills: { id: "n", label: "s", cart_json: "j", salesman_id: "n", user_id: "n", at: "d", branch_id: "n" },
    Expenses: {
        id: "n", date: "s", category: "s", title: "s", amount: "n", method: "s", notes: "s",
        user_id: "n", created_at: "d", branch_id: "n",
    },
    Activity_Logs: {
        id: "n", user_id: "n", user_name: "s", action: "s", entity: "s", ref_id: "s",
        details: "s", at: "d",
    },
    // shops; code goes into invoice numbers (blank = original shop keeps GF/26-27/00001 series)
    Branches: {
        id: "n", name: "s", code: "s", address: "s", phone: "s", report_emails: "s", active: "n", created_at: "d",
        gst_off: "n", // 1 = branch not GST-registered: its bills carry no GST. Blank/0 = GST on (every older branch)
    },
    Branch_Stock: { variant_id: "n", branch_id: "n", qty: "n" },
    Transfers: {
        id: "n", transfer_no: "s", from_branch_id: "n", to_branch_id: "n", lines: "n", total_qty: "n",
        note: "s", user_id: "n", at: "d",
    },
};

const DEFAULT_SETTINGS = {
    business_name: "Groovy Fragrances",
    tagline: "Smell Of Perfection",
    address: "Shop No. 6, A1 Wing, Manish Park Phase 2, Kausar Baugh, Kondhwa, Pune, Maharashtra 411048",
    phone: "+91 73858 69798",
    email: "support@groovyfragrances.in",
    gstin: "",
    state_name: "Maharashtra",
    state_code: "27",
    invoice_prefix: "GF",
    tola_ml: "12",
    salesman_max_disc_pct: "10",
    return_days: "3",
    // most a salesperson may refund on one bill, earlier returns on it counted; 0 = managers only
    salesperson_max_return: "2000",
    round_off: "yes",
    allow_negative_stock: "no",
    receipt_footer: "Thank you for shopping with Groovy Fragrances! Returns accepted within 3 days for damaged/incorrect items with bill.",
    expense_categories: "Rent,Salary,Electricity,Tea & Snacks,Transport,Packaging,Marketing,Maintenance,Other",
    // day-close emails: empty list = every Owner account; nightly email is off until switched on in Settings
    report_emails: "",
    nightly_report: "no",
    nightly_report_hour: "22",
    nightly_report_skip_empty: "yes",
    // invoice & credit-note PDFs saved to Drive every 15 min (Sales_Invoices next to the Sheet)
    invoice_pdfs: "yes",
    internal_barcode_seq: "0",
    catalog_version: "1",
    stock_version: "1",
};

// category defaults (HSN / GST %) — owner should confirm with their CA
const DEFAULT_CATEGORIES = [
    ["Eau De Parfum", "3303", 18],
    ["Eau De Toilette", "3303", 18],
    ["Body Mist", "3303", 18],
    ["Perfume Spray (Alcohol Free)", "3303", 18],
    ["Pocket Perfume", "3303", 18],
    ["Perfume Decants", "3303", 18],
    ["Deodorant Spray", "3307", 18],
    ["Deodorant Roll On", "3307", 18],
    ["Packed Attar", "3303", 18],
    ["Loose Attar", "3303", 18],
    ["Perfume Body Cream", "3304", 18],
    ["Air Freshener", "3307", 18],
    ["Car Air Freshener", "3307", 18],
    ["Incense Sticks", "33074100", 5],
    ["Dhoop Sticks", "33074100", 5],
    ["Aroma Oil & Humidifier", "3307", 18],
    ["Bakhoor & Incense Burner", "3307", 18],
    ["Fancy Bottles", "7013", 18],
    ["Accessories", "", 18],
];

const PAYMENT_METHODS = ["cash", "upi", "card"];
// How an exchange settles: the credit note pays for the replacement bill. Deliberately NOT in
// PAYMENT_METHODS, which is the list a person may choose from — that is what stops a bill being
// "paid" with this out of thin air. Reports pick it up on their own, keyed by whatever they meet.
const EXCHANGE_METHOD_ = "exchange";

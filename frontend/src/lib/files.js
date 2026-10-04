// Photo compression (phone camera photos are huge) + CSV helpers.

export function compressImage(file, maxSize = 800, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      const dataUrl = c.toDataURL("image/jpeg", quality);
      resolve({ data: dataUrl.split(",")[1], mime: "image/jpeg", preview: dataUrl });
    };
    img.onerror = () => reject(new Error("Could not read this image"));
    img.src = url;
  });
}

// RFC-4180-ish CSV parser (quotes, commas, newlines in quotes)
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const clean = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (!clean.length) return [];
  const head = clean[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  return clean.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, plainText((r[i] || "").trim())])));
}

/**
 * Long codes and Excel.
 *
 * Excel reads a barcode like 6291108735411 as a number, shows it as 6.29E+12 and saves it that way;
 * a leading zero it simply drops. Written as ="6291108735411" the cell is text to Excel and to Google
 * Sheets, and both save the digits back unharmed. An export nobody opened still holds the ="…" form,
 * so reading a file takes it off again (a bare =digits is the same cell seen without its quotes).
 */
export const excelText = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /^\d+$/.test(s) && (s.length >= 12 || (s.length > 1 && s[0] === "0")) ? `="${s}"` : s;
};
const plainText = (s) => {
  const m = /^="(.*)"$/.exec(s) || /^=(\d+)$/.exec(s);
  return m ? m[1] : s;
};

export function toCSV(rows, cols) {
  const escCell = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map((c) => escCell(c.label)).join(","), ...rows.map((r) => cols.map((c) => escCell(typeof c.get === "function" ? c.get(r) : r[c.key])).join(","))].join("\n");
}

export function downloadText(filename, text, mime = "text/csv") {
  const blob = new Blob(["﻿" + text], { type: mime + ";charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

export const IMPORT_TEMPLATE = [
  "brand,product,category,gender,sale_type,size_label,size_ml,sku,barcode,mrp,sell_price,cost,opening_stock,reorder_level,hsn,gst_rate",
  "Lattafa,Asad Eau De Parfum,Eau De Parfum,men,packed,100ml,100,GF-ASAD-100,6291108735411,3500,1950,1450,6,2,3303,18",
  "Lattafa,Asad Eau De Parfum,Eau De Parfum,men,packed,30ml,30,GF-ASAD-30,,1200,899,600,4,2,3303,18",
  "Groovy,White Musk Attar,Loose Attar,unisex,loose,Loose (per ml),,,,30,25,12,500,100,3303,18",
].join("\n");

/* ---------- our own product export: every size, in the columns the import reads ---------- */

/**
 * The whole product list as a CSV that Import takes back: export, change prices or details in a
 * spreadsheet, save as CSV, import. Uploaded untouched it changes nothing — every row carries its own
 * barcode, SKU, brand, product and size, which is how Import finds the size it belongs to.
 *
 * `opening_stock` is left empty on purpose: Import only uses it for new sizes, and stock is never
 * changed by a file. The `info_…` columns at the end are for reading (stock per branch, hidden or not);
 * they are taken off again before a file is sent.
 */
export function catalogToImportCSV(catalog, branches = []) {
  const typeOf = (it) => {
    const t = (catalog.productById.get(it.product_id) || {}).sale_type;
    return t === "loose" || t === "packed" ? t : ""; // anything else: left for Import to keep as it is
  };
  const cols = [
    { label: "brand", key: "brand" },
    { label: "product", key: "name" },
    { label: "category", key: "category" },
    { label: "gender", get: (it) => it.gender || "" },
    { label: "sale_type", get: typeOf },
    { label: "size_label", key: "size" },
    { label: "size_ml", get: (it) => it.size_ml || "" },
    { label: "sku", get: (it) => excelText(it.sku) },
    { label: "barcode", get: (it) => excelText(it.barcode) },
    { label: "mrp", key: "mrp" },
    { label: "sell_price", key: "price" },
    { label: "cost", get: (it) => (it.cost > 0 ? it.cost : "") },
    { label: "opening_stock", get: () => "" },
    { label: "reorder_level", key: "reorder" },
    { label: "hsn", get: (it) => excelText(it.hsn) },
    { label: "gst_rate", key: "gst" },
    { label: "image", get: (it) => it.image || "" },
    { label: "info_hidden", get: (it) => (it.active ? "" : "yes") },
    ...(branches.length
      ? branches.map((b) => ({ label: "info_stock_" + b.name, get: (it) => it.stockBy[b.id] || 0 }))
      : [{ label: "info_stock", get: (it) => it.stock || 0 }]),
  ];
  return toCSV(catalog.items, cols);
}

// the reading-only columns of our export never go to the server
const INFO_COLUMN = /^info_/;
export function withoutInfoColumns(rows) {
  if (!rows.length || !Object.keys(rows[0]).some((k) => INFO_COLUMN.test(k))) return rows;
  return rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !INFO_COLUMN.test(k))));
}

/**
 * The server takes 2,000 rows in one go. A file up to that size is sent exactly as it always was;
 * a bigger one (the whole product list) goes in parts, each row carrying its line in the file so a
 * problem is still reported against the right row.
 */
export const IMPORT_MAX_ROWS = 2000;
export const IMPORT_PART_ROWS = 1000;
export function importParts(rows) {
  if (rows.length <= IMPORT_MAX_ROWS) return [rows];
  const lined = rows.map((r, i) => (r._row ? r : { ...r, _row: i + 2 }));
  const parts = [];
  for (let i = 0; i < lined.length; i += IMPORT_PART_ROWS) parts.push(lined.slice(i, i + IMPORT_PART_ROWS));
  return parts;
}

/**
 * What a file would do, worked out before anything is saved: which rows belong to a size the shop
 * already has, and which would be added as new. A name, brand or size changed in a file is not a
 * rename — with no barcode or SKU to go by, that row is a new product — and this is where it shows.
 *
 * Sizes are looked for in the server's order (barcode, SKU, brand + product + size), against the
 * product list on this phone. It is a guide: the server decides, and reports what it did.
 */
const EXCEL_DAMAGED = /^\d(\.\d+)?e\+?\d+$/i; // 6.29111E+12: a long code Excel turned into a number
export function checkImport(rows, catalog) {
  const codeOf = (b) => String(b || "").replace(/\s+/g, "");
  const sizeKey = (s) => String(s || "").toLowerCase().replace(/\s+/g, "");
  const prodKey = (brand, name) => String(brand || "").trim().toLowerCase() + "|" + String(name || "").trim().toLowerCase();
  const bySku = new Map();
  const byProd = new Map();
  for (const it of catalog.items) {
    if (it.sku) bySku.set(String(it.sku).toUpperCase(), it);
    const k = prodKey(it.brand, it.name);
    if (!byProd.has(k)) byProd.set(k, []);
    byProd.get(k).push(it);
  }
  const haveCat = new Set(catalog.categories.map((c) => String(c.name).toLowerCase()));
  const newCat = new Map();
  const out = { matched: 0, fresh: [], newCategories: [], damaged: [] };
  rows.forEach((r, i) => {
    const row = Number(r._row) || i + 2;
    const label = [r.brand, r.product, r.size_label].filter(Boolean).join(" ");
    const code = codeOf(r.barcode);
    const sku = String(r.sku || "").trim().toUpperCase();
    if (EXCEL_DAMAGED.test(code) || EXCEL_DAMAGED.test(sku)) {
      out.damaged.push({ row, label });
      return;
    }
    const key = prodKey(r.brand, r.product);
    let m = (code && catalog.byBarcode.get(code)) || (sku && bySku.get(sku)) || null;
    if (!m) {
      // the website's Product Id, used as the barcode by an earlier upload
      const v = catalog.byBarcode.get(codeOf(r.barcode_fallback));
      if (v && (prodKey(v.brand, v.name) === key || (sku && String(v.sku || "").toUpperCase() === sku))) m = v;
    }
    if (!m) {
      const sizes = byProd.get(key) || [];
      const loose = sizes.length && (catalog.productById.get(sizes[0].product_id) || {}).sale_type === "loose";
      m = loose ? sizes[0] : sizes.find((v) => sizeKey(v.size) === sizeKey(r.size_label)) || null;
    }
    if (m) out.matched++;
    else out.fresh.push({ row, label });
    // a category the shop doesn't have is created: on any row of our own files, on new products of the website's
    const cat = String(r.category || (m ? "" : r.new_category) || "").trim();
    if (cat && !haveCat.has(cat.toLowerCase())) newCat.set(cat.toLowerCase(), cat);
  });
  out.newCategories = [...newCat.values()];
  return out;
}

/* ---------- product export from the website (Clevup): 58 columns, one row per size ---------- */

// parseCSV turns its headers into name, sale_price, sku, image1, category_1 …
export const isWebsiteExport = (rows) => rows.length > 0 && "name" in rows[0] && "sale_price" in rows[0] && "sku" in rows[0] && !("product" in rows[0]);

const GENDER = { female: "women", women: "women", woman: "women", male: "men", men: "men", man: "men", unisex: "unisex" };

/**
 * Maps website rows onto our import fields. Only what the shop uses is taken (price, MRP, size, barcode, SKU,
 * GST, brand, gender, HSN, first image, quantity); descriptions, SEO and the rest are left out.
 * The category is guessed (attar → Packed Attar, otherwise Eau De Parfum) and used only for NEW products.
 * Only rows marked On_Kiosk = yes are for the shop; the rest are left out quietly (counted in notKiosk).
 * A file without that column imports nothing, so products not meant for the kiosk can't slip in.
 */
export function fromWebsiteExport(rows) {
  if (!rows.length || !("on_kiosk" in rows[0])) return { rows: [], skipped: [], notKiosk: 0, noKioskColumn: true };
  const out = [];
  const skipped = [];
  let notKiosk = 0;
  rows.forEach((r, i) => {
    if (String(r.on_kiosk || "").trim().toLowerCase() !== "yes") {
      notKiosk++;
      return;
    }
    if (String(r.sale_price_tax_included).toLowerCase() === "false") {
      skipped.push({ row: i + 2, message: `${r.name || "Row"} ${r.size || ""}: sale price without tax isn't supported — fix it on the website or add it by hand` });
      return;
    }
    const size = String(r.size || "").trim();
    const ml = /^(\d+(?:\.\d+)?)\s*ml$/i.exec(size);
    const num = (v) => (v === undefined || v === "" || Number(v) === 0 ? "" : String(Number(v)));
    const tags = [r.name, ...[1, 2, 3, 4, 5].flatMap((n) => [r["category_" + n], r["sub_category_" + n]])].join(" ");
    out.push({
      _row: i + 2, // line in the file, so problems point to the right row
      product: r.name,
      brand: r.brand,
      sku: r.sku,
      barcode: r.barcode,
      barcode_fallback: r.product_id, // a row with no barcode becomes scannable by its website Product Id
      reorder_level: num(r.min_quantity), // num() reads 0 and "0.0" as "not given"
      reorder_fallback: 2, // the website exports no minimum, so a size would never warn when it runs low
      size_label: ml ? ml[1] + "ml" : size,
      size_ml: ml ? ml[1] : "",
      sell_price: r.sale_price,
      mrp: num(r.mrp),
      cost: num(r.purchase_price),
      gst_rate: (/(\d+(?:\.\d+)?)\s*%/.exec(r.tax || "") || [])[1] || "",
      hsn: r.hsn,
      gender: GENDER[String(r.gender || "").trim().toLowerCase()] || "",
      image: r.image1,
      opening_stock: num(r.quantity), // used only when the import creates the size
      sale_type: String(r.measuring_unit || "").trim().toLowerCase() === "ml" ? "loose" : "",
      new_category: /attar/i.test(tags) ? "Packed Attar" : "Eau De Parfum",
    });
  });
  return { rows: out, skipped, notKiosk };
}

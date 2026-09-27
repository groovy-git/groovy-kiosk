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
  return clean.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || "").trim()])));
}

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

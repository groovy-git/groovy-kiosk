// Joins the flat catalog tables into sellable items + fast lookup maps.

import { r3 } from "./format.js"; // with .js: backend/dev/roundtrip.js loads this file in Node

/* Low stock and "Fill up to" — the same rules as isLow_ / fillQty_ in backend/reports.gs. */

// out, or at or below its low stock alert; `stock` defaults to this branch's
export const isLow = (item, stock = item.stock) => stock <= 0 || (item.reorder > 0 && stock <= item.reorder);

// how many to put back to reach "Fill up to": only for a low item with one set, else 0.
// Stock below zero is an empty shelf, not a deeper hole to fill.
export const fillQty = (item, stock = item.stock) => (item.max > 0 && isLow(item, stock) ? r3(Math.max(0, item.max - Math.max(0, stock))) : 0);

/* "Sold at" — the same rule as soldAt_ in backend/branches.gs. */

// the branch ids a size is limited to, from "1,2" as stored; [] = every branch (blank, the usual)
export const soldList = (s) => String(s || "").split(",").map(Number).filter(Boolean);

// Does this branch sell the size? Blank = every branch; "All branches" (0) is every shop; with one branch
// open the shop is one shop and sells everything. `open`: how many branches are open.
export const soldAt = (item, branchId, open) => !item.soldAt.length || !Number(branchId) || item.soldAt.includes(Number(branchId)) || open <= 1;

// what the app says about a size a branch doesn't sell — the server's words. `fix`: say how to change it
// (for bringing stock in; at the counter there is nothing for the salesperson to tick)
export const notSoldText = (item, branchName, fix = true) =>
  `${item.name} ${item.size} is not sold at ${branchName}` + (fix ? `. Tick ${branchName} for it in the product first.` : "");

export function imageUrl(img, w = 400) {
  if (!img) return "";
  if (img.startsWith("drive:")) return `https://lh3.googleusercontent.com/d/${img.slice(6)}=w${w}`;
  return img;
}

// `open`: how many branches are open (for "Sold at"; with none known yet, everything shows as before)
export function buildCatalog(cat, open = 0) {
  const empty = { items: [], byVariant: new Map(), byBarcode: new Map(), products: [], productById: new Map(), brands: [], categories: [], brandById: new Map(), catById: new Map() };
  if (!cat) return empty;
  // the branch whose stock this copy holds (0 = "All branches"): "here" for every item below
  const here = Number(cat._branch ?? cat.branch_id) || 0;
  const brandById = new Map(cat.brands.map((b) => [b.id, b]));
  const catById = new Map(cat.categories.map((c) => [c.id, c]));
  const productById = new Map(cat.products.map((p) => [p.id, p]));
  const items = [];
  const byVariant = new Map();
  const byBarcode = new Map();
  for (const v of cat.variants) {
    const p = productById.get(v.product_id);
    if (!p) continue;
    const brand = brandById.get(p.brand_id);
    const category = catById.get(p.category_id);
    const it = {
      id: v.id,
      product_id: p.id,
      name: p.name,
      brand: brand ? brand.name : "",
      brand_id: p.brand_id,
      category: category ? category.name : "",
      category_id: p.category_id,
      gender: p.gender,
      size: v.size_label,
      size_ml: v.size_ml,
      unit: v.unit,
      loose: p.sale_type === "loose" || v.unit === "ml",
      price: v.sell_price,
      mrp: v.mrp,
      cost: v.avg_cost,
      stock: v.stock_qty, // at the branch this phone is working at
      stockBy: v.stock_by_branch || {}, // {branch_id: qty} for every branch
      reorder: v.reorder_level,
      max: v.max_level || 0, // "Fill up to"; 0 = not set (also on a catalogue saved before it existed)
      barcode: v.barcode,
      sku: v.sku,
      gst: p.gst_rate,
      hsn: p.hsn,
      image: p.image,
      active: !!(v.active && p.active),
      search: `${p.name} ${brand ? brand.name : ""} ${v.size_label} ${v.barcode} ${v.sku} ${category ? category.name : ""}`.toLowerCase(),
      soldAt: soldList(v.sold_at), // "Sold at": [] = every branch
    };
    // sold at this branch — or not, but some are left on its shelf: shown until they are gone
    it.here = soldAt(it, here, open);
    it.shown = it.here || it.stock > 0;
    items.push(it);
    byVariant.set(v.id, it);
    if (v.barcode) byBarcode.set(v.barcode, it);
  }
  items.sort((a, b) => a.name.localeCompare(b.name) || a.size_ml - b.size_ml);
  return {
    items,
    byVariant,
    byBarcode,
    products: cat.products,
    productById,
    brands: [...cat.brands].sort((a, b) => a.name.localeCompare(b.name)),
    categories: [...cat.categories].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name)),
    brandById,
    catById,
  };
}

export function searchItems(items, q) {
  const words = q.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  return items.filter((it) => words.every((w) => it.search.includes(w)));
}

// barcode handed to Stock In, which adds 1 of it when it opens (from Add product or a just-created product)
export const STOCKIN_PENDING = "gp_stockin_pending";

export function lookupBarcode(cat, code) {
  const c = String(code || "").replace(/\s+/g, "");
  return cat.byBarcode.get(c) || null;
}

/** Catalog: brands, categories, products, size variants, barcodes, CSV import, images. */

const GST_RATES = [0, 5, 12, 18, 28];

function isStaffManager_(ctx) {
    return ctx.user.role === "owner" || ctx.user.role === "manager";
}

/**
 * The whole catalogue, or nothing when the app already has it.
 * `catalog_version` + `catalog_branch` say what the app holds. The version changes on every product
 * edit AND every stock movement, so matching both means the app's copy is still right — and we skip
 * reading Products, Variants and Branch_Stock entirely. Both are checked: stock is per branch, and a
 * phone that switched branch must not keep the other branch's figures. An app that sends neither
 * (an older version) gets the full payload, as before.
 */
function apiGetCatalog_(p, ctx) {
    const version = num_(setting_("catalog_version"), 1);
    if (p && num_(p.catalog_version) === version && num_(p.catalog_branch) === num_(ctx.branch_id)) {
        return { data: { version: version, branch_id: num_(ctx.branch_id), unchanged: true } };
    }
    const showCost = isStaffManager_(ctx);
    const stock = stockMap_(ctx.branch_id); // 0 = all branches → totals
    const byBranch = stockByBranch_();
    const core = catalogCore_(version);
    return {
        data: {
            version: version,
            branch_id: num_(ctx.branch_id),
            // where stock updates start from: this payload already holds current stock
            stock_version: num_(setting_("stock_version"), 1),
            at: nowStr_(),
            brands: core.brands,
            categories: core.categories,
            products: core.products,
            variants: core.variants.map((v) => {
                const o = {
                    id: v.id, product_id: v.product_id, sku: v.sku, barcode: v.barcode,
                    size_label: v.size_label, size_ml: v.size_ml, unit: v.unit, mrp: v.mrp,
                    sell_price: v.sell_price, stock_qty: stock[v.id] || 0, stock_by_branch: byBranch[v.id] || {}, reorder_level: v.reorder_level,
                    active: v.active,
                };
                if (showCost) o.avg_cost = v.avg_cost;
                return o;
            }),
        },
    };
}

/**
 * The part of the catalogue that is the same for everyone — everything except stock, which depends on
 * the branch, and cost, which depends on the role.
 *
 * Reading four sheets and rebuilding this for every device that asks was the slowest thing the server
 * did. It only changes when the catalogue version changes, so it is kept under that version number and
 * rebuilt when the number moves. The cache holds 100 KB per key, hence the chunks; if anything about
 * the stored copy looks wrong, it is simply rebuilt.
 */
function catalogCore_(version) {
    const key = "cat_" + version;
    const cache = CacheService.getScriptCache();
    const saved = readChunked_(cache, key);
    if (saved) {
        try {
            return JSON.parse(saved);
        } catch (e) {
            /* unreadable — fall through and rebuild */
        }
    }
    const core = {
        brands: rows_("Brands").map((b) => ({ id: b.id, name: b.name, active: b.active })),
        categories: rows_("Categories").map((c) => ({
            id: c.id, name: c.name, default_hsn: c.default_hsn, default_gst: c.default_gst,
            sort: c.sort, active: c.active,
        })),
        products: rows_("Products").map((x) => ({
            id: x.id, name: x.name, brand_id: x.brand_id, category_id: x.category_id,
            gender: x.gender, sale_type: x.sale_type, hsn: x.hsn, gst_rate: x.gst_rate,
            image: x.image, description: x.description, active: x.active,
        })),
        variants: rows_("Variants").map((v) => ({
            id: v.id, product_id: v.product_id, sku: v.sku, barcode: v.barcode,
            size_label: v.size_label, size_ml: v.size_ml, unit: v.unit, mrp: v.mrp,
            sell_price: v.sell_price, reorder_level: v.reorder_level, active: v.active, avg_cost: v.avg_cost,
        })),
    };
    try {
        writeChunked_(cache, key, JSON.stringify(core), 21600);
    } catch (e) {
        console.error("catalogCore_ cache", e);
    }
    return core;
}

const CACHE_CHUNK_ = 90000; // the per-key limit is 100 KB
const CACHE_MAX_CHUNKS_ = 40;

function writeChunked_(cache, key, text, ttl) {
    const n = Math.ceil(text.length / CACHE_CHUNK_);
    if (n > CACHE_MAX_CHUNKS_) return false; // too big to be worth holding
    const parts = {};
    for (let i = 0; i < n; i++) parts[key + "_" + i] = text.substring(i * CACHE_CHUNK_, (i + 1) * CACHE_CHUNK_);
    cache.putAll(parts, ttl);
    cache.put(key, String(n), ttl); // written last: the count only counts once every piece is there
    return true;
}

function readChunked_(cache, key) {
    const n = Number(cache.get(key) || 0);
    if (!n) return null;
    const names = [];
    for (let i = 0; i < n; i++) names.push(key + "_" + i);
    const parts = cache.getAll(names);
    let text = "";
    for (let i = 0; i < n; i++) {
        const piece = parts[names[i]];
        if (piece === null || piece === undefined) return null; // a piece expired — rebuild
        text += piece;
    }
    return text;
}

/* ---------- brands & categories ---------- */

function ensureBrand_(name) {
    const n = str_(name);
    if (!n) return 0;
    const ex = rows_("Brands").find((b) => b.name.toLowerCase() === n.toLowerCase());
    if (ex) return ex.id;
    const id = nextId_("Brands");
    appendRows_("Brands", [{ id, name: n, active: 1, created_at: nowStr_() }]);
    return id;
}

function apiSaveBrand_(p, ctx) {
    const name = str_(p.name);
    if (!name) fail_("Brand name is required");
    return withLock_(() => {
        const dup = rows_("Brands").find((b) => b.name.toLowerCase() === name.toLowerCase());
        if (p.id) {
            const b = findBy_("Brands", "id", Number(p.id));
            if (!b) fail_("Brand not found");
            if (dup && dup.id !== b.id) fail_("Brand already exists");
            b.name = name;
            if (p.active !== undefined) b.active = p.active ? 1 : 0;
            updateRows_("Brands", [b]);
            bumpCatalogVersion_();
            log_(ctx, "UPDATE", "Brands", b.id, name);
            return { message: "Brand saved", data: { id: b.id } };
        }
        if (dup) fail_("Brand already exists");
        const id = ensureBrand_(name);
        bumpCatalogVersion_();
        log_(ctx, "CREATE", "Brands", id, name);
        return { message: "Brand added", data: { id } };
    });
}

function apiSaveCategory_(p, ctx) {
    const name = str_(p.name);
    if (!name) fail_("Category name is required");
    const gst = num_(p.default_gst, 18);
    if (GST_RATES.indexOf(gst) < 0) fail_("GST rate must be one of " + GST_RATES.join(", "));
    return withLock_(() => {
        const dup = rows_("Categories").find((c) => c.name.toLowerCase() === name.toLowerCase());
        if (p.id) {
            const c = findBy_("Categories", "id", Number(p.id));
            if (!c) fail_("Category not found");
            if (dup && dup.id !== c.id) fail_("Category already exists");
            Object.assign(c, {
                name, default_hsn: str_(p.default_hsn), default_gst: gst,
                sort: num_(p.sort, c.sort), active: p.active === undefined ? c.active : p.active ? 1 : 0,
            });
            updateRows_("Categories", [c]);
            bumpCatalogVersion_();
            log_(ctx, "UPDATE", "Categories", c.id, name);
            return { message: "Category saved", data: { id: c.id } };
        }
        if (dup) fail_("Category already exists");
        const id = nextId_("Categories");
        appendRows_("Categories", [
            { id, name, default_hsn: str_(p.default_hsn), default_gst: gst, sort: num_(p.sort, id), active: 1, created_at: nowStr_() },
        ]);
        bumpCatalogVersion_();
        log_(ctx, "CREATE", "Categories", id, name);
        return { message: "Category added", data: { id } };
    });
}

// only an empty category (e.g. made by mistake) can be deleted; one in use can only be hidden
function apiDeleteCategory_(p, ctx) {
    return withLock_(() => {
        const c = findBy_("Categories", "id", Number(p.id));
        if (!c) fail_("Category not found");
        const used = rows_("Products").filter((x) => x.category_id === c.id).length;
        if (used) fail_("Used by " + used + (used === 1 ? " product" : " products") + " — hide it instead.");
        if (rows_("Categories").length <= 1) fail_("Keep at least one category.");
        deleteRow_("Categories", c);
        bumpCatalogVersion_();
        log_(ctx, "DELETE", "Categories", c.id, c.name);
        return { message: "Category deleted" };
    });
}

/* ---------- products + variants ---------- */

function normBarcode_(b) {
    return str_(b).replace(/\s+/g, "");
}

// throws if any barcode is used by another variant (or twice in the list)
function assertBarcodesUnique_(list) {
    const byCode = {};
    rows_("Variants").forEach((v) => {
        if (v.barcode) byCode[v.barcode] = v;
    });
    const seen = {};
    list.forEach((x) => {
        if (!x.barcode) return;
        if (seen[x.barcode]) fail_("Barcode " + x.barcode + " is repeated");
        seen[x.barcode] = true;
        const ex = byCode[x.barcode];
        if (ex && ex.id !== Number(x.id || 0)) {
            const prod = findBy_("Products", "id", ex.product_id);
            fail_("Barcode " + x.barcode + " already belongs to " + (prod ? prod.name : "another item") + " " + ex.size_label);
        }
    });
}

// SKU (e.g. from the website) is a key like the barcode: one size each, compared ignoring case
function assertSkusUnique_(list) {
    const bySku = {};
    rows_("Variants").forEach((v) => {
        if (v.sku) bySku[String(v.sku).toUpperCase()] = v;
    });
    const seen = {};
    list.forEach((x) => {
        if (!x.sku_given || !x.sku) return;
        const k = x.sku.toUpperCase();
        if (seen[k]) fail_("SKU " + x.sku + " is repeated");
        seen[k] = true;
        const ex = bySku[k];
        if (ex && ex.id !== Number(x.id || 0)) {
            const prod = findBy_("Products", "id", ex.product_id);
            fail_("SKU " + x.sku + " already belongs to " + (prod ? prod.name : "another item") + " " + ex.size_label);
        }
    });
}

function cleanVariant_(v, saleType) {
    const loose = saleType === "loose";
    const out = {
        id: Number(v.id || 0),
        size_label: str_(v.size_label) || (loose ? "Loose (per ml)" : ""),
        size_ml: num_(v.size_ml),
        unit: loose ? "ml" : "pcs",
        barcode: normBarcode_(v.barcode),
        sku: str_(v.sku),
        sku_given: v.sku !== undefined && v.sku !== null, // older app versions don't send it — keep the saved SKU
        mrp: r2_(num_(v.mrp)),
        sell_price: r2_(num_(v.sell_price)),
        reorder_level: num_(v.reorder_level),
        active: v.active === undefined ? 1 : v.active ? 1 : 0,
        opening_stock: num_(v.opening_stock),
        cost: r2_(num_(v.cost)),
    };
    if (!out.size_label) fail_("Size is required for every variant (e.g. 100ml)");
    if (out.sell_price <= 0) fail_("Selling price is required for " + out.size_label);
    if (out.mrp > 0 && out.sell_price > out.mrp) fail_("Selling price cannot be more than MRP (" + out.size_label + ")");
    if (out.mrp <= 0) out.mrp = out.sell_price;
    if (out.opening_stock < 0) fail_("Opening stock cannot be negative");
    return out;
}

function apiSaveProduct_(p, ctx) {
    const name = str_(p.name);
    if (!name) fail_("Product name is required");
    const saleType = p.sale_type === "loose" ? "loose" : "packed";
    const gst = num_(p.gst_rate, 18);
    if (GST_RATES.indexOf(gst) < 0) fail_("GST rate must be one of " + GST_RATES.join(", "));
    const variantsIn = (p.variants || []).map((v) => cleanVariant_(v, saleType));
    if (!variantsIn.length) fail_("Add at least one size");
    // opening stock is counted at the branch you're working at
    if (variantsIn.some((v) => !v.id && v.opening_stock > 0)) requireBranch_(ctx);

    return withLock_(() => {
        if (!findBy_("Categories", "id", Number(p.category_id))) fail_("Please choose a category");
        assertBarcodesUnique_(variantsIn);
        assertSkusUnique_(variantsIn);
        const now = nowStr_();
        const brandId = p.brand_id ? Number(p.brand_id) : ensureBrand_(p.brand_name);

        let prod;
        if (p.id) {
            prod = findBy_("Products", "id", Number(p.id));
            if (!prod) fail_("Product not found");
            Object.assign(prod, {
                name, brand_id: brandId, category_id: Number(p.category_id), gender: str_(p.gender),
                sale_type: saleType, hsn: str_(p.hsn), gst_rate: gst, image: str_(p.image),
                description: str_(p.description), active: p.active === undefined ? prod.active : p.active ? 1 : 0,
                updated_at: now,
            });
            updateRows_("Products", [prod]);
        } else {
            prod = {
                id: nextId_("Products"), name, brand_id: brandId, category_id: Number(p.category_id),
                gender: str_(p.gender), sale_type: saleType, hsn: str_(p.hsn), gst_rate: gst,
                image: str_(p.image), description: str_(p.description), active: 1,
                created_by: ctx.user.id, created_at: now, updated_at: now,
            };
            appendRows_("Products", [prod]);
        }

        const newRows = [];
        const moves = [];
        let nextVid = nextId_("Variants");
        let nextMid = nextId_("Stock_Movements");
        variantsIn.forEach((v) => {
            if (v.id) {
                const ex = findBy_("Variants", "id", v.id);
                if (!ex || ex.product_id !== prod.id) fail_("Variant not found");
                Object.assign(ex, {
                    size_label: v.size_label, size_ml: v.size_ml, unit: v.unit, barcode: v.barcode,
                    sku: v.sku_given ? v.sku : ex.sku, mrp: v.mrp, sell_price: v.sell_price, reorder_level: v.reorder_level,
                    active: v.active, updated_at: now,
                });
                if (v.cost > 0) ex.avg_cost = v.cost;
                updateRows_("Variants", [ex]);
                return;
            }
            const row = {
                id: nextVid++, product_id: prod.id, sku: v.sku, barcode: v.barcode, size_label: v.size_label,
                size_ml: v.size_ml, unit: v.unit, mrp: v.mrp, sell_price: v.sell_price, avg_cost: v.cost,
                stock_qty: 0, reorder_level: v.reorder_level, active: v.active,
                created_at: now, updated_at: now,
            };
            newRows.push(row);
            if (v.opening_stock > 0)
                moves.push({
                    id: nextMid++, variant_id: row.id, type: "opening", qty: v.opening_stock, unit_cost: v.cost,
                    balance: v.opening_stock, ref_type: "product", ref_id: String(prod.id), note: "Opening stock", branch_id: ctx.branch_id,
                    user_id: ctx.user.id, at: now,
                });
        });
        appendRows_("Variants", newRows);
        appendRows_("Stock_Movements", moves);
        addStock_(moves.map((m) => ({ variant_id: m.variant_id, branch_id: ctx.branch_id, delta: m.qty })));
        bumpCatalogVersion_();
        log_(ctx, p.id ? "UPDATE" : "CREATE", "Products", prod.id, name + " (" + variantsIn.length + " sizes)");
        return { message: p.id ? "Product saved" : "Product added", data: { id: prod.id } };
    });
}

function apiToggleProduct_(p, ctx) {
    return withLock_(() => {
        const prod = findBy_("Products", "id", Number(p.id));
        if (!prod) fail_("Product not found");
        prod.active = prod.active ? 0 : 1;
        prod.updated_at = nowStr_();
        updateRows_("Products", [prod]);
        bumpCatalogVersion_();
        log_(ctx, prod.active ? "ACTIVATE" : "DEACTIVATE", "Products", prod.id, prod.name);
        return { message: prod.active ? "Product is active" : "Product hidden from sale" };
    });
}

/**
 * Permanently delete a product added by mistake (owner). Only allowed while nothing refers to it:
 * no bills, returns, stock-in, adjustments or transfers (opening stock is fine) and no held bill.
 * Anything already used must be hidden instead, so bills and GST records stay complete.
 */
function apiDeleteProduct_(p, ctx) {
    return withLock_(() => {
        const prod = findBy_("Products", "id", Number(p.id));
        if (!prod) fail_("Product not found");
        const variants = rows_("Variants").filter((v) => v.product_id === prod.id);
        const vids = {};
        variants.forEach((v) => (vids[v.id] = true));

        const used =
            rows_("Stock_Movements").some((m) => vids[m.variant_id] && m.type !== "opening") ||
            rows_("Sale_Items").some((i) => vids[i.variant_id]) ||
            rows_("Return_Items").some((i) => vids[i.variant_id]);
        if (used) fail_("Already used in bills or stock history — hide it instead (eye icon).");
        const held = rows_("Held_Bills").some((h) => ((h.cart_json && h.cart_json.lines) || []).some((l) => vids[l.variant_id]));
        if (held) fail_("This product is in a held bill — finish or delete that bill first.");

        // rows are emptied, not deleted, so nothing moves while others are saving (see deleteRow_)
        const drop = (name, rows) => emptyRows_(name, rows.map((r) => r._r));
        drop("Stock_Movements", rows_("Stock_Movements").filter((m) => vids[m.variant_id]));
        drop("Branch_Stock", rows_("Branch_Stock").filter((b) => vids[b.variant_id]));
        drop("Variants", variants);
        drop("Products", [prod]);

        bumpCatalogVersion_();
        const codes = variants.map((v) => v.barcode).filter(String).join(", ");
        log_(ctx, "DELETE", "Products", prod.id, prod.name + (codes ? " (barcodes: " + codes + ")" : ""));
        return { message: "Product deleted" };
    });
}

/**
 * Next SKU in the website's series (SKU-0001, SKU-0002 …): one above the highest SKU-#### in the app.
 * The counter is kept too, so a number handed out once is never given again (even if not saved or deleted).
 */
function apiGenerateSku_(p, ctx) {
    return withLock_(() => {
        const used = {};
        let high = 0;
        rows_("Variants").forEach((v) => {
            const s = String(v.sku || "").toUpperCase();
            if (!s) return;
            used[s] = true;
            const m = /^SKU-(\d+)$/.exec(s);
            if (m) high = Math.max(high, Number(m[1]));
        });
        let n = Math.max(high, num_(setting_("sku_seq"), 0));
        let sku;
        do {
            n++;
            sku = "SKU-" + pad_(n, 4);
        } while (used[sku]);
        setSetting_("sku_seq", n, ctx.user.id);
        return { data: { sku } };
    });
}

function apiGenerateBarcode_(p, ctx) {
    return withLock_(() => {
        const used = {};
        rows_("Variants").forEach((v) => (used[v.barcode] = true));
        let code;
        do {
            code = "GF" + pad_(nextCounter_("internal_barcode_seq"), 6);
        } while (used[code]);
        return { data: { barcode: code } };
    });
}

/* ---------- images (Drive) ---------- */

/**
 * The product-photo folder. It is made at the top of Drive, but the owner may have filed it somewhere
 * else (beside the Sheet, say), so it is looked for by name anywhere in Drive — except in the bin and
 * inside Back_up, where every full backup keeps a copy under the very same name.
 *
 * One made while the app was called Groovy POS is renamed where it sits: a Drive folder keeps its id
 * through a rename and a product stores only its photo's file id, so every photo keeps showing.
 */
function imageFolder_(create) {
    const working = (name) => {
        const it = DriveApp.getFoldersByName(name);
        while (it.hasNext()) {
            const f = it.next();
            if (!f.isTrashed() && !insideBackup_(f)) return f;
        }
        return null;
    };
    const now = working(APP.IMAGE_FOLDER);
    if (now) return now;
    const old = working(APP.IMAGE_FOLDER_OLD);
    if (old) return old.setName(APP.IMAGE_FOLDER);
    return create ? DriveApp.createFolder(APP.IMAGE_FOLDER) : null;
}

/** True for anything under a Back_up folder — a backup's copy, never the one the app works in. */
function insideBackup_(folder) {
    let parents = folder.getParents();
    while (parents.hasNext()) {
        const p = parents.next();
        if (p.getName() === BACKUP_ROOT_) return true;
        parents = p.getParents();
    }
    return false;
}

function apiUploadImage_(p, ctx) {
    const data = String(p.data || "");
    if (!data) fail_("No image");
    if (data.length > 3 * 1024 * 1024) fail_("Image too large (max ~2 MB)");
    const mime = /^image\/(jpeg|png|webp)$/.test(p.mime) ? p.mime : "image/jpeg";
    const folder = imageFolder_(true);
    const blob = Utilities.newBlob(Utilities.base64Decode(data), mime, str_(p.name) || "product.jpg");
    const file = folder.createFile(blob);
    try {
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (e) {
        console.warn("setSharing blocked by account policy: " + e); // image may not show on other phones
    }
    return { data: { image: "drive:" + file.getId() } };
}

/* ---------- CSV bulk import ---------- */

/**
 * rows: [{brand, category, product, gender, sale_type, size_label, size_ml, barcode,
 *         mrp, sell_price, cost, opening_stock, hsn, gst_rate, reorder_level, image, sku}]
 * Rows with the same brand+product become sizes of one product.
 * A row matching an existing size (by barcode, else brand+product+size) UPDATES it — blank cells keep
 * the current value and stock is never changed — so re-uploading a file never creates duplicates.
 */
function apiImportCatalog_(p, ctx) {
    const input = p.rows || [];
    if (!input.length) fail_("Nothing to import");
    if (input.length > 2000) fail_("Import at most 2000 rows at a time");
    if (input.some((r) => num_(r.opening_stock) > 0)) requireBranch_(ctx);

    return withLock_(() => {
        const now = nowStr_();
        const errors = [];
        const blank = (x) => x === undefined || x === null || String(x).trim() === "";
        const sizeKey = (s) => String(s || "").toLowerCase().replace(/\s+/g, "");

        const catByName = {};
        rows_("Categories").forEach((c) => (catByName[c.name.toLowerCase()] = c));
        const brandsById = indexBy_(rows_("Brands"), "id");
        const brandOf = (x) => (brandsById[x.brand_id] ? brandsById[x.brand_id].name : "");
        const prodKey = (brandName, prodName) => (brandName || "").toLowerCase() + "|" + prodName.toLowerCase();
        const prodById = {};
        const prodByKey = {};
        rows_("Products").forEach((x) => {
            prodById[x.id] = x;
            prodByKey[prodKey(brandOf(x), x.name)] = x;
        });
        const varByCode = {};
        const varBySku = {}; // SKU (e.g. SKU-0001 from the website) is a key like the barcode, ignoring case
        const varsByProd = {};
        rows_("Variants").forEach((v) => {
            if (v.barcode) varByCode[v.barcode] = v;
            if (v.sku) varBySku[String(v.sku).toUpperCase()] = v;
            (varsByProd[v.product_id] = varsByProd[v.product_id] || []).push(v);
        });

        const newProds = [];
        const newVars = [];
        const moves = [];
        const newCats = [];
        const changedVars = [];
        const changedProds = [];
        let updated = 0;
        let unchanged = 0;
        let stockIgnored = 0;
        let barcodesFilled = 0; // blank barcodes filled from the website's Product Id
        let pid = nextId_("Products");
        let vid = nextId_("Variants");
        let mid = nextId_("Stock_Movements");
        let catId = nextId_("Categories");

        const catFor = (name, r) => {
            let cat = catByName[name.toLowerCase()];
            if (!cat) {
                cat = { id: catId++, name, default_hsn: str_(r.hsn), default_gst: num_(r.gst_rate, 18), sort: 99, active: 1, created_at: now };
                newCats.push(cat);
                catByName[name.toLowerCase()] = cat;
            }
            return cat;
        };
        const gstOf = (r, fallback) => {
            const g = blank(r.gst_rate) ? fallback : num_(r.gst_rate);
            if (GST_RATES.indexOf(g) < 0) fail_("Invalid GST rate " + r.gst_rate);
            return g;
        };
        const mark = (list, o) => list.indexOf(o) < 0 && list.push(o);

        input.forEach((r, i) => {
            const rowNo = Number(r._row) || i + 2; // header is row 1; _row = line in the original file
            try {
                const prodName = str_(r.product);
                if (!prodName) fail_("Product name missing");
                const key = prodKey(str_(r.brand), prodName);
                const code = normBarcode_(r.barcode);
                // the website export sends its Product Id as a fallback: it fills a blank barcode so the
                // size can be scanned, but never replaces one and never makes the upload fail
                const fb = code ? "" : normBarcode_(r.barcode_fallback);
                const freeCode = (c) => !!c && !varByCode[c];
                // same idea for the reorder level: the website exports no minimum, so a sensible one is
                // filled in — but only where none is set, never over a level chosen here. 0 for own CSVs.
                const rfb = num_(r.reorder_fallback);
                let prod = prodByKey[key] || null;
                let match = null;

                const sku = str_(r.sku);
                const skuKey = sku.toUpperCase();
                const bySku = skuKey ? varBySku[skuKey] || null : null;
                // 1. a known barcode identifies the size — for the product the row names, or when the SKU agrees too
                if (code && varByCode[code]) {
                    const v0 = varByCode[code];
                    if (bySku && bySku !== v0) fail_("Barcode " + code + " and SKU " + sku + " belong to different items");
                    const p0 = prodById[v0.product_id];
                    const skuAgrees = skuKey && String(v0.sku || "").toUpperCase() === skuKey;
                    if (!p0 || (prodKey(brandOf(p0), p0.name) !== key && !skuAgrees))
                        fail_("Barcode " + code + " belongs to " + (p0 ? (brandOf(p0) + " " + p0.name).trim() : "another item") + " " + v0.size_label);
                    prod = p0;
                    match = v0;
                }
                // 2. a known SKU identifies the size even if the name differs (the app's name is kept)
                if (!match && bySku) {
                    match = bySku;
                    prod = prodById[bySku.product_id] || prod;
                }
                // 2b. a Product Id written as a barcode by an earlier upload identifies the size again —
                // but only if it really is this row's item; anything else is ignored, never an error
                if (!match && fb && varByCode[fb]) {
                    const v1 = varByCode[fb];
                    const p1 = prodById[v1.product_id];
                    if (p1 && (prodKey(brandOf(p1), p1.name) === key || (skuKey && String(v1.sku || "").toUpperCase() === skuKey))) {
                        prod = p1;
                        match = v1;
                    }
                }
                // 3. same brand + product → same size label (a loose product has one size)
                if (!match && prod) {
                    const sizes = varsByProd[prod.id] || [];
                    match = prod.sale_type === "loose" ? sizes[0] || null : sizes.find((v) => sizeKey(v.size_label) === sizeKey(r.size_label)) || null;
                }
                if (prod && !blank(r.sale_type) && (str_(r.sale_type).toLowerCase() === "loose" ? "loose" : "packed") !== prod.sale_type)
                    fail_("Can't change packed/loose by import (" + prodName + " is " + prod.sale_type + ")");

                if (match) {
                    if (match._new) fail_("Repeats an earlier row (same product and size)");
                    if (code && match.barcode && code !== match.barcode) fail_("Size " + match.size_label + " already has barcode " + match.barcode);
                    if (skuKey && match.sku && String(match.sku).toUpperCase() !== skuKey) fail_("Size " + match.size_label + " already has SKU " + match.sku);
                    // blank cells keep the current value; cleanVariant_ validates the result
                    const v = cleanVariant_(
                        {
                            size_label: match.size_label,
                            size_ml: blank(r.size_ml) ? match.size_ml : r.size_ml,
                            barcode: code || match.barcode || (freeCode(fb) ? fb : ""),
                            mrp: blank(r.mrp) ? match.mrp : r.mrp,
                            sell_price: blank(r.sell_price) ? match.sell_price : r.sell_price,
                            reorder_level: blank(r.reorder_level) ? (num_(match.reorder_level) > 0 ? match.reorder_level : rfb) : r.reorder_level,
                            cost: blank(r.cost) ? 0 : r.cost,
                        },
                        prod.sale_type,
                    );
                    const nextVar = {
                        size_ml: v.size_ml, barcode: v.barcode, mrp: v.mrp, sell_price: v.sell_price,
                        reorder_level: v.reorder_level, avg_cost: v.cost > 0 ? v.cost : match.avg_cost,
                        sku: match.sku || sku, // a size without SKU gets the file's
                    };
                    const nextProd = {};
                    if (!prod._new) {
                        if (!blank(r.category)) nextProd.category_id = catFor(str_(r.category), r).id;
                        if (!blank(r.gender)) nextProd.gender = str_(r.gender);
                        if (!blank(r.hsn)) nextProd.hsn = str_(r.hsn);
                        if (!blank(r.gst_rate)) nextProd.gst_rate = gstOf(r, prod.gst_rate);
                        if (!blank(r.image)) nextProd.image = str_(r.image);
                    }
                    const varDiff = Object.keys(nextVar).some((k) => String(nextVar[k]) !== String(match[k]));
                    const prodDiff = Object.keys(nextProd).some((k) => String(nextProd[k]) !== String(prod[k]));
                    if (varDiff) {
                        Object.assign(match, nextVar, { updated_at: now });
                        mark(changedVars, match);
                        if (fb && match.barcode === fb) barcodesFilled++;
                        if (v.barcode) varByCode[v.barcode] = match;
                        if (match.sku) varBySku[String(match.sku).toUpperCase()] = match;
                    }
                    if (prodDiff) {
                        Object.assign(prod, nextProd, { updated_at: now });
                        mark(changedProds, prod);
                    }
                    if (varDiff || prodDiff) updated++;
                    else unchanged++;
                    if (num_(r.opening_stock) > 0) stockIgnored++; // stock only via Stock In / Adjust
                    return;
                }

                // 3. new size (and maybe new product)
                const saleType = prod ? prod.sale_type : str_(r.sale_type).toLowerCase() === "loose" ? "loose" : "packed";
                const v = cleanVariant_(
                    {
                        size_label: r.size_label, size_ml: r.size_ml, barcode: code || (freeCode(fb) ? fb : ""), mrp: r.mrp,
                        sell_price: r.sell_price, reorder_level: blank(r.reorder_level) ? rfb : r.reorder_level,
                        opening_stock: r.opening_stock, cost: r.cost,
                    },
                    saleType,
                );
                if (!prod) {
                    const catName = str_(r.category) || str_(r.new_category); // new_category: guess from the website export, new products only
                    if (!catName) fail_("Category missing");
                    const cat = catFor(catName, r);
                    prod = {
                        id: pid++, name: prodName, brand_id: ensureBrand_(str_(r.brand)), category_id: cat.id,
                        gender: str_(r.gender), sale_type: saleType, hsn: str_(r.hsn) || cat.default_hsn,
                        gst_rate: gstOf(r, cat.default_gst), image: str_(r.image), description: "", active: 1,
                        created_by: ctx.user.id, created_at: now, updated_at: now, _new: true,
                    };
                    newProds.push(prod);
                    prodByKey[key] = prod;
                    prodById[prod.id] = prod;
                    brandsById[prod.brand_id] = brandsById[prod.brand_id] || { id: prod.brand_id, name: str_(r.brand) };
                }
                const row = {
                    id: vid++, product_id: prod.id, sku: str_(r.sku), barcode: v.barcode, size_label: v.size_label,
                    size_ml: v.size_ml, unit: v.unit, mrp: v.mrp, sell_price: v.sell_price, avg_cost: v.cost,
                    stock_qty: 0, reorder_level: v.reorder_level, active: 1, created_at: now, updated_at: now, _new: true,
                };
                newVars.push(row);
                (varsByProd[prod.id] = varsByProd[prod.id] || []).push(row);
                if (fb && row.barcode === fb) barcodesFilled++;
                if (v.barcode) varByCode[v.barcode] = row;
                if (row.sku) varBySku[row.sku.toUpperCase()] = row;
                if (v.opening_stock > 0)
                    moves.push({
                        id: mid++, variant_id: row.id, type: "opening", qty: v.opening_stock, unit_cost: v.cost,
                        balance: v.opening_stock, ref_type: "import", ref_id: "", note: "Opening stock (import)", branch_id: ctx.branch_id,
                        user_id: ctx.user.id, at: now,
                    });
            } catch (e) {
                errors.push({ row: rowNo, message: e.message || String(e) });
            }
        });

        [newProds, newVars].forEach((list) => list.forEach((o) => delete o._new));
        appendRows_("Categories", newCats);
        appendRows_("Products", newProds);
        appendRows_("Variants", newVars);
        updateRowsBatch_("Products", changedProds);
        updateRowsBatch_("Variants", changedVars);
        appendRows_("Stock_Movements", moves);
        addStock_(moves.map((m) => ({ variant_id: m.variant_id, branch_id: ctx.branch_id, delta: m.qty })));
        if (newVars.length || updated || newCats.length) bumpCatalogVersion_();
        const summary =
            "Added " + newVars.length + " sizes (" + newProds.length + " new products), updated " + updated + ", " + unchanged + " unchanged" +
            (errors.length ? ", " + errors.length + " rows skipped" : "");
        log_(ctx, "IMPORT", "Products", "", summary);
        return {
            message: summary,
            data: { products: newProds.length, variants: newVars.length, updated, unchanged, stock_ignored: stockIgnored, barcodes_filled: barcodesFilled, errors },
        };
    });
}

/* ---------- stock, on its own ---------- */

/**
 * What stock has changed since the app last asked.
 *
 * The catalogue is big and rarely changes; stock is tiny and changes with every bill. This answers
 * the second question on its own, so a sale on one phone no longer makes every other phone fetch
 * seventeen hundred products again.
 *
 * The whole current map comes back every time (`full`), read from Branch_Stock — a table the size of
 * the product list. Working out "what moved since `since`" meant reading the timestamp of every stock
 * movement ever written, a column that grows with every item sold, and the map was read anyway to
 * answer it. The full map is also exactly what the catalogue carries, so a phone can never drift from
 * it. `since` is still accepted (older app versions send it) and ignored.
 */
function apiGetStock_(p, ctx) {
    const now = nowStr_();
    const version = num_(setting_("stock_version"), 1);
    const branch = num_(ctx.branch_id);
    const byBranch = stockByBranch_();
    const stock = stockMap_(branch);
    return { data: { stock_version: version, branch_id: branch, at: now, full: true, changed: stock, by_branch: byBranch } };
}

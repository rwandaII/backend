import { pool } from './db.js';
import { slugify } from './slug.js';

/**
 * The catalog is the SINGLE SOURCE OF TRUTH for prices.
 *
 * Prices are never taken from the browser. A customer can edit anything the
 * client sends, so the server looks every product up here by id and uses the
 * price it finds. This is the most important security property of checkout.
 *
 * Backed by Postgres, but loaded into an in-memory Map at startup (and after
 * every admin write via reloadCatalog()) so findProduct() stays synchronous -
 * pricing.ts and routes/checkout.ts need no changes to work against a database
 * instead of the old categories-menu.json file.
 */

export interface CatalogProduct {
  id: string;
  name: string;
  price: number | null; // VAT-exclusive unit price - VAT is applied once, on the cart subtotal
  qtyInStock: number;
  currency: string;
  image: string | null;
  description: string | null;
  categoryLabel: string;
  subcategoryLabel: string;
}

interface ProductRow {
  slug: string;
  name: string;
  unit_price: string | null; // numeric columns come back as strings from pg
  qty_in_stock: number;
  currency: string;
  image: string | null;
  description: string | null;
  discontinued: boolean;
  category_label: string;
  subcategory_label: string;
}

/** Must stay identical to the slug logic in src/data/categories.js */
export function productIdFromName(name: string): string {
  return slugify(name);
}

let byId = new Map<string, CatalogProduct>();
let duplicateSlugs: string[] = [];
let loaded = false;

/**
 * Loads (or reloads) the whole catalog from Postgres into memory. Call once
 * at boot, and again after any admin write to categories/subcategories/products.
 */
export async function loadCatalog(): Promise<void> {
  const { rows } = await pool.query<ProductRow>(`
    SELECT
      p.slug, p.name, p.unit_price, p.qty_in_stock, p.currency, p.image,
      p.description, p.discontinued,
      c.name AS category_label, s.name AS subcategory_label
    FROM products p
    JOIN subcategories s ON s.id = p.subcategory_id
    JOIN categories c ON c.id = s.category_id
    ORDER BY c.sort_order, s.sort_order, p.id
  `);

  const map = new Map<string, CatalogProduct>();
  const duplicates: string[] = [];

  for (const row of rows) {
    if (map.has(row.slug)) {
      duplicates.push(row.slug);
      continue; // keep the first, same as the frontend's findProductById
    }
    map.set(row.slug, {
      id: row.slug,
      name: row.name,
      price: row.unit_price != null ? Number(row.unit_price) : null,
      qtyInStock: row.qty_in_stock,
      currency: row.currency,
      image: row.image,
      description: row.description,
      categoryLabel: row.category_label,
      subcategoryLabel: row.subcategory_label,
    });
  }

  byId = map;
  duplicateSlugs = duplicates;
  loaded = true;
}

export const reloadCatalog = loadCatalog;

export function findProduct(id: string): CatalogProduct | null {
  return byId.get(id) ?? null;
}

export function allProducts(): CatalogProduct[] {
  return [...byId.values()];
}

export function catalogStats() {
  let priced = 0;
  let sellable = 0;
  for (const p of byId.values()) {
    if (p.price !== null) priced++;
    if (p.price !== null && p.qtyInStock > 0) sellable++;
  }
  return {
    total: byId.size,
    priced,
    sellable,
    duplicateIds: duplicateSlugs.length,
    loaded,
  };
}

export function logCatalogWarnings(): void {
  const s = catalogStats();
  console.log(
    `  Catalog: ${s.total} products, ${s.priced} priced, ${s.sellable} priced AND in stock.`
  );
  if (s.sellable < s.total) {
    console.warn(
      `  ${s.total - s.sellable} products cannot be purchased (no price and/or no stock).`
    );
  }
  if (s.duplicateIds > 0) {
    console.warn(
      `  ${s.duplicateIds} products share an id with another product and were skipped. ` +
        `Two different products slugify to the same name - they need real unique ids.`
    );
  }
}

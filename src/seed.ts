import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pool } from './db.js';
import { productIdFromName } from './catalog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const catalogPath =
  process.env.CATALOG_PATH ?? resolve(__dirname, '../../src/data/categories-menu.json');

interface RawProduct {
  name: string;
  barcode: string | null;
  sellingPrice: number | null;
  unitPrice: number | null;
  qtyInStock: number | null;
  discontinued: boolean | null;
  price: number | null;
  currency?: string;
  image?: string | null;
}

interface RawSubcategory {
  label: string;
  slug: string;
  products: RawProduct[];
}

interface RawCategory {
  label: string;
  slug: string;
  children: RawSubcategory[];
}

function brandFromName(name: string): string | null {
  const first = name.split(' ')[0]?.replace(/[^a-zA-Z0-9&]+/g, '');
  return first || null;
}

/** The three legacy price fields are always equal when populated - collapse to one. */
function unitPriceOf(p: RawProduct): number | null {
  const v = p.price ?? p.sellingPrice ?? p.unitPrice;
  return typeof v === 'number' && v > 0 ? v : null;
}

async function main() {
  const raw: RawCategory[] = JSON.parse(readFileSync(catalogPath, 'utf-8'));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Reseeding the catalog is a full replace - it's reference data, not orders.
    await client.query('TRUNCATE products, subcategories, categories RESTART IDENTITY CASCADE');

    let catCount = 0;
    let subCount = 0;
    let productCount = 0;

    for (let ci = 0; ci < raw.length; ci++) {
      const cat = raw[ci];
      const catRes = await client.query<{ id: number }>(
        `INSERT INTO categories (name, slug, sort_order) VALUES ($1, $2, $3) RETURNING id`,
        [cat.label, cat.slug, ci]
      );
      const categoryId = catRes.rows[0].id;
      catCount++;

      for (let si = 0; si < cat.children.length; si++) {
        const sub = cat.children[si];
        const subRes = await client.query<{ id: number }>(
          `INSERT INTO subcategories (category_id, name, slug, sort_order) VALUES ($1, $2, $3, $4) RETURNING id`,
          [categoryId, sub.label, sub.slug, si]
        );
        const subcategoryId = subRes.rows[0].id;
        subCount++;

        for (const p of sub.products) {
          const slug = productIdFromName(p.name);
          const unitPrice = unitPriceOf(p);
          await client.query(
            `INSERT INTO products
              (subcategory_id, name, slug, brand, barcode, unit_price, currency, qty_in_stock, discontinued, image)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              subcategoryId,
              p.name,
              slug,
              brandFromName(p.name),
              p.barcode ?? null,
              unitPrice,
              p.currency ?? 'RWF',
              typeof p.qtyInStock === 'number' ? p.qtyInStock : 0,
              Boolean(p.discontinued),
              p.image ?? null,
            ]
          );
          productCount++;
        }
      }
    }

    await client.query('COMMIT');
    console.log(`Seeded ${catCount} categories, ${subCount} subcategories, ${productCount} products.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});

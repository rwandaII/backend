// Finds every product with no gallery photos yet (product_images has zero
// rows for it) - the "extra images that explain the product" (feature
// close-ups, lifestyle shots, packaging) sourced from the brand's official
// site, separate from products.image (the single cover shot).
//
// Writes products-missing-gallery.csv, one row per product, grouped by
// brand so a pilot/continuation batch can be picked by real, recognizable
// brands first (many `brand` values in this DB are just the first word of a
// generic supplier line, not a real trademark with its own website - see
// [[missing-product-images-sourcing]]).

import 'dotenv/config';
import pg from 'pg';
import { writeFileSync } from 'node:fs';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const { rows } = await pool.query(`
  SELECT p.id, p.name, p.brand, p.image, p.discontinued, p.qty_in_stock,
         c.name AS category, sc.name AS subcategory
  FROM products p
  JOIN subcategories sc ON sc.id = p.subcategory_id
  JOIN categories c ON c.id = sc.category_id
  WHERE NOT EXISTS (SELECT 1 FROM product_images gi WHERE gi.product_id = p.id)
  ORDER BY p.brand NULLS LAST, c.name, sc.name, p.name
`);

const header = 'id,brand,name,category,subcategory,has_cover_image,qty_in_stock,discontinued';
const csvLines = [header];
for (const r of rows) {
  const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  csvLines.push([
    r.id,
    esc(r.brand),
    esc(r.name),
    esc(r.category),
    esc(r.subcategory),
    r.image ? 'yes' : 'no',
    r.qty_in_stock,
    r.discontinued ? 'yes' : 'no',
  ].join(','));
}
writeFileSync('products-missing-gallery.csv', csvLines.join('\n'), 'utf8');

// Brand frequency, to help pick a pilot batch of real/recognizable brands.
const byBrand = new Map();
for (const r of rows) {
  const b = (r.brand || '(none)').trim();
  byBrand.set(b, (byBrand.get(b) || 0) + 1);
}
const topBrands = [...byBrand.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);

console.log(`Total products: (see check-missing-images.mjs for cover-image count)`);
console.log(`Products with zero gallery photos: ${rows.length}`);
console.log(`Wrote products-missing-gallery.csv`);
console.log('\nTop brands among products missing a gallery:');
for (const [b, n] of topBrands) console.log(`  ${n.toString().padStart(4)}  ${b}`);

await pool.end();

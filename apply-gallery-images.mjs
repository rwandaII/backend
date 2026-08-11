// Applies a batch of gallery-photo assignments to product_images.
// Usage: node apply-gallery-images.mjs batch.json
// batch.json: [{ id, images: ["filename1.webp", "filename2.webp", ...] }, ...]
// Images are expected to already sit in public/products/. Existing gallery
// rows for a product are replaced (not appended) so re-runs stay idempotent.

import 'dotenv/config';
import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const batchFile = process.argv[2];
const batch = JSON.parse(readFileSync(batchFile, 'utf8'));

const PRODUCTS_DIR = resolve(process.cwd(), '..', 'public', 'products');

let productsUpdated = 0;
let imagesInserted = 0;
for (const { id, images } of batch) {
  const missing = images.filter((f) => !existsSync(resolve(PRODUCTS_DIR, f)));
  if (missing.length) {
    console.log(`SKIP id=${id} (missing files: ${missing.join(', ')})`);
    continue;
  }
  await pool.query('DELETE FROM product_images WHERE product_id = $1', [id]);
  let sortOrder = 1;
  for (const filename of images) {
    await pool.query(
      `INSERT INTO product_images (product_id, image, sort_order) VALUES ($1, $2, $3)`,
      [id, `/products/${filename}`, sortOrder]
    );
    sortOrder++;
    imagesInserted++;
  }
  productsUpdated++;
  console.log(`applied id=${id} -> ${images.length} gallery images`);
}

console.log(`Products updated: ${productsUpdated}, images inserted: ${imagesInserted}`);
await pool.end();

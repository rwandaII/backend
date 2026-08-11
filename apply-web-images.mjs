// Applies a batch of {id, filename} image assignments to the DB.
// Usage: node _tmp-apply-images.mjs batch.json
import 'dotenv/config';
import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const batchFile = process.argv[2];
const batch = JSON.parse(readFileSync(batchFile, 'utf8'));

const PRODUCTS_DIR = resolve(process.cwd(), '..', 'public', 'products');

let applied = 0;
for (const { id, ids, filename } of batch) {
  const targetIds = ids ?? [id];
  const filePath = resolve(PRODUCTS_DIR, filename);
  if (!existsSync(filePath)) {
    console.log('SKIP (file missing):', filename);
    continue;
  }
  for (const pid of targetIds) {
    await pool.query(`UPDATE products SET image=$1, updated_at=now() WHERE id=$2`, [`/products/${filename}`, pid]);
    applied++;
  }
  console.log('applied', filename, '->', targetIds.join(','));
}
console.log('Total rows updated:', applied);
await pool.end();

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pool } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(__dirname, '../schema.sql');

async function main() {
  const sql = readFileSync(schemaPath, 'utf-8');
  console.log('Applying server/schema.sql ...');
  await pool.query(sql);
  console.log('Schema is up to date.');
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});

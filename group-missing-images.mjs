// Regenerates missing-images-grouped.json from the live DB: dedupes the
// current missing-image products into "base product" groups (stripping
// size/pack/color variant noise) so one sourced photo can be applied to
// every variant row via apply-web-images.mjs's `ids` array.
import 'dotenv/config';
import pg from 'pg';
import { writeFileSync } from 'node:fs';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const { rows } = await pool.query(`
  SELECT p.id, p.name, p.brand, p.slug, c.name AS category, sc.name AS subcategory
  FROM products p
  JOIN subcategories sc ON sc.id = p.subcategory_id
  JOIN categories c ON c.id = sc.category_id
  WHERE p.image IS NULL
  ORDER BY c.name, sc.name, p.name
`);

function baseName(name) {
  let s = name.toUpperCase();
  s = s.replace(/\bEU\s*\d+\/\d+\b/g, '');
  s = s.replace(/\bN0?\s*\d+\b/g, '');
  s = s.replace(/\bNO\.?\s*\d+\b/g, '');
  s = s.replace(/\b(SMALL|MEDIUM|LARGE|X-LARGE|XX-LARGE|X-SMALL)\b/g, '');
  s = s.replace(/\b\d{1,3}\b(?!\s*(ML|G|KG|GR|MG|L))/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

const groups = new Map();
for (const r of rows) {
  const b = baseName(r.name);
  if (!groups.has(b)) groups.set(b, []);
  groups.get(b).push(r);
}

const out = [...groups.entries()].map(([base, items]) => ({
  base,
  count: items.length,
  ids: items.map((i) => i.id),
  names: items.map((i) => i.name),
  brand: items[0].brand,
  category: items[0].category,
  subcategory: items[0].subcategory,
}));
out.sort((a, b) => b.count - a.count);

writeFileSync('missing-images-grouped.json', JSON.stringify(out, null, 2));
console.log('total missing products:', rows.length);
console.log('distinct groups (search targets):', out.length);
await pool.end();

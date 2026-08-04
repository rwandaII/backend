import 'dotenv/config';
import pg from 'pg';
import { writeFileSync } from 'node:fs';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const { rows } = await pool.query(`
  SELECT p.id, p.name, c.name AS category, sc.name AS subcategory
  FROM products p
  JOIN subcategories sc ON sc.id = p.subcategory_id
  JOIN categories c ON c.id = sc.category_id
  WHERE p.image IS NULL
  ORDER BY c.name, sc.name, p.name
`);

const header = 'id,category,subcategory,name';
const lines = rows.map(
  (r) => `${r.id},"${r.category}","${r.subcategory}","${r.name.replace(/"/g, '""')}"`
);
writeFileSync('products-missing-images.csv', [header, ...lines].join('\n'));
console.log('Wrote', rows.length, 'rows to products-missing-images.csv');
await pool.end();

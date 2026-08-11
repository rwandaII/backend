// Full checkup: finds every product with no usable image.
// Two failure modes are checked, not just the DB flag:
//   1. products.image IS NULL / empty  -> never had an image assigned.
//   2. products.image is set, but the file it points to isn't actually
//      present in public/products/ (broken link - e.g. file renamed/deleted).
//
// Writes products-missing-images.xlsx with one row per problem product.

import 'dotenv/config';
import pg from 'pg';
import { existsSync } from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const PUBLIC_PRODUCTS_DIR = path.resolve(process.cwd(), '..', 'public', 'products');

const { rows } = await pool.query(`
  SELECT p.id, p.name, p.brand, p.image, p.discontinued, p.qty_in_stock,
         c.name AS category, sc.name AS subcategory
  FROM products p
  JOIN subcategories sc ON sc.id = p.subcategory_id
  JOIN categories c ON c.id = sc.category_id
  ORDER BY c.name, sc.name, p.name
`);

const problems = [];
for (const r of rows) {
  const raw = (r.image ?? '').trim();
  if (!raw) {
    problems.push({ ...r, issue: 'No image on file' });
    continue;
  }
  const filename = raw.replace(/^\/?products\//, '');
  const onDisk = existsSync(path.join(PUBLIC_PRODUCTS_DIR, filename));
  if (!onDisk) {
    problems.push({ ...r, issue: `Image path set ("${raw}") but file missing on disk` });
  }
}

const workbook = new ExcelJS.Workbook();
const sheet = workbook.addWorksheet('Missing Images');
sheet.columns = [
  { header: 'Product ID', key: 'id', width: 10 },
  { header: 'Category', key: 'category', width: 30 },
  { header: 'Subcategory', key: 'subcategory', width: 40 },
  { header: 'Product Name', key: 'name', width: 50 },
  { header: 'Brand', key: 'brand', width: 20 },
  { header: 'Qty In Stock', key: 'qty_in_stock', width: 12 },
  { header: 'Discontinued', key: 'discontinued', width: 12 },
  { header: 'Issue', key: 'issue', width: 45 },
];
sheet.getRow(1).font = { bold: true };
sheet.autoFilter = { from: 'A1', to: 'H1' };

for (const p of problems) {
  sheet.addRow({
    id: p.id,
    category: p.category,
    subcategory: p.subcategory,
    name: p.name,
    brand: p.brand ?? '',
    qty_in_stock: p.qty_in_stock,
    discontinued: p.discontinued ? 'Yes' : 'No',
    issue: p.issue,
  });
}

await workbook.xlsx.writeFile('products-missing-images.xlsx');
console.log(`Checked ${rows.length} products total.`);
console.log(`Found ${problems.length} products with no usable image.`);
console.log('Wrote products-missing-images.xlsx');

await pool.end();

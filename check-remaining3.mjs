import 'dotenv/config';
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const { rows } = await pool.query(`
  SELECT p.id, p.name, p.brand, p.image
  FROM products p
  JOIN subcategories sc ON sc.id = p.subcategory_id
  LEFT JOIN product_images pi ON pi.product_id = p.id
  WHERE sc.name = 'BABY BOTTLES & OTHER DINNING UTENSILS'
    AND p.image IS NOT NULL
    AND pi.id IS NULL
  ORDER BY p.brand, p.name
`);
console.log(JSON.stringify(rows, null, 2));
console.log('COUNT:', rows.length);
await pool.end();

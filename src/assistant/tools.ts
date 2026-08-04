import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from '../db.js';
import { slugify } from '../slug.js';
import { reloadCatalog } from '../catalog.js';
import { PRODUCTS_DIR } from '../routes/admin-media.js';

/**
 * Plain functions the catalog assistant calls as tools. Kept separate from
 * the admin-catalog.ts Express routes so they're callable directly (no
 * req/res), and so the same logic backs both the dashboard's ordinary CRUD
 * forms and the chat assistant.
 */

const PRODUCT_COLUMNS = `
  p.id, p.name, p.slug, p.brand, p.barcode,
  p.unit_price, p.vat_rate, p.total_price, p.currency,
  p.qty_in_stock, p.discontinued, p.image, p.description,
  c.id AS category_id, c.name AS category_name,
  s.id AS subcategory_id, s.name AS subcategory_name
`;

const PRODUCT_JOIN = `
  FROM products p
  JOIN subcategories s ON s.id = p.subcategory_id
  JOIN categories c ON c.id = s.category_id
`;

export async function searchProducts(args: {
  query?: string;
  categoryId?: number;
  subcategoryId?: number;
  limit?: number;
}) {
  const query = args.query?.trim() ?? '';
  const limit = Math.min(50, Math.max(1, args.limit ?? 20));

  const { rows } = await pool.query(
    `SELECT ${PRODUCT_COLUMNS}, similarity(p.name, $1) AS match_score
     ${PRODUCT_JOIN}
     WHERE ($1 = '' OR p.name ILIKE '%' || $1 || '%' OR p.barcode ILIKE '%' || $1 || '%' OR similarity(p.name, $1) > 0.2)
       AND ($2::int IS NULL OR c.id = $2)
       AND ($3::int IS NULL OR s.id = $3)
     ORDER BY match_score DESC, p.id
     LIMIT $4`,
    [query, args.categoryId ?? null, args.subcategoryId ?? null, limit]
  );
  return rows;
}

export async function getProduct(id: number) {
  const { rows } = await pool.query(`SELECT ${PRODUCT_COLUMNS} ${PRODUCT_JOIN} WHERE p.id = $1`, [id]);
  if (!rows[0]) throw new Error(`No product with id ${id}.`);
  return rows[0];
}

export interface ProductInput {
  subcategoryId: number;
  name: string;
  brand?: string;
  barcode?: string;
  unitPrice?: number;
  qtyInStock?: number;
  discontinued?: boolean;
  description?: string;
  image?: string;
}

export async function createProduct(input: ProductInput) {
  if (!input.subcategoryId) throw new Error('subcategoryId is required. Use list_subcategories to find one.');
  if (!input.name?.trim()) throw new Error('name is required.');

  const { rows: subRows } = await pool.query(`SELECT id FROM subcategories WHERE id = $1`, [input.subcategoryId]);
  if (!subRows[0]) throw new Error(`No subcategory with id ${input.subcategoryId}. Use list_subcategories to find a valid one.`);

  const slug = slugify(input.name);
  const { rows } = await pool.query(
    `INSERT INTO products (subcategory_id, name, slug, brand, barcode, unit_price, qty_in_stock, discontinued, description, image)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,0),COALESCE($8,false),$9,$10)
     RETURNING id`,
    [
      input.subcategoryId, input.name.trim(), slug, input.brand ?? null, input.barcode ?? null,
      input.unitPrice ?? null, input.qtyInStock ?? null, input.discontinued ?? null,
      input.description ?? null, input.image ?? null,
    ]
  );
  await reloadCatalog();
  return getProduct(rows[0].id);
}

export async function updateProduct(id: number, patch: Partial<ProductInput>) {
  const slug = patch.name ? slugify(patch.name) : undefined;

  const { rowCount } = await pool.query(
    `UPDATE products SET
       subcategory_id = COALESCE($2, subcategory_id),
       name = COALESCE($3, name),
       slug = COALESCE($4, slug),
       brand = COALESCE($5, brand),
       barcode = COALESCE($6, barcode),
       unit_price = COALESCE($7, unit_price),
       qty_in_stock = COALESCE($8, qty_in_stock),
       discontinued = COALESCE($9, discontinued),
       description = COALESCE($10, description),
       image = COALESCE($11, image),
       updated_at = now()
     WHERE id = $1`,
    [
      id, patch.subcategoryId ?? null, patch.name?.trim() ?? null, slug ?? null,
      patch.brand ?? null, patch.barcode ?? null, patch.unitPrice ?? null,
      patch.qtyInStock ?? null, patch.discontinued ?? null, patch.description ?? null, patch.image ?? null,
    ]
  );
  if (!rowCount) throw new Error(`No product with id ${id}.`);
  await reloadCatalog();
  return getProduct(id);
}

export async function deleteProduct(id: number) {
  const { rows } = await pool.query(`SELECT name FROM products WHERE id = $1`, [id]);
  if (!rows[0]) throw new Error(`No product with id ${id}.`);
  await pool.query(`DELETE FROM products WHERE id = $1`, [id]);
  await reloadCatalog();
  return { deleted: true, id, name: rows[0].name };
}

export async function listCategories() {
  const { rows } = await pool.query(`
    SELECT c.id, c.name, c.slug, count(DISTINCT s.id) AS subcategory_count, count(p.id) AS product_count
    FROM categories c
    LEFT JOIN subcategories s ON s.category_id = c.id
    LEFT JOIN products p ON p.subcategory_id = s.id
    GROUP BY c.id ORDER BY c.sort_order
  `);
  return rows;
}

export async function listSubcategories(categoryId?: number) {
  const { rows } = await pool.query(
    `SELECT s.id, s.name, s.slug, s.category_id, c.name AS category_name, count(p.id) AS product_count
     FROM subcategories s
     JOIN categories c ON c.id = s.category_id
     LEFT JOIN products p ON p.subcategory_id = s.id
     WHERE $1::int IS NULL OR s.category_id = $1
     GROUP BY s.id, c.name ORDER BY c.sort_order, s.sort_order`,
    [categoryId ?? null]
  );
  return rows;
}

/** Photo files already sitting in public/products/ - useful for finding one to attach. */
export function listAvailableImages(search?: string) {
  if (!existsSync(PRODUCTS_DIR)) return [];
  const term = search?.trim().toLowerCase();
  const files = readdirSync(PRODUCTS_DIR);
  return (term ? files.filter((f) => f.toLowerCase().includes(term)) : files).slice(0, 100);
}

export async function attachProductImage(id: number, imageFilename: string) {
  if (!existsSync(join(PRODUCTS_DIR, imageFilename))) {
    throw new Error(
      `"${imageFilename}" was not found in public/products/. Use list_available_images to see what's actually there.`
    );
  }
  const { rowCount } = await pool.query(
    `UPDATE products SET image = $1, updated_at = now() WHERE id = $2`,
    [`/products/${imageFilename}`, id]
  );
  if (!rowCount) throw new Error(`No product with id ${id}.`);
  await reloadCatalog();
  return getProduct(id);
}

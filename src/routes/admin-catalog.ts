import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { slugify } from '../slug.js';
import { reloadCatalog } from '../catalog.js';

export const adminCatalogRouter = Router();

function fail(res: import('express').Response, status: number, error: string, code = 'INVALID_INPUT') {
  res.status(status).json({ ok: false, code, error });
}

async function afterWrite() {
  // Keep checkout's in-memory catalog in sync with whatever the dashboard just changed.
  await reloadCatalog();
}

// ---------------------------------------------------------------- categories

const categorySchema = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().min(1).max(200).optional(),
  sortOrder: z.coerce.number().int().optional(),
});

adminCatalogRouter.get('/categories', async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT c.id, c.name, c.slug, c.sort_order,
           count(DISTINCT s.id) AS subcategory_count,
           count(p.id) AS product_count
    FROM categories c
    LEFT JOIN subcategories s ON s.category_id = c.id
    LEFT JOIN products p ON p.subcategory_id = s.id
    GROUP BY c.id ORDER BY c.sort_order, c.id
  `);
  res.json({ ok: true, categories: rows });
});

adminCatalogRouter.post('/categories', async (req, res) => {
  const parsed = categorySchema.safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message ?? 'Invalid input.');
  const { name, sortOrder } = parsed.data;
  const slug = parsed.data.slug ? slugify(parsed.data.slug) : slugify(name);

  try {
    const { rows } = await pool.query(
      `INSERT INTO categories (name, slug, sort_order) VALUES ($1, $2, COALESCE($3, 0)) RETURNING *`,
      [name, slug, sortOrder ?? null]
    );
    res.status(201).json({ ok: true, category: rows[0] });
  } catch (err) {
    handleConflict(err, res, 'A category with that slug already exists.');
  }
});

adminCatalogRouter.put('/categories/:id', async (req, res) => {
  const parsed = categorySchema.partial().safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message ?? 'Invalid input.');
  const { name, sortOrder } = parsed.data;
  const slug = parsed.data.slug ? slugify(parsed.data.slug) : undefined;

  try {
    const { rows } = await pool.query(
      `UPDATE categories SET
         name = COALESCE($2, name),
         slug = COALESCE($3, slug),
         sort_order = COALESCE($4, sort_order),
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, name ?? null, slug ?? null, sortOrder ?? null]
    );
    if (!rows[0]) return fail(res, 404, 'Category not found.', 'NOT_FOUND');
    await afterWrite();
    res.json({ ok: true, category: rows[0] });
  } catch (err) {
    handleConflict(err, res, 'A category with that slug already exists.');
  }
});

adminCatalogRouter.delete('/categories/:id', async (req, res) => {
  const { rowCount } = await pool.query(`DELETE FROM categories WHERE id = $1`, [req.params.id]);
  if (!rowCount) return fail(res, 404, 'Category not found.', 'NOT_FOUND');
  await afterWrite();
  res.json({ ok: true });
});

// ------------------------------------------------------------- subcategories

const subcategorySchema = z.object({
  categoryId: z.coerce.number().int().positive(),
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().min(1).max(200).optional(),
  sortOrder: z.coerce.number().int().optional(),
});

adminCatalogRouter.get('/subcategories', async (req, res) => {
  const categoryId = req.query.categoryId ? Number(req.query.categoryId) : null;
  const { rows } = await pool.query(
    `SELECT s.id, s.name, s.slug, s.sort_order, s.category_id, c.name AS category_name,
            count(p.id) AS product_count
     FROM subcategories s
     JOIN categories c ON c.id = s.category_id
     LEFT JOIN products p ON p.subcategory_id = s.id
     WHERE $1::int IS NULL OR s.category_id = $1
     GROUP BY s.id, c.name, c.sort_order ORDER BY c.sort_order, s.sort_order, s.id`,
    [categoryId]
  );
  res.json({ ok: true, subcategories: rows });
});

adminCatalogRouter.post('/subcategories', async (req, res) => {
  const parsed = subcategorySchema.safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message ?? 'Invalid input.');
  const { categoryId, name, sortOrder } = parsed.data;
  const slug = parsed.data.slug ? slugify(parsed.data.slug) : slugify(name);

  try {
    const { rows } = await pool.query(
      `INSERT INTO subcategories (category_id, name, slug, sort_order) VALUES ($1, $2, $3, COALESCE($4, 0)) RETURNING *`,
      [categoryId, name, slug, sortOrder ?? null]
    );
    res.status(201).json({ ok: true, subcategory: rows[0] });
  } catch (err) {
    handleConflict(err, res, 'A subcategory with that slug already exists in this category.');
  }
});

adminCatalogRouter.put('/subcategories/:id', async (req, res) => {
  const parsed = subcategorySchema.partial().safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message ?? 'Invalid input.');
  const { categoryId, name, sortOrder } = parsed.data;
  const slug = parsed.data.slug ? slugify(parsed.data.slug) : undefined;

  try {
    const { rows } = await pool.query(
      `UPDATE subcategories SET
         category_id = COALESCE($2, category_id),
         name = COALESCE($3, name),
         slug = COALESCE($4, slug),
         sort_order = COALESCE($5, sort_order),
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, categoryId ?? null, name ?? null, slug ?? null, sortOrder ?? null]
    );
    if (!rows[0]) return fail(res, 404, 'Subcategory not found.', 'NOT_FOUND');
    await afterWrite();
    res.json({ ok: true, subcategory: rows[0] });
  } catch (err) {
    handleConflict(err, res, 'A subcategory with that slug already exists in this category.');
  }
});

adminCatalogRouter.delete('/subcategories/:id', async (req, res) => {
  const { rowCount } = await pool.query(`DELETE FROM subcategories WHERE id = $1`, [req.params.id]);
  if (!rowCount) return fail(res, 404, 'Subcategory not found.', 'NOT_FOUND');
  await afterWrite();
  res.json({ ok: true });
});

// ------------------------------------------------------------------ products

const productSchema = z.object({
  subcategoryId: z.coerce.number().int().positive(),
  name: z.string().trim().min(1).max(300),
  brand: z.string().trim().max(100).optional(),
  barcode: z.string().trim().max(100).optional(),
  unitPrice: z.coerce.number().nonnegative().optional(),
  vatRate: z.coerce.number().min(0).max(1).optional(),
  currency: z.string().trim().length(3).optional(),
  qtyInStock: z.coerce.number().int().nonnegative().optional(),
  discontinued: z.coerce.boolean().optional(),
  image: z.string().trim().max(500).optional(),
  description: z.string().trim().max(5000).optional(),
});

adminCatalogRouter.get('/products', async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const categoryId = req.query.categoryId ? Number(req.query.categoryId) : null;
  const subcategoryId = req.query.subcategoryId ? Number(req.query.subcategoryId) : null;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 50));
  const offset = (page - 1) * pageSize;

  const { rows: countRows } = await pool.query(
    `SELECT count(*) FROM products p
     JOIN subcategories s ON s.id = p.subcategory_id
     WHERE ($1 = '' OR p.name ILIKE '%' || $1 || '%' OR p.barcode ILIKE '%' || $1 || '%')
       AND ($2::int IS NULL OR s.category_id = $2)
       AND ($3::int IS NULL OR p.subcategory_id = $3)`,
    [search, categoryId, subcategoryId]
  );

  const { rows } = await pool.query(
    `SELECT p.*, s.name AS subcategory_name, c.id AS category_id, c.name AS category_name
     FROM products p
     JOIN subcategories s ON s.id = p.subcategory_id
     JOIN categories c ON c.id = s.category_id
     WHERE ($1 = '' OR p.name ILIKE '%' || $1 || '%' OR p.barcode ILIKE '%' || $1 || '%')
       AND ($2::int IS NULL OR s.category_id = $2)
       AND ($3::int IS NULL OR p.subcategory_id = $3)
     ORDER BY p.id
     LIMIT $4 OFFSET $5`,
    [search, categoryId, subcategoryId, pageSize, offset]
  );

  res.json({
    ok: true,
    products: rows,
    total: Number(countRows[0].count),
    page,
    pageSize,
  });
});

adminCatalogRouter.get('/products/:id', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.*, s.name AS subcategory_name, c.id AS category_id, c.name AS category_name
     FROM products p
     JOIN subcategories s ON s.id = p.subcategory_id
     JOIN categories c ON c.id = s.category_id
     WHERE p.id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return fail(res, 404, 'Product not found.', 'NOT_FOUND');
  res.json({ ok: true, product: rows[0] });
});

adminCatalogRouter.post('/products', async (req, res) => {
  const parsed = productSchema.safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message ?? 'Invalid input.');
  const p = parsed.data;
  const slug = slugify(p.name);

  const { rows } = await pool.query(
    `INSERT INTO products
       (subcategory_id, name, slug, brand, barcode, unit_price, vat_rate, currency, qty_in_stock, discontinued, image, description)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,0.18),COALESCE($8,'RWF'),COALESCE($9,0),COALESCE($10,false),$11,$12)
     RETURNING *`,
    [
      p.subcategoryId, p.name, slug, p.brand ?? null, p.barcode ?? null,
      p.unitPrice ?? null, p.vatRate ?? null, p.currency ?? null,
      p.qtyInStock ?? null, p.discontinued ?? null, p.image ?? null, p.description ?? null,
    ]
  );
  await afterWrite();
  res.status(201).json({ ok: true, product: rows[0] });
});

adminCatalogRouter.put('/products/:id', async (req, res) => {
  const parsed = productSchema.partial().safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message ?? 'Invalid input.');
  const p = parsed.data;
  const slug = p.name ? slugify(p.name) : undefined;

  const { rows } = await pool.query(
    `UPDATE products SET
       subcategory_id = COALESCE($2, subcategory_id),
       name = COALESCE($3, name),
       slug = COALESCE($4, slug),
       brand = COALESCE($5, brand),
       barcode = COALESCE($6, barcode),
       unit_price = COALESCE($7, unit_price),
       vat_rate = COALESCE($8, vat_rate),
       currency = COALESCE($9, currency),
       qty_in_stock = COALESCE($10, qty_in_stock),
       discontinued = COALESCE($11, discontinued),
       image = COALESCE($12, image),
       description = COALESCE($13, description),
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [
      req.params.id, p.subcategoryId ?? null, p.name ?? null, slug ?? null,
      p.brand ?? null, p.barcode ?? null, p.unitPrice ?? null, p.vatRate ?? null,
      p.currency ?? null, p.qtyInStock ?? null, p.discontinued ?? null, p.image ?? null, p.description ?? null,
    ]
  );
  if (!rows[0]) return fail(res, 404, 'Product not found.', 'NOT_FOUND');
  await afterWrite();
  res.json({ ok: true, product: rows[0] });
});

adminCatalogRouter.delete('/products/:id', async (req, res) => {
  const { rowCount } = await pool.query(`DELETE FROM products WHERE id = $1`, [req.params.id]);
  if (!rowCount) return fail(res, 404, 'Product not found.', 'NOT_FOUND');
  await afterWrite();
  res.json({ ok: true });
});

function handleConflict(err: unknown, res: import('express').Response, message: string): void {
  if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === '23505') {
    fail(res, 409, message, 'CONFLICT');
    return;
  }
  console.error('admin-catalog error:', err);
  fail(res, 500, 'Something went wrong on our side.', 'SERVER_ERROR');
}

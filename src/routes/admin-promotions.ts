import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { slugify } from '../slug.js';

export const adminPromotionsRouter = Router();

function fail(res: import('express').Response, status: number, error: string, code = 'INVALID_INPUT') {
  res.status(status).json({ ok: false, code, error });
}

const promotionSchema = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  discountType: z.enum(['percent', 'fixed']).default('percent'),
  discountValue: z.coerce.number().positive(),
  startsAt: z.string().datetime().optional().nullable(),
  endsAt: z.string().datetime().optional().nullable(),
  active: z.coerce.boolean().optional(),
  bannerImage: z.string().trim().max(500).optional(),
});

adminPromotionsRouter.get('/', async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT p.*, count(pp.product_id) AS product_count
    FROM promotions p
    LEFT JOIN promotion_products pp ON pp.promotion_id = p.id
    GROUP BY p.id
    ORDER BY p.created_at DESC
  `);
  res.json({ ok: true, promotions: rows });
});

adminPromotionsRouter.get('/:id', async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM promotions WHERE id = $1`, [req.params.id]);
  if (!rows[0]) return fail(res, 404, 'Promotion not found.', 'NOT_FOUND');

  const { rows: products } = await pool.query(
    `SELECT prod.id, prod.name, prod.slug, prod.unit_price, prod.total_price, prod.image, prod.qty_in_stock
     FROM promotion_products pp
     JOIN products prod ON prod.id = pp.product_id
     WHERE pp.promotion_id = $1
     ORDER BY pp.added_at DESC`,
    [req.params.id]
  );

  res.json({ ok: true, promotion: rows[0], products });
});

adminPromotionsRouter.post('/', async (req, res) => {
  const parsed = promotionSchema.safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message ?? 'Invalid input.');
  const p = parsed.data;
  const slug = p.slug ? slugify(p.slug) : slugify(p.name);

  if (p.discountType === 'percent' && p.discountValue > 100) {
    return fail(res, 400, 'A percentage discount cannot be more than 100.');
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO promotions (name, slug, description, discount_type, discount_value, starts_at, ends_at, active, banner_image)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,true),$9)
       RETURNING *`,
      [p.name, slug, p.description ?? null, p.discountType, p.discountValue, p.startsAt ?? null, p.endsAt ?? null, p.active ?? null, p.bannerImage ?? null]
    );
    res.status(201).json({ ok: true, promotion: rows[0] });
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === '23505') {
      return fail(res, 409, 'A promotion with that slug already exists.', 'CONFLICT');
    }
    throw err;
  }
});

adminPromotionsRouter.put('/:id', async (req, res) => {
  const parsed = promotionSchema.partial().safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message ?? 'Invalid input.');
  const p = parsed.data;
  const slug = p.slug ? slugify(p.slug) : undefined;

  if (p.discountType === 'percent' && p.discountValue != null && p.discountValue > 100) {
    return fail(res, 400, 'A percentage discount cannot be more than 100.');
  }

  const { rows } = await pool.query(
    `UPDATE promotions SET
       name = COALESCE($2, name),
       slug = COALESCE($3, slug),
       description = COALESCE($4, description),
       discount_type = COALESCE($5, discount_type),
       discount_value = COALESCE($6, discount_value),
       starts_at = COALESCE($7, starts_at),
       ends_at = COALESCE($8, ends_at),
       active = COALESCE($9, active),
       banner_image = COALESCE($10, banner_image),
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [
      req.params.id, p.name ?? null, slug ?? null, p.description ?? null,
      p.discountType ?? null, p.discountValue ?? null, p.startsAt ?? null, p.endsAt ?? null,
      p.active ?? null, p.bannerImage ?? null,
    ]
  );
  if (!rows[0]) return fail(res, 404, 'Promotion not found.', 'NOT_FOUND');
  res.json({ ok: true, promotion: rows[0] });
});

adminPromotionsRouter.delete('/:id', async (req, res) => {
  const { rowCount } = await pool.query(`DELETE FROM promotions WHERE id = $1`, [req.params.id]);
  if (!rowCount) return fail(res, 404, 'Promotion not found.', 'NOT_FOUND');
  res.json({ ok: true });
});

const productIdsSchema = z.object({
  productIds: z.array(z.coerce.number().int().positive()).min(1),
});

adminPromotionsRouter.post('/:id/products', async (req, res) => {
  const parsed = productIdsSchema.safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message ?? 'Invalid input.');

  const { rows: promoRows } = await pool.query(`SELECT id FROM promotions WHERE id = $1`, [req.params.id]);
  if (!promoRows[0]) return fail(res, 404, 'Promotion not found.', 'NOT_FOUND');

  for (const productId of parsed.data.productIds) {
    await pool.query(
      `INSERT INTO promotion_products (promotion_id, product_id) VALUES ($1, $2)
       ON CONFLICT (promotion_id, product_id) DO NOTHING`,
      [req.params.id, productId]
    );
  }
  res.json({ ok: true, added: parsed.data.productIds.length });
});

adminPromotionsRouter.delete('/:id/products/:productId', async (req, res) => {
  const { rowCount } = await pool.query(
    `DELETE FROM promotion_products WHERE promotion_id = $1 AND product_id = $2`,
    [req.params.id, req.params.productId]
  );
  if (!rowCount) return fail(res, 404, 'That product is not in this promotion.', 'NOT_FOUND');
  res.json({ ok: true });
});

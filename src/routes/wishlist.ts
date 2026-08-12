import { Router } from 'express';
import { pool } from '../db.js';
import { PRODUCT_COLUMNS, PROMO_JOIN, withPromoTotal } from './catalog-public.js';

// Mounted behind requireUserAuth (see index.ts) - every route here assumes
// req.user is set. A wishlist only makes sense tied to an account (that's
// the whole point - it follows the customer across devices), so there is no
// anonymous/local fallback on the server side.
export const wishlistRouter = Router();

function fail(res: import('express').Response, status: number, error: string, code = 'INVALID_INPUT') {
  res.status(status).json({ ok: false, code, error });
}

/**
 * GET /api/wishlist
 * The signed-in customer's saved products, in the same shape ProductCard
 * already knows how to render (reuses the catalog's product query).
 */
wishlistRouter.get('/', async (req, res) => {
  const userId = req.user!.sub;
  const { rows } = await pool.query(
    `SELECT ${PRODUCT_COLUMNS}, w.added_at
     FROM wishlist_items w
     JOIN products p ON p.id = w.product_id
     JOIN subcategories s ON s.id = p.subcategory_id
     JOIN categories c ON c.id = s.category_id
     ${PROMO_JOIN}
     WHERE w.user_id = $1
     ORDER BY w.added_at DESC`,
    [userId]
  );
  res.json({ ok: true, items: rows.map(withPromoTotal) });
});

/**
 * POST /api/wishlist/:productId
 * Idempotent - liking an already-liked product just no-ops.
 */
wishlistRouter.post('/:productId', async (req, res) => {
  const userId = req.user!.sub;
  const productId = Number(req.params.productId);
  if (!Number.isInteger(productId)) return fail(res, 400, 'Invalid product id.');

  await pool.query(
    `INSERT INTO wishlist_items (user_id, product_id) VALUES ($1, $2)
     ON CONFLICT (user_id, product_id) DO NOTHING`,
    [userId, productId]
  );
  res.status(201).json({ ok: true });
});

/**
 * DELETE /api/wishlist/:productId
 */
wishlistRouter.delete('/:productId', async (req, res) => {
  const userId = req.user!.sub;
  const productId = Number(req.params.productId);
  if (!Number.isInteger(productId)) return fail(res, 400, 'Invalid product id.');

  await pool.query(`DELETE FROM wishlist_items WHERE user_id = $1 AND product_id = $2`, [userId, productId]);
  res.json({ ok: true });
});

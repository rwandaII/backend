import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { pool } from '../db.js';

export const trackRouter = Router();

const PAGE_TYPES = ['home', 'category', 'subcategory', 'product', 'cart', 'other'] as const;

const visitSchema = z.object({
  visitorKey: z.string().trim().min(1).max(100).optional(),
  path: z.string().trim().min(1).max(500),
  pageType: z.enum(PAGE_TYPES).default('other'),
  categoryId: z.coerce.number().int().positive().optional(),
  subcategoryId: z.coerce.number().int().positive().optional(),
  productId: z.coerce.number().int().positive().optional(),
  referrer: z.string().trim().max(500).optional(),
});

/**
 * POST /api/track/visit
 * Anonymous page-view tracking. The client generates/stores `visitorKey`
 * itself (localStorage, not a cookie - avoids cross-origin cookie handling
 * between the storefront and API origins) and passes it on every call. If
 * omitted, a fresh key is minted and returned for the client to persist.
 */
trackRouter.post('/visit', async (req, res) => {
  const parsed = visitSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid request.' });
  }
  const { path, pageType, categoryId, subcategoryId, productId, referrer } = parsed.data;
  const visitorKey = parsed.data.visitorKey || randomUUID();
  const userAgent = req.header('user-agent') ?? null;

  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO visitors (visitor_key, user_agent) VALUES ($1, $2)
     ON CONFLICT (visitor_key) DO UPDATE SET last_seen_at = now()
     RETURNING id`,
    [visitorKey, userAgent]
  );
  const visitorId = rows[0].id;

  await pool.query(
    `INSERT INTO page_views (visitor_id, path, page_type, category_id, subcategory_id, product_id, referrer)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [visitorId, path, pageType, categoryId ?? null, subcategoryId ?? null, productId ?? null, referrer ?? null]
  );

  res.json({ ok: true, visitorKey });
});

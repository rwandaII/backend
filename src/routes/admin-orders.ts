import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { listOrders, updateOrder } from '../orders.js';

export const adminOrdersRouter = Router();

function fail(res: import('express').Response, status: number, error: string, code = 'INVALID_INPUT') {
  res.status(status).json({ ok: false, code, error });
}

// Every order pays by mobile money in practice here: Paypack only ever does
// MTN MoMo/Airtel Money, "call" orders are settled via the momo USSD QR on
// the payment-result page, and Flutterwave is the one gateway that can also
// take a card - so it only counts when its own payment_type says mobile money.
const MOMO_FILTER = `(provider IN ('paypack', 'call') OR (provider = 'flutterwave' AND payment_type ILIKE '%mobilemoney%'))`;

/**
 * GET /api/admin/orders
 * Every checkout attempt, newest first.
 */
adminOrdersRouter.get('/', async (_req, res) => {
  res.json({ ok: true, orders: await listOrders() });
});

/**
 * GET /api/admin/orders/products-sold
 * What's actually sold (paid orders only), with a Mobile Money breakdown -
 * this is the "how many of these did MoMo pay for" view.
 */
adminOrdersRouter.get('/products-sold', async (_req, res) => {
  const [{ rows: summaryRows }, { rows: products }] = await Promise.all([
    pool.query(`
      SELECT
        count(*) AS paid_orders,
        count(*) FILTER (WHERE ${MOMO_FILTER}) AS momo_paid_orders,
        COALESCE(sum((cart->>'total')::numeric), 0) AS revenue,
        COALESCE(sum((cart->>'total')::numeric) FILTER (WHERE ${MOMO_FILTER}), 0) AS momo_revenue
      FROM orders
      WHERE status = 'paid'
    `),
    pool.query(`
      SELECT
        line->>'id' AS product_id,
        line->>'name' AS product_name,
        SUM((line->>'quantity')::int) AS qty_sold,
        SUM((line->>'lineTotal')::numeric) AS revenue,
        SUM((line->>'quantity')::int) FILTER (WHERE ${MOMO_FILTER}) AS qty_sold_momo,
        SUM((line->>'lineTotal')::numeric) FILTER (WHERE ${MOMO_FILTER}) AS revenue_momo
      FROM orders, jsonb_array_elements(cart->'lines') AS line
      WHERE status = 'paid'
      GROUP BY line->>'id', line->>'name'
      ORDER BY qty_sold DESC
    `),
  ]);

  const summary = summaryRows[0];

  res.json({
    ok: true,
    summary: {
      paidOrders: Number(summary.paid_orders),
      momoPaidOrders: Number(summary.momo_paid_orders),
      revenue: Number(summary.revenue),
      momoRevenue: Number(summary.momo_revenue),
    },
    products: products.map((p) => ({
      productId: p.product_id,
      name: p.product_name,
      qtySold: Number(p.qty_sold),
      revenue: Number(p.revenue),
      qtySoldMomo: Number(p.qty_sold_momo),
      revenueMomo: Number(p.revenue_momo),
    })),
  });
});

const statusSchema = z.object({
  status: z.enum(['paid', 'failed']),
});

/**
 * PATCH /api/admin/orders/:txRef
 * Manually settle a "call" order once staff have confirmed the mobile money
 * payment actually landed (there's no webhook for these - the customer pays
 * outside the site, by scanning the QR or calling in). Also usable to correct
 * a "mismatch" order after checking the real amount received.
 */
adminOrdersRouter.patch('/:txRef', async (req, res) => {
  const parsed = statusSchema.safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 400, 'status must be "paid" or "failed".');

  const order = await updateOrder(req.params.txRef, { status: parsed.data.status });
  if (!order) return fail(res, 404, 'Order not found.', 'NOT_FOUND');

  res.json({ ok: true, order });
});

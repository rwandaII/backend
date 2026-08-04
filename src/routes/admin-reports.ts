import { Router } from 'express';
import { pool } from '../db.js';

export const adminReportsRouter = Router();

function parseDate(raw: unknown): string {
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return new Date().toISOString().slice(0, 10);
}

/**
 * GET /api/admin/reports/daily?date=YYYY-MM-DD
 * Everything that happened on one day: orders/revenue, catalog changes,
 * new customer accounts, and what visitors looked at. Defaults to today.
 * Plain JSON - the dashboard renders both the on-screen and printable views
 * from the same response.
 */
adminReportsRouter.get('/daily', async (req, res) => {
  const date = parseDate(req.query.date);

  const [orders, newProducts, editedProducts, newUsers, topProducts, visits, lowStock] = await Promise.all([
    pool.query(
      `SELECT status, count(*) AS count, COALESCE(sum((cart->>'total')::numeric), 0) AS revenue
       FROM orders
       WHERE created_at::date = $1::date
       GROUP BY status`,
      [date]
    ),
    pool.query(
      `SELECT id, name, slug, unit_price, total_price, qty_in_stock, image
       FROM products WHERE created_at::date = $1::date ORDER BY created_at`,
      [date]
    ),
    pool.query(
      `SELECT id, name, slug, unit_price, total_price, qty_in_stock, image
       FROM products WHERE updated_at::date = $1::date AND created_at::date <> $1::date
       ORDER BY updated_at`,
      [date]
    ),
    pool.query(
      `SELECT id, name, email, phone FROM users WHERE created_at::date = $1::date ORDER BY created_at`,
      [date]
    ),
    pool.query(
      `SELECT p.id, p.name, p.slug, count(pv.id) AS views
       FROM page_views pv
       JOIN products p ON p.id = pv.product_id
       WHERE pv.created_at::date = $1::date
       GROUP BY p.id ORDER BY views DESC LIMIT 10`,
      [date]
    ),
    pool.query(
      `SELECT
         count(DISTINCT visitor_id) AS unique_visitors,
         count(*) AS page_views
       FROM page_views WHERE created_at::date = $1::date`,
      [date]
    ),
    pool.query(
      `SELECT id, name, slug, qty_in_stock FROM products
       WHERE qty_in_stock <= 5 AND NOT discontinued
       ORDER BY qty_in_stock ASC LIMIT 20`
    ),
  ]);

  const orderSummary = { total: 0, paid: 0, revenue: 0 } as { total: number; paid: number; revenue: number };
  for (const row of orders.rows) {
    orderSummary.total += Number(row.count);
    if (row.status === 'paid') {
      orderSummary.paid += Number(row.count);
      orderSummary.revenue += Number(row.revenue);
    }
  }

  res.json({
    ok: true,
    date,
    orders: { byStatus: orders.rows, summary: orderSummary },
    newProducts: newProducts.rows,
    editedProducts: editedProducts.rows,
    newUsers: newUsers.rows,
    topViewedProducts: topProducts.rows,
    visits: {
      uniqueVisitors: Number(visits.rows[0].unique_visitors),
      pageViews: Number(visits.rows[0].page_views),
    },
    lowStock: lowStock.rows,
  });
});

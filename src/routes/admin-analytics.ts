import { Router } from 'express';
import { pool } from '../db.js';

export const adminAnalyticsRouter = Router();

/**
 * GET /api/admin/analytics/overview
 * Headline numbers for the dashboard home page.
 */
adminAnalyticsRouter.get('/overview', async (_req, res) => {
  const [{ rows: totals }, { rows: today }, { rows: topProducts }, { rows: topCategories }] = await Promise.all([
    pool.query(`SELECT count(*) AS total_visitors FROM visitors`),
    pool.query(`
      SELECT
        count(DISTINCT v.id) FILTER (WHERE v.first_seen_at >= current_date) AS new_visitors_today,
        count(pv.id) FILTER (WHERE pv.created_at >= current_date) AS page_views_today
      FROM visitors v
      LEFT JOIN page_views pv ON pv.visitor_id = v.id
    `),
    pool.query(`
      SELECT p.id, p.name, p.slug, p.image, count(pv.id) AS views
      FROM page_views pv
      JOIN products p ON p.id = pv.product_id
      WHERE pv.created_at >= now() - interval '30 days'
      GROUP BY p.id
      ORDER BY views DESC
      LIMIT 10
    `),
    pool.query(`
      SELECT c.id, c.name, c.slug, count(pv.id) AS views
      FROM page_views pv
      JOIN categories c ON c.id = pv.category_id
      WHERE pv.created_at >= now() - interval '30 days'
      GROUP BY c.id
      ORDER BY views DESC
      LIMIT 10
    `),
  ]);

  res.json({
    ok: true,
    totalVisitors: Number(totals[0].total_visitors),
    newVisitorsToday: Number(today[0].new_visitors_today),
    pageViewsToday: Number(today[0].page_views_today),
    topProducts,
    topCategories,
  });
});

/**
 * GET /api/admin/analytics/timeseries?days=30
 * Daily visitor + page-view counts for a simple trend chart.
 */
adminAnalyticsRouter.get('/timeseries', async (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));

  // Aggregate visitors and page_views independently before joining to the
  // date series - joining both directly to generate_series on date alone
  // would cross-multiply same-day rows from each table against each other.
  const { rows } = await pool.query(
    `WITH bounds AS (
       SELECT (current_date - ($1::int - 1))::date AS start_date
     ),
     days AS (
       SELECT generate_series(start_date, current_date, interval '1 day')::date AS date FROM bounds
     ),
     visitor_counts AS (
       SELECT first_seen_at::date AS date, count(*) AS new_visitors
       FROM visitors, bounds
       WHERE first_seen_at::date >= bounds.start_date
       GROUP BY 1
     ),
     view_counts AS (
       SELECT created_at::date AS date, count(*) AS page_views
       FROM page_views, bounds
       WHERE created_at::date >= bounds.start_date
       GROUP BY 1
     )
     SELECT d.date, COALESCE(vc.new_visitors, 0) AS new_visitors, COALESCE(pc.page_views, 0) AS page_views
     FROM days d
     LEFT JOIN visitor_counts vc ON vc.date = d.date
     LEFT JOIN view_counts pc ON pc.date = d.date
     ORDER BY d.date`,
    [days]
  );

  res.json({ ok: true, days: rows });
});

/**
 * GET /api/admin/analytics/visitors?page=&pageSize=
 * Raw visitor list with how many pages each one viewed - the "who visited
 * and what did they look at" view.
 */
adminAnalyticsRouter.get('/visitors', async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
  const offset = (page - 1) * pageSize;

  const { rows: countRows } = await pool.query(`SELECT count(*) FROM visitors`);
  const { rows } = await pool.query(
    `SELECT v.id, v.visitor_key, v.first_seen_at, v.last_seen_at, v.user_agent,
            count(pv.id) AS page_view_count
     FROM visitors v
     LEFT JOIN page_views pv ON pv.visitor_id = v.id
     GROUP BY v.id
     ORDER BY v.last_seen_at DESC
     LIMIT $1 OFFSET $2`,
    [pageSize, offset]
  );

  res.json({ ok: true, visitors: rows, total: Number(countRows[0].count), page, pageSize });
});

/**
 * GET /api/admin/analytics/visitors/:id/pages
 * What one specific visitor looked at, most recent first.
 */
adminAnalyticsRouter.get('/visitors/:id/pages', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT pv.id, pv.path, pv.page_type, pv.created_at,
            p.name AS product_name, c.name AS category_name, s.name AS subcategory_name
     FROM page_views pv
     LEFT JOIN products p ON p.id = pv.product_id
     LEFT JOIN categories c ON c.id = pv.category_id
     LEFT JOIN subcategories s ON s.id = pv.subcategory_id
     WHERE pv.visitor_id = $1
     ORDER BY pv.created_at DESC
     LIMIT 200`,
    [req.params.id]
  );
  res.json({ ok: true, pages: rows });
});

import { Router } from 'express';
import { pool } from '../db.js';

export const catalogPublicRouter = Router();

/** Shared LATERAL join: the best active promotion for a product, if any, with its discounted unit price already computed. */
const PROMO_JOIN = `
  LEFT JOIN LATERAL (
    SELECT pr.id AS promotion_id, pr.name AS promotion_name, pr.discount_type, pr.discount_value,
           CASE WHEN pr.discount_type = 'percent' THEN ROUND(p.unit_price * (1 - pr.discount_value / 100.0), 2)
                ELSE GREATEST(p.unit_price - pr.discount_value, 0)
           END AS promo_unit_price
    FROM promotion_products pp
    JOIN promotions pr ON pr.id = pp.promotion_id
    WHERE pp.product_id = p.id AND pr.active
      AND (pr.starts_at IS NULL OR pr.starts_at <= now())
      AND (pr.ends_at IS NULL OR pr.ends_at >= now())
      AND p.unit_price IS NOT NULL
    ORDER BY pr.created_at DESC
    LIMIT 1
  ) promo ON true
`;

/** Postgres numeric columns arrive as strings - Number() them before arithmetic. */
function withPromoTotal<T extends { promo_unit_price: string | null; vat_rate: string }>(row: T) {
  return {
    ...row,
    promo_total_price:
      row.promo_unit_price != null
        ? Math.round(Number(row.promo_unit_price) * (1 + Number(row.vat_rate)) * 100) / 100
        : null,
  };
}

const PRODUCT_COLUMNS = `
  p.id, p.name, p.slug, p.brand, p.barcode, p.image, p.description, p.currency, p.vat_rate,
  p.unit_price, p.total_price, p.qty_in_stock, p.discontinued, p.created_at,
  c.name AS category_name, c.slug AS category_slug,
  s.name AS subcategory_name, s.slug AS subcategory_slug,
  promo.promotion_id, promo.promotion_name, promo.discount_type, promo.discount_value, promo.promo_unit_price
`;

/**
 * GET /api/catalog/categories
 * The full category -> subcategory tree, with product counts, for nav and
 * the homepage's category-icon row. Discontinued products don't count.
 */
catalogPublicRouter.get('/categories', async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT c.id, c.name, c.slug, c.sort_order,
           s.id AS sub_id, s.name AS sub_name, s.slug AS sub_slug, s.sort_order AS sub_sort_order,
           count(p.id) FILTER (WHERE NOT p.discontinued) AS sub_product_count
    FROM categories c
    LEFT JOIN subcategories s ON s.category_id = c.id
    LEFT JOIN products p ON p.subcategory_id = s.id
    GROUP BY c.id, s.id
    ORDER BY c.sort_order, s.sort_order
  `);

  const categories = new Map();
  for (const row of rows) {
    if (!categories.has(row.id)) {
      categories.set(row.id, { id: row.id, name: row.name, slug: row.slug, productCount: 0, children: [] });
    }
    const cat = categories.get(row.id);
    if (row.sub_id) {
      const count = Number(row.sub_product_count);
      cat.children.push({ id: row.sub_id, name: row.sub_name, slug: row.sub_slug, productCount: count });
      cat.productCount += count;
    }
  }

  res.json({ ok: true, categories: [...categories.values()] });
});

const SORTS: Record<string, string> = {
  'price-asc': 'p.unit_price ASC NULLS LAST, p.id',
  'price-desc': 'p.unit_price DESC NULLS LAST, p.id',
  newest: 'p.created_at DESC, p.id DESC',
  relevance: 'p.id',
};

/**
 * GET /api/catalog/products
 * Search/filter/sort/paginate the live catalog. Every row carries its best
 * active promotion (if any) so product cards can show a discount badge
 * without a second request.
 */
catalogPublicRouter.get('/products', async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const categorySlug = typeof req.query.category === 'string' ? req.query.category : null;
  const subcategorySlug = typeof req.query.subcategory === 'string' ? req.query.subcategory : null;
  const brand = typeof req.query.brand === 'string' && req.query.brand ? req.query.brand : null;
  const minPrice = req.query.minPrice != null && req.query.minPrice !== '' ? Number(req.query.minPrice) : null;
  const maxPrice = req.query.maxPrice != null && req.query.maxPrice !== '' ? Number(req.query.maxPrice) : null;
  const sort = SORTS[String(req.query.sort)] ? String(req.query.sort) : 'relevance';
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(60, Math.max(1, Number(req.query.pageSize) || 24));
  const offset = (page - 1) * pageSize;

  const orderBy = search && sort === 'relevance' ? 'similarity(p.name, $1) DESC, p.id' : SORTS[sort];

  const whereClause = `
    WHERE NOT p.discontinued
      AND ($1 = '' OR p.name ILIKE '%' || $1 || '%' OR p.barcode ILIKE '%' || $1 || '%' OR p.description ILIKE '%' || $1 || '%' OR similarity(p.name, $1) > 0.2)
      AND ($2::text IS NULL OR c.slug = $2)
      AND ($3::text IS NULL OR s.slug = $3)
      AND ($6::text IS NULL OR p.brand = $6)
      AND ($7::numeric IS NULL OR p.unit_price >= $7)
      AND ($8::numeric IS NULL OR p.unit_price <= $8)
  `;
  const filterParams = [search, categorySlug, subcategorySlug, pageSize, offset, brand, minPrice, maxPrice];

  // Separate where-clause/params for the count query: it doesn't use LIMIT/OFFSET,
  // so $4/$5 never appear in its text - Postgres can't infer their type if they're
  // included in the params array (error 42P18), so this uses its own numbering.
  const countWhereClause = `
    WHERE NOT p.discontinued
      AND ($1 = '' OR p.name ILIKE '%' || $1 || '%' OR p.barcode ILIKE '%' || $1 || '%' OR p.description ILIKE '%' || $1 || '%' OR similarity(p.name, $1) > 0.2)
      AND ($2::text IS NULL OR c.slug = $2)
      AND ($3::text IS NULL OR s.slug = $3)
      AND ($4::text IS NULL OR p.brand = $4)
      AND ($5::numeric IS NULL OR p.unit_price >= $5)
      AND ($6::numeric IS NULL OR p.unit_price <= $6)
  `;
  const countParams = [search, categorySlug, subcategorySlug, brand, minPrice, maxPrice];

  const { rows: countRows } = await pool.query(
    `SELECT count(*) FROM products p
     JOIN subcategories s ON s.id = p.subcategory_id
     JOIN categories c ON c.id = s.category_id
     ${countWhereClause}`,
    countParams
  );

  const { rows } = await pool.query(
    `SELECT ${PRODUCT_COLUMNS}
     FROM products p
     JOIN subcategories s ON s.id = p.subcategory_id
     JOIN categories c ON c.id = s.category_id
     ${PROMO_JOIN}
     ${whereClause}
     ORDER BY ${orderBy}
     LIMIT $4 OFFSET $5`,
    filterParams
  );

  res.json({
    ok: true,
    products: rows.map(withPromoTotal),
    total: Number(countRows[0].count),
    page,
    pageSize,
  });
});

/**
 * GET /api/catalog/search-suggestions?q=
 * Powers the search-bar dropdown: a handful of matching brands, matching
 * category/subcategory paths, and a short product preview list (plus the
 * total match count, for a "see all N results" link) - all in one request
 * so the dropdown doesn't fire three round trips per keystroke.
 */
catalogPublicRouter.get('/search-suggestions', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q) {
    return res.json({ ok: true, brands: [], categories: [], products: [], descriptionMatches: [], total: 0 });
  }

  const [{ rows: brands }, { rows: categories }, { rows: countRows }, { rows: products }, { rows: descriptionMatches }] = await Promise.all([
    pool.query(
      `SELECT brand, count(*) AS count
       FROM products
       WHERE NOT discontinued AND brand ILIKE '%' || $1 || '%'
       GROUP BY brand ORDER BY count DESC, brand LIMIT 5`,
      [q]
    ),
    pool.query(
      `SELECT c.name AS category_name, c.slug AS category_slug, s.name AS subcategory_name, s.slug AS subcategory_slug
       FROM subcategories s
       JOIN categories c ON c.id = s.category_id
       WHERE s.name ILIKE '%' || $1 || '%' OR c.name ILIKE '%' || $1 || '%'
       ORDER BY s.name LIMIT 5`,
      [q]
    ),
    pool.query(
      `SELECT count(*) FROM products p
       WHERE NOT p.discontinued
         AND (p.name ILIKE '%' || $1 || '%' OR p.barcode ILIKE '%' || $1 || '%' OR similarity(p.name, $1) > 0.2)`,
      [q]
    ),
    pool.query(
      `SELECT ${PRODUCT_COLUMNS}
       FROM products p
       JOIN subcategories s ON s.id = p.subcategory_id
       JOIN categories c ON c.id = s.category_id
       ${PROMO_JOIN}
       WHERE NOT p.discontinued
         AND (p.name ILIKE '%' || $1 || '%' OR p.barcode ILIKE '%' || $1 || '%' OR similarity(p.name, $1) > 0.2)
       ORDER BY similarity(p.name, $1) DESC, p.id
       LIMIT 5`,
      [q]
    ),
    // Products that match only via their description, not name/barcode/similarity -
    // shown in their own "Description" section so it's clear why they turned up.
    pool.query(
      `SELECT ${PRODUCT_COLUMNS}
       FROM products p
       JOIN subcategories s ON s.id = p.subcategory_id
       JOIN categories c ON c.id = s.category_id
       ${PROMO_JOIN}
       WHERE NOT p.discontinued
         AND p.description ILIKE '%' || $1 || '%'
         AND NOT COALESCE(p.name ILIKE '%' || $1 || '%' OR p.barcode ILIKE '%' || $1 || '%' OR similarity(p.name, $1) > 0.2, false)
       ORDER BY p.id
       LIMIT 5`,
      [q]
    ),
  ]);

  res.json({
    ok: true,
    brands: brands.map((r) => ({ brand: r.brand, count: Number(r.count) })),
    categories,
    products: products.map(withPromoTotal),
    descriptionMatches: descriptionMatches.map(withPromoTotal),
    total: Number(countRows[0].count),
  });
});

/**
 * GET /api/catalog/brands?category=&subcategory=
 * Distinct brands (with product counts) in scope, for the filter sidebar -
 * computed over the whole category, not just the current page of results.
 */
catalogPublicRouter.get('/brands', async (req, res) => {
  const categorySlug = typeof req.query.category === 'string' ? req.query.category : null;
  const subcategorySlug = typeof req.query.subcategory === 'string' ? req.query.subcategory : null;

  const { rows } = await pool.query(
    `SELECT p.brand, count(*) AS count
     FROM products p
     JOIN subcategories s ON s.id = p.subcategory_id
     JOIN categories c ON c.id = s.category_id
     WHERE NOT p.discontinued AND p.brand IS NOT NULL
       AND ($1::text IS NULL OR c.slug = $1)
       AND ($2::text IS NULL OR s.slug = $2)
     GROUP BY p.brand
     ORDER BY count DESC, p.brand
     LIMIT 40`,
    [categorySlug, subcategorySlug]
  );

  res.json({ ok: true, brands: rows.map((r) => ({ brand: r.brand, count: Number(r.count) })) });
});

/**
 * GET /api/catalog/products/:slug
 * One product plus a handful of related products from the same subcategory.
 */
catalogPublicRouter.get('/products/:slug', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ${PRODUCT_COLUMNS}, s.id AS subcategory_id
     FROM products p
     JOIN subcategories s ON s.id = p.subcategory_id
     JOIN categories c ON c.id = s.category_id
     ${PROMO_JOIN}
     WHERE p.slug = $1
     LIMIT 1`,
    [req.params.slug]
  );

  const product = rows[0];
  if (!product) return res.status(404).json({ ok: false, error: 'Product not found.' });

  const { rows: related } = await pool.query(
    `SELECT p.id, p.name, p.slug, p.image, p.brand, p.unit_price, p.total_price, p.currency,
            p.qty_in_stock, p.discontinued, p.created_at
     FROM products p
     WHERE p.subcategory_id = $1 AND p.id <> $2 AND NOT p.discontinued
     ORDER BY random()
     LIMIT 8`,
    [product.subcategory_id, product.id]
  );

  res.json({ ok: true, product: withPromoTotal(product), related });
});

/**
 * GET /api/catalog/promotions
 * Active promotions right now (within their date window, if one is set),
 * each with its product list and the discounted price already computed.
 */
catalogPublicRouter.get('/promotions', async (_req, res) => {
  const { rows: promotions } = await pool.query(`
    SELECT id, name, slug, description, discount_type, discount_value, starts_at, ends_at, banner_image
    FROM promotions
    WHERE active
      AND (starts_at IS NULL OR starts_at <= now())
      AND (ends_at IS NULL OR ends_at >= now())
    ORDER BY created_at DESC
  `);

  const results = [];
  for (const promo of promotions) {
    const { rows: products } = await pool.query(
      `SELECT
         p.id, p.name, p.slug, p.brand, p.image, p.currency, p.qty_in_stock, p.discontinued, p.created_at,
         p.unit_price, p.total_price,
         CASE WHEN p.unit_price IS NULL THEN NULL
              WHEN $2 = 'percent' THEN ROUND(p.unit_price * (1 - $3 / 100.0), 2)
              ELSE GREATEST(p.unit_price - $3, 0)
         END AS promo_unit_price,
         p.vat_rate
       FROM promotion_products pp
       JOIN products p ON p.id = pp.product_id
       WHERE pp.promotion_id = $1 AND NOT p.discontinued`,
      [promo.id, promo.discount_type, promo.discount_value]
    );

    results.push({
      ...promo,
      products: products.map((p) => ({
        ...p,
        promotion_id: promo.id,
        promotion_name: promo.name,
        discount_type: promo.discount_type,
        discount_value: promo.discount_value,
        // Postgres numeric columns arrive as strings - Number() them before
        // arithmetic, or "1 + vatRateString" silently string-concatenates.
        promo_total_price:
          p.promo_unit_price != null
            ? Math.round(Number(p.promo_unit_price) * (1 + Number(p.vat_rate)) * 100) / 100
            : null,
      })),
    });
  }

  res.json({ ok: true, promotions: results });
});

/**
 * GET /api/catalog/most-viewed
 * The category with the most recorded product-page views, and its
 * most-viewed products within it - powers the homepage "Most viewed in X"
 * rail. There's no review/rating system, so real page-view counts (from
 * visitor tracking) stand in for "most rated". Returns category: null when
 * there's no view data yet.
 */
catalogPublicRouter.get('/most-viewed', async (_req, res) => {
  // Joins through the product itself rather than trusting page_views.category_id,
  // which is only populated for category/subcategory page views, not product ones.
  // "others" is the misc China-dropship catch-all, not a real merchandising
  // category, so it's excluded from ever being featured here.
  const { rows: topCategoryRows } = await pool.query(`
    SELECT c.id, c.name, c.slug, count(pv.id) AS views
    FROM page_views pv
    JOIN products p ON p.id = pv.product_id
    JOIN subcategories s ON s.id = p.subcategory_id
    JOIN categories c ON c.id = s.category_id
    WHERE pv.page_type = 'product' AND c.slug <> 'others'
    GROUP BY c.id, c.name, c.slug
    ORDER BY views DESC
    LIMIT 1
  `);

  const category = topCategoryRows[0];
  if (!category) {
    return res.json({ ok: true, category: null, products: [] });
  }

  // LEFT JOIN so the list always fills out to a real top-10 rather than only
  // showing the handful of products that happen to have a recorded view -
  // unviewed products rank after viewed ones (view_count 0), newest first.
  const { rows: ranked } = await pool.query(
    `SELECT p.id, count(pv.id) AS view_count
     FROM products p
     JOIN subcategories s ON s.id = p.subcategory_id
     LEFT JOIN page_views pv ON pv.product_id = p.id AND pv.page_type = 'product'
     WHERE s.category_id = $1 AND NOT p.discontinued
     GROUP BY p.id
     ORDER BY view_count DESC, p.created_at DESC, p.id
     LIMIT 10`,
    [category.id]
  );

  if (ranked.length === 0) {
    return res.json({ ok: true, category: null, products: [] });
  }

  const viewCounts = new Map(ranked.map((r) => [r.id, Number(r.view_count)]));
  const { rows: products } = await pool.query(
    `SELECT ${PRODUCT_COLUMNS}
     FROM products p
     JOIN subcategories s ON s.id = p.subcategory_id
     JOIN categories c ON c.id = s.category_id
     ${PROMO_JOIN}
     WHERE p.id = ANY($1::int[])`,
    [ranked.map((r) => r.id)]
  );

  const byId = new Map(products.map((p) => [p.id, withPromoTotal(p)]));
  const ordered = ranked.map((r) => ({ ...byId.get(r.id), view_count: viewCounts.get(r.id) })).filter((p) => p.id != null);

  res.json({
    ok: true,
    category: { id: category.id, name: category.name, slug: category.slug },
    products: ordered,
  });
});

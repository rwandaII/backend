-- Target Traders catalog schema
-- Mirrors the category -> subcategory -> product shape used by src/data/categories-menu.json

-- Powers fuzzy name matching for the Excel photo-import tool (similarity()).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS categories (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subcategories (
  id            SERIAL PRIMARY KEY,
  category_id   INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (category_id, slug)
);

CREATE TABLE IF NOT EXISTS products (
  id              SERIAL PRIMARY KEY,
  subcategory_id  INTEGER NOT NULL REFERENCES subcategories(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL,
  brand           TEXT,
  barcode         TEXT,
  -- unit_price is VAT-EXCLUSIVE (the base price). total_price is what the
  -- customer pays and is derived automatically - never entered by hand.
  unit_price      NUMERIC(12,2),
  vat_rate        NUMERIC(5,4) NOT NULL DEFAULT 0.18,
  total_price     NUMERIC(12,2) GENERATED ALWAYS AS (
                    CASE WHEN unit_price IS NULL THEN NULL
                    ELSE ROUND(unit_price * (1 + vat_rate), 2) END
                  ) STORED,
  currency        TEXT NOT NULL DEFAULT 'RWF',
  qty_in_stock    INTEGER NOT NULL DEFAULT 0,
  discontinued    BOOLEAN NOT NULL DEFAULT false,
  image           TEXT,
  description     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- CREATE TABLE IF NOT EXISTS is a no-op on a table that already exists, so
-- new columns need their own idempotent statement to reach it too.
ALTER TABLE products ADD COLUMN IF NOT EXISTS description TEXT;

CREATE INDEX IF NOT EXISTS idx_subcategories_category_id ON subcategories(category_id);
CREATE INDEX IF NOT EXISTS idx_products_subcategory_id ON products(subcategory_id);
CREATE INDEX IF NOT EXISTS idx_products_slug ON products(slug);
CREATE INDEX IF NOT EXISTS idx_products_name_trgm ON products USING gin (to_tsvector('simple', name));
CREATE INDEX IF NOT EXISTS idx_products_name_similarity ON products USING gin (name gin_trgm_ops);

-- Dashboard operators (email + password login for /admin).
CREATE TABLE IF NOT EXISTS admins (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'admin',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Storefront customers.
CREATE TABLE IF NOT EXISTS users (
  id                 SERIAL PRIMARY KEY,
  name               TEXT NOT NULL,
  email              TEXT NOT NULL UNIQUE,
  phone              TEXT,
  password_hash      TEXT,
  address            TEXT,
  district           TEXT,
  email_verified_at  TIMESTAMPTZ,
  phone_verified_at  TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL;

-- Email/SMS verification and password-reset codes. The raw code/token is
-- never stored - only its hash - so a database dump can't be used to log in.
CREATE TABLE IF NOT EXISTS verification_codes (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel      TEXT NOT NULL, -- 'email' | 'phone'
  purpose      TEXT NOT NULL, -- 'verify' | 'password_reset'
  code_hash    TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_verification_codes_lookup
  ON verification_codes(user_id, channel, purpose, created_at DESC);

-- Orders (replaces the earlier JSON-file store). One row per checkout
-- attempt; cart is the priced snapshot at the moment of purchase so later
-- catalog price changes never retroactively change a past order.
CREATE TABLE IF NOT EXISTS orders (
  id                 SERIAL PRIMARY KEY,
  tx_ref             TEXT NOT NULL UNIQUE,
  idempotency_key    TEXT UNIQUE,
  status             TEXT NOT NULL DEFAULT 'pending', -- pending | paid | failed | mismatch
  provider           TEXT NOT NULL,                   -- 'flutterwave' | 'paypack'
  provider_ref       TEXT,
  payment_type       TEXT,
  failure_reason     TEXT,
  customer_name      TEXT NOT NULL,
  customer_email     TEXT NOT NULL,
  customer_phone     TEXT NOT NULL,
  customer_address   TEXT NOT NULL,
  customer_district  TEXT NOT NULL,
  customer_notes     TEXT,
  cart               JSONB NOT NULL,
  -- Exact response returned to the client that created this order, replayed
  -- verbatim on an Idempotency-Key retry so we never call the payment
  -- provider (and never prompt/charge the customer) a second time.
  checkout_response  JSONB,
  user_id            INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS checkout_response JSONB;

CREATE INDEX IF NOT EXISTS idx_orders_tx_ref ON orders(tx_ref);
CREATE INDEX IF NOT EXISTS idx_orders_provider_ref ON orders(provider_ref);
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);

-- Append-only audit trail. Every status transition gets a row here instead
-- of just being overwritten on `orders` - needed to investigate disputes.
CREATE TABLE IF NOT EXISTS order_events (
  id           SERIAL PRIMARY KEY,
  order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  event_type   TEXT NOT NULL,
  from_status  TEXT,
  to_status    TEXT,
  detail       JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_events_order_id ON order_events(order_id);

-- Promotions: a named discount campaign applied to a hand-picked set of
-- products. discount_value is a percent (0-100) or a flat RWF amount off
-- unit_price, chosen by discount_type - applied before VAT, same as
-- unit_price itself, so the 18% still lands on top of the discounted price.
CREATE TABLE IF NOT EXISTS promotions (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL UNIQUE,
  description     TEXT,
  discount_type   TEXT NOT NULL DEFAULT 'percent', -- 'percent' | 'fixed'
  discount_value  NUMERIC(12,2) NOT NULL,
  starts_at       TIMESTAMPTZ,
  ends_at         TIMESTAMPTZ,
  active          BOOLEAN NOT NULL DEFAULT true,
  banner_image    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS promotion_products (
  promotion_id  INTEGER NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (promotion_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_promotion_products_product_id ON promotion_products(product_id);
CREATE INDEX IF NOT EXISTS idx_promotions_active_window ON promotions(active, starts_at, ends_at);

-- Anonymous site visitors, identified by a random id stored in a cookie.
-- Not linked to `users` by default - most visitors never create an account,
-- and analytics should keep working for them.
CREATE TABLE IF NOT EXISTS visitors (
  id             SERIAL PRIMARY KEY,
  visitor_key    TEXT NOT NULL UNIQUE,
  user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_agent     TEXT
);

-- One row per page viewed. category_id/subcategory_id/product_id use
-- ON DELETE SET NULL rather than CASCADE (unlike the rest of this schema):
-- deleting a product should not erase the historical fact that it was
-- viewed N times - that history is the whole point of this table.
CREATE TABLE IF NOT EXISTS page_views (
  id              SERIAL PRIMARY KEY,
  visitor_id      INTEGER NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,
  path            TEXT NOT NULL,
  page_type       TEXT NOT NULL, -- 'home' | 'category' | 'subcategory' | 'product' | 'cart' | 'other'
  category_id     INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  subcategory_id  INTEGER REFERENCES subcategories(id) ON DELETE SET NULL,
  product_id      INTEGER REFERENCES products(id) ON DELETE SET NULL,
  referrer        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_page_views_visitor_id ON page_views(visitor_id);
CREATE INDEX IF NOT EXISTS idx_page_views_product_id ON page_views(product_id);
CREATE INDEX IF NOT EXISTS idx_page_views_created_at ON page_views(created_at);

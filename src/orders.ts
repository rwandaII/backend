import { randomUUID } from 'node:crypto';
import { pool } from './db.js';
import type { PricedCart } from './pricing.js';
import type { PaymentProviderKey } from './payments/types.js';

/**
 * Orders live in Postgres (previously a JSON file - see git history). Every
 * status transition also writes a row to order_events, an append-only audit
 * trail, instead of just being overwritten in place.
 */

export type OrderStatus =
  | 'pending' // created, customer sent to pay, no result yet
  | 'paid' // verified successful with the payment provider
  | 'failed' // customer abandoned or payment declined
  | 'mismatch'; // paid, but amount/currency did not match - needs a human

export interface Customer {
  name: string;
  email: string;
  phone: string;
  address: string;
  district: string;
  notes?: string;
}

export interface Order {
  id: string;
  txRef: string;
  status: OrderStatus;
  provider: PaymentProviderKey;
  customer: Customer;
  cart: PricedCart;
  createdAt: string;
  updatedAt: string;
  providerRef?: string;
  paymentType?: string;
  failureReason?: string;
  reviewedAt?: string;
  reviewedBy?: number;
}

interface OrderRow {
  id: number;
  tx_ref: string;
  status: OrderStatus;
  provider: PaymentProviderKey;
  provider_ref: string | null;
  payment_type: string | null;
  failure_reason: string | null;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  customer_address: string;
  customer_district: string;
  customer_notes: string | null;
  cart: PricedCart;
  checkout_response: unknown;
  reviewed_at: string | null;
  reviewed_by: number | null;
  created_at: string;
  updated_at: string;
}

function toOrder(row: OrderRow): Order {
  return {
    id: String(row.id),
    txRef: row.tx_ref,
    status: row.status,
    provider: row.provider,
    providerRef: row.provider_ref ?? undefined,
    paymentType: row.payment_type ?? undefined,
    failureReason: row.failure_reason ?? undefined,
    reviewedAt: row.reviewed_at ?? undefined,
    reviewedBy: row.reviewed_by ?? undefined,
    customer: {
      name: row.customer_name,
      email: row.customer_email,
      phone: row.customer_phone,
      address: row.customer_address,
      district: row.customer_district,
      notes: row.customer_notes ?? undefined,
    },
    cart: row.cart,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Unique per transaction. Payment providers reject a reused reference. */
export function newTxRef(): string {
  return `TT-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

/**
 * Look up a previous order by its Idempotency-Key before doing anything that
 * talks to a payment provider. The caller replays checkoutResponse verbatim
 * on a match, so a retried request never triggers a second charge/SMS-prompt.
 */
export async function findByIdempotencyKey(
  key: string
): Promise<{ order: Order; checkoutResponse: unknown } | null> {
  const { rows } = await pool.query<OrderRow>(`SELECT * FROM orders WHERE idempotency_key = $1`, [key]);
  const row = rows[0];
  if (!row) return null;
  return { order: toOrder(row), checkoutResponse: row.checkout_response };
}

export async function createOrder(input: {
  txRef: string;
  provider: PaymentProviderKey;
  providerRef?: string;
  customer: Customer;
  cart: PricedCart;
  idempotencyKey?: string;
  checkoutResponse: unknown;
}): Promise<Order> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query<OrderRow>(
      `INSERT INTO orders
        (tx_ref, idempotency_key, provider, provider_ref,
         customer_name, customer_email, customer_phone, customer_address, customer_district, customer_notes,
         cart, checkout_response)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        input.txRef,
        input.idempotencyKey ?? null,
        input.provider,
        input.providerRef ?? null,
        input.customer.name,
        input.customer.email,
        input.customer.phone,
        input.customer.address,
        input.customer.district,
        input.customer.notes ?? null,
        JSON.stringify(input.cart),
        JSON.stringify(input.checkoutResponse),
      ]
    );

    const order = rows[0];
    await client.query(
      `INSERT INTO order_events (order_id, event_type, to_status, detail)
       VALUES ($1, 'created', 'pending', $2)`,
      [order.id, JSON.stringify({ provider: input.provider })]
    );

    await client.query('COMMIT');
    return toOrder(order);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function findByTxRef(txRef: string): Promise<Order | null> {
  const { rows } = await pool.query<OrderRow>(`SELECT * FROM orders WHERE tx_ref = $1`, [txRef]);
  return rows[0] ? toOrder(rows[0]) : null;
}

export async function findByProviderRef(providerRef: string): Promise<Order | null> {
  const { rows } = await pool.query<OrderRow>(`SELECT * FROM orders WHERE provider_ref = $1`, [providerRef]);
  return rows[0] ? toOrder(rows[0]) : null;
}

export async function updateOrder(
  txRef: string,
  patch: Partial<Pick<Order, 'status' | 'providerRef' | 'paymentType' | 'failureReason'>>
): Promise<Order | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const before = await client.query<OrderRow>(`SELECT * FROM orders WHERE tx_ref = $1 FOR UPDATE`, [txRef]);
    const prev = before.rows[0];
    if (!prev) {
      await client.query('ROLLBACK');
      return null;
    }

    const { rows } = await client.query<OrderRow>(
      `UPDATE orders SET
         status = COALESCE($2, status),
         provider_ref = COALESCE($3, provider_ref),
         payment_type = COALESCE($4, payment_type),
         failure_reason = COALESCE($5, failure_reason),
         updated_at = now()
       WHERE tx_ref = $1
       RETURNING *`,
      [txRef, patch.status ?? null, patch.providerRef ?? null, patch.paymentType ?? null, patch.failureReason ?? null]
    );

    const updated = rows[0];
    if (patch.status && patch.status !== prev.status) {
      await client.query(
        `INSERT INTO order_events (order_id, event_type, from_status, to_status, detail)
         VALUES ($1, 'status_changed', $2, $3, $4)`,
        [updated.id, prev.status, patch.status, JSON.stringify({ providerRef: patch.providerRef, failureReason: patch.failureReason })]
      );
    }

    await client.query('COMMIT');
    return toOrder(updated);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function listOrders(): Promise<Order[]> {
  const { rows } = await pool.query<OrderRow>(`SELECT * FROM orders ORDER BY created_at DESC`);
  return rows.map(toOrder);
}

/**
 * Mark a paid order as reviewed - the dashboard "Approve" action. Records
 * which admin did it, and writes an order_events row for the audit trail.
 * Only makes sense for a 'paid' order, but doesn't hard-block other
 * statuses - an admin correcting a mistake shouldn't be fought by the API.
 */
export async function markOrderReviewed(txRef: string, adminId: number): Promise<Order | null> {
  const { rows } = await pool.query<OrderRow>(
    `UPDATE orders SET reviewed_at = now(), reviewed_by = $2, updated_at = now()
     WHERE tx_ref = $1
     RETURNING *`,
    [txRef, adminId]
  );
  const updated = rows[0];
  if (!updated) return null;

  await pool.query(
    `INSERT INTO order_events (order_id, event_type, detail) VALUES ($1, 'reviewed', $2)`,
    [updated.id, JSON.stringify({ adminId })]
  );

  return toOrder(updated);
}

/** Paid orders nobody has acknowledged yet - drives the admin dashboard's notification badge. */
export async function countUnreviewedOrders(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*) FROM orders WHERE status = 'paid' AND reviewed_at IS NULL`
  );
  return Number(rows[0]?.count ?? 0);
}

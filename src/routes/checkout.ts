import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { priceCart, CheckoutError, type CartLineInput } from '../pricing.js';
import { createOrder, newTxRef, findByTxRef, findByIdempotencyKey } from '../orders.js';
import { getProvider, isValidProviderKey } from '../payments/index.js';
import { settleOrder } from '../settle.js';
import { normalisePhone } from '../phone.js';

export const checkoutRouter = Router();

const sessionSchema = z.object({
  provider: z.string().refine(isValidProviderKey, 'Unknown payment provider.').default('call'),
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email(),
  phone: z.string().trim().min(1),
  address: z.string().trim().min(1).max(500),
  district: z.string().trim().min(1).max(100),
  notes: z.string().trim().max(500).optional(),
  items: z.array(z.object({ id: z.string(), quantity: z.unknown() })).optional(),
});

/** Translates the first Zod issue into the same {code, message} shape the frontend already handles. */
function toCheckoutError(error: z.ZodError): CheckoutError {
  const issue = error.issues[0];
  const field = String(issue.path[0] ?? 'field');
  const label: Record<string, string> = {
    name: 'Full name',
    email: 'Email',
    phone: 'Phone number',
    address: 'Delivery address',
    district: 'District',
    notes: 'Notes',
    provider: 'Payment method',
  };
  const fieldLabel = label[field] ?? field;

  if (field === 'email') {
    return new CheckoutError('That email address does not look valid.', 'BAD_EMAIL');
  }
  if (field === 'provider') {
    return new CheckoutError('Unknown payment method.', 'BAD_PROVIDER');
  }
  if (issue.code === 'too_big') {
    return new CheckoutError(`${fieldLabel} is too long.`, 'FIELD_TOO_LONG');
  }
  return new CheckoutError(`${fieldLabel} is required.`, 'MISSING_FIELD');
}

/**
 * POST /api/checkout/quote
 * Recalculates the cart server-side so the customer sees the real total
 * (including delivery) before committing. No order is created.
 */
checkoutRouter.post('/quote', (req, res) => {
  try {
    const cart = priceCart(req.body?.items as CartLineInput[]);
    res.json({ ok: true, cart });
  } catch (err) {
    handleError(err, res);
  }
});

/**
 * POST /api/checkout/session
 * Creates the order and returns either a hosted payment link to redirect to
 * (Flutterwave) or confirmation that a payment prompt was pushed to the
 * customer's phone (Paypack).
 *
 * Send an `Idempotency-Key` header to make retries safe: a repeated request
 * with the same key replays the original response instead of creating a
 * second order or prompting/charging the customer again.
 */
checkoutRouter.post('/session', async (req, res) => {
  try {
    const idempotencyKey = req.header('Idempotency-Key')?.trim() || undefined;

    if (idempotencyKey) {
      const existing = await findByIdempotencyKey(idempotencyKey);
      if (existing) return res.json(existing.checkoutResponse);
    }

    const parsed = sessionSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw toCheckoutError(parsed.error);
    const { provider: providerKey, name, email, address, district, notes } = parsed.data;

    const phone = normalisePhone(parsed.data.phone);
    if (!phone) {
      throw new CheckoutError('Enter a Rwandan mobile number, e.g. 0788123456.', 'BAD_PHONE');
    }

    const customer = { name, email, phone, address, district, notes };

    // Prices come from the catalog, never from the request body.
    const cart = priceCart(req.body?.items as CartLineInput[]);

    const provider = getProvider(providerKey);
    const txRef = newTxRef();

    const initResult = await provider.initiate({
      txRef,
      amount: cart.total,
      currency: cart.currency,
      redirectUrl: `${config.serverUrl}/api/checkout/callback`,
      customer: { email: customer.email, name: customer.name, phone: customer.phone },
      meta: { district: customer.district },
    });

    const checkoutResponse =
      initResult.mode === 'redirect'
        ? { ok: true, mode: 'redirect' as const, paymentLink: initResult.paymentLink, txRef, total: cart.total }
        : initResult.mode === 'push'
          ? { ok: true, mode: 'push' as const, message: initResult.message, txRef, total: cart.total }
          : { ok: true, mode: 'call' as const, phone: initResult.phone, message: initResult.message, txRef, total: cart.total };

    await createOrder({
      txRef,
      provider: provider.key,
      providerRef: initResult.mode === 'push' ? initResult.providerRef : undefined,
      customer,
      cart,
      idempotencyKey,
      checkoutResponse,
    });

    res.json(checkoutResponse);
  } catch (err) {
    handleError(err, res);
  }
});

/**
 * GET /api/checkout/callback
 * Where Flutterwave sends the customer's browser after payment. We verify,
 * then bounce them to the React result page.
 *
 * This is a convenience path only - the webhook is the reliable one, because
 * a customer can close the tab before ever hitting this. Paypack has no
 * equivalent redirect; its result page relies on polling GET /order/:txRef.
 */
checkoutRouter.get('/callback', async (req, res) => {
  const status = String(req.query.status ?? '');
  const txRef = String(req.query.tx_ref ?? '');
  const transactionId = String(req.query.transaction_id ?? '');

  const done = (state: string) =>
    res.redirect(`${config.clientUrl}/payment/${state}?ref=${encodeURIComponent(txRef)}`);

  if (!txRef) return done('failed');

  if (status !== 'successful' || !transactionId) {
    const order = await findByTxRef(txRef);
    if (order?.status === 'pending') {
      const { updateOrder } = await import('../orders.js');
      await updateOrder(txRef, { status: 'failed', failureReason: status || 'cancelled' });
    }
    return done('failed');
  }

  try {
    const order = await settleOrder(txRef, transactionId);
    return done(order?.status === 'paid' ? 'success' : 'failed');
  } catch (err) {
    console.error('callback verification failed:', err);
    // Payment may still be fine - the webhook will settle it. Don't tell the
    // customer it failed; tell them we're checking.
    return done('pending');
  }
});

/**
 * GET /api/checkout/order/:txRef
 * Lets the result page show what was actually ordered. For Paypack this is
 * also how the frontend polls for the outcome, since there's no redirect.
 */
checkoutRouter.get('/order/:txRef', async (req, res) => {
  const order = await findByTxRef(req.params.txRef);
  if (!order) {
    return res.status(404).json({ ok: false, error: 'Order not found.' });
  }
  res.json({
    ok: true,
    order: {
      txRef: order.txRef,
      status: order.status,
      provider: order.provider,
      total: order.cart.total,
      currency: order.cart.currency,
      lines: order.cart.lines,
      createdAt: order.createdAt,
    },
  });
});

function handleError(err: unknown, res: import('express').Response): void {
  if (err instanceof CheckoutError) {
    res.status(err.status).json({ ok: false, code: err.code, error: err.message });
    return;
  }
  console.error('checkout error:', err);
  res.status(500).json({
    ok: false,
    code: 'SERVER_ERROR',
    error: 'Something went wrong on our side. Please try again.',
  });
}

import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { settleOrder } from '../settle.js';
import { findByProviderRef } from '../orders.js';

export const webhookRouter = Router();

function timingSafeMatches(received: string | undefined, expected: string): boolean {
  if (!received || !expected) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * POST /api/webhook/flutterwave
 *
 * The authoritative notification channel. Unlike the browser redirect, this
 * arrives even if the customer closes the tab the instant they pay.
 *
 * Set the same secret hash under Settings -> Webhooks in your Flutterwave
 * dashboard and in FLW_SECRET_HASH.
 */
webhookRouter.post('/flutterwave', async (req, res) => {
  if (!timingSafeMatches(req.header('verif-hash'), config.flw.secretHash)) {
    console.warn('webhook: rejected - bad or missing verif-hash header');
    return res.status(401).send('unauthorised');
  }

  // Acknowledge immediately. Flutterwave retries on non-2xx, and we do not
  // want a slow verification call to trigger duplicate deliveries.
  res.status(200).send('ok');

  const payload = req.body ?? {};
  const data = payload.data ?? {};
  const txRef: string | undefined = data.tx_ref;
  const transactionId: number | undefined = data.id;

  if (!txRef || !transactionId) {
    console.warn('webhook: payload missing tx_ref or id', payload.event);
    return;
  }

  try {
    await settleOrder(txRef, String(transactionId));
  } catch (err) {
    console.error(`webhook: failed to settle ${txRef}`, err);
  }
});

/**
 * POST /api/webhook/paypack
 *
 * Paypack has no hosted redirect - this webhook (plus polling
 * GET /api/checkout/order/:txRef) is how a push payment gets confirmed.
 *
 * Paypack's payload signing scheme isn't as clearly documented as
 * Flutterwave's, so this does NOT trust the payload's claimed status at all -
 * it only extracts the transaction `ref` and asks Paypack directly via
 * settleOrder -> provider.verify(). A forged call here can at most trigger an
 * early (harmless) status check, never a fake "paid" result.
 *
 * If you configured PAYPACK_WEBHOOK_TOKEN, set your Paypack webhook URL to
 * include it as a query string, e.g. https://your-host/api/webhook/paypack?token=...
 */
webhookRouter.post('/paypack', async (req, res) => {
  if (config.paypack.webhookToken && !timingSafeMatches(String(req.query.token ?? ''), config.paypack.webhookToken)) {
    console.warn('webhook: rejected paypack call - bad or missing token');
    return res.status(401).send('unauthorised');
  }

  res.status(200).send('ok');

  const payload = req.body ?? {};
  const providerRef: string | undefined = payload.ref ?? payload.data?.ref ?? payload.transaction?.ref;

  if (!providerRef) {
    console.warn('webhook: paypack payload missing ref');
    return;
  }

  try {
    const order = await findByProviderRef(providerRef);
    if (!order) {
      console.warn(`webhook: no order for paypack ref ${providerRef}`);
      return;
    }
    await settleOrder(order.txRef, providerRef);
  } catch (err) {
    console.error(`webhook: failed to settle paypack ref ${providerRef}`, err);
  }
});

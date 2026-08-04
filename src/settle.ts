import { getProvider } from './payments/index.js';
import { findByTxRef, updateOrder, type Order } from './orders.js';

/**
 * Confirms an order against its payment provider and records the outcome.
 *
 * Both the webhook and the browser redirect (Flutterwave) or webhook-only
 * (Paypack) call this. It is idempotent: whichever arrives first wins, the
 * second is a no-op. That matters because they routinely arrive in either
 * order, and sometimes twice.
 */
export async function settleOrder(txRef: string, providerRef: string): Promise<Order | null> {
  const order = await findByTxRef(txRef);
  if (!order) {
    console.warn(`settle: no order for tx_ref ${txRef}`);
    return null;
  }

  // Already resolved - don't re-process, don't re-ship, don't double-count.
  if (order.status !== 'pending') return order;

  const provider = getProvider(order.provider);
  const tx = await provider.verify(providerRef);

  if (tx.status !== 'successful') {
    return updateOrder(txRef, {
      status: 'failed',
      providerRef: tx.providerRef,
      failureReason: tx.status,
    });
  }

  // The customer could have tampered with the amount on the way to the
  // payment page, so check what was actually paid against what we charged.
  const amountOk = Number(tx.amount) >= order.cart.total;
  const currencyOk = tx.currency === order.cart.currency;
  const refOk = tx.txRef === undefined || tx.txRef === order.txRef;

  if (!amountOk || !currencyOk || !refOk) {
    console.error(
      `settle: MISMATCH on ${txRef} - expected ${order.cart.total} ${order.cart.currency}, ` +
        `got ${tx.amount} ${tx.currency} (provider ref ${tx.providerRef})`
    );
    return updateOrder(txRef, {
      status: 'mismatch',
      providerRef: tx.providerRef,
      paymentType: tx.paymentType,
      failureReason: `Paid ${tx.amount} ${tx.currency}, expected ${order.cart.total} ${order.cart.currency}`,
    });
  }

  console.log(`settle: order ${txRef} PAID (${tx.amount} ${tx.currency} via ${order.provider}${tx.paymentType ? '/' + tx.paymentType : ''})`);

  // TODO: decrement stock here, inside the same transaction as the status
  // update, and send the confirmation SMS/email.
  return updateOrder(txRef, {
    status: 'paid',
    providerRef: tx.providerRef,
    paymentType: tx.paymentType,
  });
}

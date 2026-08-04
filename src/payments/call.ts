import { config } from '../config.js';
import type { PaymentProvider } from './types.js';

/**
 * Not a real payment gateway - online payment isn't configured yet (no valid
 * Flutterwave/Paypack credentials). Checkout creates the order directly and
 * tells the customer to call in; stock gets confirmed and payment taken
 * manually. Swap the default provider in routes/checkout.ts back once real
 * credentials are wired up.
 */
export const callProvider: PaymentProvider = {
  key: 'call',
  async initiate() {
    return {
      mode: 'call',
      phone: config.orderPhone,
      message: `Call ${config.orderPhone} to confirm stock and complete payment for your order.`,
    };
  },
  async verify() {
    throw new Error('callProvider has no online verification - these orders are confirmed manually, never via webhook.');
  },
};

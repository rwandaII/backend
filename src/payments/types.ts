export type PaymentProviderKey = 'flutterwave' | 'paypack' | 'call';

export interface PaymentCustomer {
  email: string;
  name: string;
  phone: string;
}

export interface InitiatePaymentArgs {
  txRef: string;
  amount: number;
  currency: string;
  customer: PaymentCustomer;
  /** Used by redirect-style providers (Flutterwave); ignored by push providers. */
  redirectUrl: string;
  meta?: Record<string, unknown>;
}

/**
 * Redirect providers (Flutterwave) send the customer to a hosted page and we
 * only learn their transaction id later, via webhook/redirect callback.
 * Push providers (Paypack) prompt the customer's phone directly and hand back
 * their own reference immediately, before payment is confirmed.
 * "call" isn't a real gateway - no online payment is taken; the customer is
 * told to call in to confirm stock and complete payment manually.
 */
export type PaymentInitResult =
  | { mode: 'redirect'; paymentLink: string }
  | { mode: 'push'; message: string; providerRef: string }
  | { mode: 'call'; phone: string; message: string };

export interface VerifiedPayment {
  providerRef: string;
  amount: number;
  currency: string;
  status: 'successful' | 'failed' | 'pending';
  paymentType?: string;
  /** Present for providers whose verify response echoes our own tx_ref back. */
  txRef?: string;
  raw?: unknown;
}

export interface PaymentProvider {
  key: PaymentProviderKey;
  initiate(args: InitiatePaymentArgs): Promise<PaymentInitResult>;
  verify(providerRef: string): Promise<VerifiedPayment>;
}

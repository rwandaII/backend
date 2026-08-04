import { config } from '../config.js';
import type { PaymentProvider, InitiatePaymentArgs, PaymentInitResult, VerifiedPayment } from './types.js';

/**
 * Thin wrapper over the Flutterwave v3 REST API.
 *
 * We call the API directly with fetch rather than using flutterwave-node-v3:
 * fewer dependencies, and the two endpoints we need are simple.
 */

interface FlwEnvelope<T> {
  status: 'success' | 'error';
  message: string;
  data: T;
}

interface VerifiedTransaction {
  id: number;
  tx_ref: string;
  amount: number;
  currency: string;
  status: string;
  payment_type: string;
  processor_response?: string;
  customer: { email: string; name: string; phone_number: string };
}

async function flwRequest<T>(path: string, init: RequestInit = {}): Promise<FlwEnvelope<T>> {
  const res = await fetch(`${config.flw.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.flw.secretKey}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  const body = (await res.json().catch(() => null)) as FlwEnvelope<T> | null;

  if (!body) {
    throw new Error(`Flutterwave returned a non-JSON response (HTTP ${res.status}).`);
  }
  if (!res.ok || body.status !== 'success') {
    throw new Error(`Flutterwave: ${body.message ?? `HTTP ${res.status}`}`);
  }
  return body;
}

export const flutterwaveProvider: PaymentProvider = {
  key: 'flutterwave',

  /**
   * Creates a hosted checkout session. Returns the URL to send the customer
   * to, where they can pay with MTN MoMo, Airtel Money, or a Visa/Mastercard.
   */
  async initiate(args: InitiatePaymentArgs): Promise<PaymentInitResult> {
    const body = await flwRequest<{ link: string }>('/payments', {
      method: 'POST',
      body: JSON.stringify({
        tx_ref: args.txRef,
        amount: String(args.amount),
        currency: args.currency,
        redirect_url: args.redirectUrl,
        customer: {
          email: args.customer.email,
          name: args.customer.name,
          phonenumber: args.customer.phone,
        },
        meta: args.meta ?? {},
        customizations: {
          title: config.storeName,
          description: 'Pharmacy & baby care order',
        },
        configurations: {
          session_duration: 30, // minutes before the payment page expires
          max_retry_attempt: 3,
        },
      }),
    });

    return { mode: 'redirect', paymentLink: body.data.link };
  },

  /**
   * Asks Flutterwave what actually happened. Never trust the redirect query
   * params or the webhook body alone - both are attacker-reachable. This call
   * is the only authoritative answer.
   */
  async verify(transactionId: string): Promise<VerifiedPayment> {
    const body = await flwRequest<VerifiedTransaction>(`/transactions/${transactionId}/verify`);
    const tx = body.data;
    return {
      providerRef: String(tx.id),
      amount: Number(tx.amount),
      currency: tx.currency,
      status: tx.status === 'successful' ? 'successful' : 'failed',
      paymentType: tx.payment_type,
      txRef: tx.tx_ref,
      raw: tx,
    };
  },
};

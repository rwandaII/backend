import { config } from '../config.js';
import type { PaymentProvider, InitiatePaymentArgs, PaymentInitResult, VerifiedPayment } from './types.js';

/**
 * Paypack (payments.paypack.rw) - direct MTN/Airtel Mobile Money in Rwanda.
 * No cards, no hosted page: a "cashin" request pushes an approval prompt
 * straight to the customer's phone, and we poll/verify their transaction
 * `ref` afterwards. Offered alongside Flutterwave so customers can pick
 * whichever they prefer at checkout.
 *
 * NOTE: verify against Paypack's current API docs before relying on this in
 * production - endpoint shapes below reflect their documented v2 API as of
 * this writing, but this integration has not been tested against a live
 * Paypack account.
 */

interface PaypackAuthResponse {
  access: string;
  refresh: string;
  expires: string;
}

interface PaypackCashinResponse {
  ref: string;
  status: string;
  amount: number;
}

interface PaypackFindResponse {
  ref: string;
  amount: number;
  fee: number;
  status: string; // 'pending' | 'successful' | 'failed'
  kind: string;
  client: { phone: string };
  created_at: string;
  updated_at: string;
}

let cachedToken: { access: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 5_000) {
    return cachedToken.access;
  }

  const res = await fetch(`${config.paypack.baseUrl}/auth/agents/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: config.paypack.clientId,
      client_secret: config.paypack.clientSecret,
    }),
  });

  const body = (await res.json().catch(() => null)) as PaypackAuthResponse | null;
  if (!res.ok || !body?.access) {
    throw new Error(`Paypack auth failed (HTTP ${res.status}).`);
  }

  const expiresAt = Date.parse(body.expires);
  cachedToken = { access: body.access, expiresAt: Number.isNaN(expiresAt) ? Date.now() + 60_000 : expiresAt };
  return body.access;
}

async function paypackRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${config.paypack.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Paypack: ${(body as { message?: string } | null)?.message ?? `HTTP ${res.status}`}`);
  }
  return body as T;
}

/** Paypack expects a local 07xxxxxxxx MSISDN, not the +250 form used elsewhere in this app. */
function toPaypackPhone(phone: string): string {
  const digits = phone.replace(/[^\d]/g, '');
  if (digits.startsWith('250') && digits.length === 12) return `0${digits.slice(3)}`;
  if (digits.length === 9) return `0${digits}`;
  return digits;
}

export const paypackProvider: PaymentProvider = {
  key: 'paypack',

  async initiate(args: InitiatePaymentArgs): Promise<PaymentInitResult> {
    const tx = await paypackRequest<PaypackCashinResponse>('/transactions/cashin', {
      method: 'POST',
      body: JSON.stringify({
        amount: Math.round(args.amount),
        number: toPaypackPhone(args.customer.phone),
        environment: config.paypack.environment,
      }),
    });

    return {
      mode: 'push',
      message: 'A payment request was sent to your phone. Approve it there to complete your order.',
      providerRef: tx.ref,
    };
  },

  async verify(providerRef: string): Promise<VerifiedPayment> {
    const tx = await paypackRequest<PaypackFindResponse>(`/transactions/find/${providerRef}`);
    const status: VerifiedPayment['status'] =
      tx.status === 'successful' ? 'successful' : tx.status === 'failed' ? 'failed' : 'pending';

    return {
      providerRef: tx.ref,
      amount: Number(tx.amount),
      currency: 'RWF',
      status,
      raw: tx,
    };
  },
};

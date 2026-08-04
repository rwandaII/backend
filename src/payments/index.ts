import type { PaymentProvider, PaymentProviderKey } from './types.js';
import { flutterwaveProvider } from './flutterwave.js';
import { paypackProvider } from './paypack.js';
import { callProvider } from './call.js';

const providers: Record<PaymentProviderKey, PaymentProvider> = {
  flutterwave: flutterwaveProvider,
  paypack: paypackProvider,
  call: callProvider,
};

export function getProvider(key: string): PaymentProvider {
  const provider = providers[key as PaymentProviderKey];
  if (!provider) {
    throw new Error(`Unknown payment provider "${key}". Expected one of: ${Object.keys(providers).join(', ')}.`);
  }
  return provider;
}

export function isValidProviderKey(key: unknown): key is PaymentProviderKey {
  return typeof key === 'string' && key in providers;
}

export * from './types.js';

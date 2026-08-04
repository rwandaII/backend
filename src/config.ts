import 'dotenv/config';

function str(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    throw new Error(
      `Missing environment variable ${name}. Copy server/.env.example to server/.env and fill it in.`
    );
  }
  return v;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (Number.isNaN(n)) throw new Error(`Environment variable ${name} must be a number, got "${raw}"`);
  return n;
}

export const config = {
  port: num('PORT', 4000),

  databaseUrl: str('DATABASE_URL', 'postgresql://target_traders:target_traders@localhost:5432/target_traders'),
  adminJwtSecret: str('ADMIN_JWT_SECRET', ''),

  flw: {
    secretKey: str('FLW_SECRET_KEY', ''),
    secretHash: str('FLW_SECRET_HASH', ''),
    baseUrl: 'https://api.flutterwave.com/v3',
  },

  paypack: {
    clientId: str('PAYPACK_CLIENT_ID', ''),
    clientSecret: str('PAYPACK_CLIENT_SECRET', ''),
    baseUrl: str('PAYPACK_BASE_URL', 'https://payments.paypack.rw/api'),
    // Paypack's API literally spells this "developement" (their typo) - kept
    // configurable so a future API fix doesn't require a code change.
    environment: str('PAYPACK_ENVIRONMENT', 'developement'),
    webhookToken: str('PAYPACK_WEBHOOK_TOKEN', ''),
  },

  resend: {
    apiKey: str('RESEND_API_KEY', ''),
    // Resend's shared test domain - works with no DNS setup, but in that mode
    // Resend only delivers to the email address your Resend account itself
    // was signed up with.
    fromEmail: str('EMAIL_FROM', 'Target Traders <onboarding@resend.dev>'),
  },

  africastalking: {
    apiKey: str('AT_API_KEY', ''),
    username: str('AT_USERNAME', 'sandbox'),
    senderId: str('AT_SENDER_ID', ''),
  },

  userJwtSecret: str('USER_JWT_SECRET', ''),

  anthropic: {
    apiKey: str('ANTHROPIC_API_KEY', ''),
  },

  clientUrl: str('CLIENT_URL', 'http://localhost:5173'),
  serverUrl: str('SERVER_URL', 'http://localhost:4000'),

  currency: str('CURRENCY', 'RWF'),
  storeName: str('STORE_NAME', 'Target Traders Ltd'),
  // Shown at checkout while online payment isn't wired up - customers call
  // this number to confirm stock and complete their order.
  orderPhone: str('ORDER_PHONE', '+250792813750'),

  vatRate: num('VAT_RATE', 0.18),
  deliveryFee: num('DELIVERY_FEE', 2000),
  freeShippingThreshold: num('FREE_SHIPPING_THRESHOLD', 59000),
};

/**
 * Fail loudly at boot rather than at the first customer checkout.
 */
export function assertConfigured(): void {
  const problems: string[] = [];

  if (!config.flw.secretKey) {
    problems.push('FLW_SECRET_KEY is not set - payment initiation will fail.');
  } else if (!config.flw.secretKey.startsWith('FLWSECK')) {
    problems.push('FLW_SECRET_KEY does not look like a Flutterwave secret key (should start with FLWSECK).');
  }

  if (!config.flw.secretHash) {
    problems.push('FLW_SECRET_HASH is not set - webhooks cannot be verified and will be rejected.');
  }

  if (!config.adminJwtSecret) {
    problems.push('ADMIN_JWT_SECRET is not set - dashboard login will reject every request.');
  }

  if (!config.paypack.clientId || !config.paypack.clientSecret) {
    problems.push('PAYPACK_CLIENT_ID/PAYPACK_CLIENT_SECRET not set - Paypack checkout will fail.');
  }

  if (!config.resend.apiKey) {
    problems.push('RESEND_API_KEY is not set - verification/reset emails will fail to send.');
  }

  if (!config.africastalking.apiKey) {
    problems.push('AT_API_KEY is not set - verification/reset SMS will fail to send.');
  }

  if (!config.userJwtSecret) {
    problems.push('USER_JWT_SECRET is not set - customer login will reject every request.');
  }

  if (!config.anthropic.apiKey) {
    problems.push('ANTHROPIC_API_KEY is not set - the dashboard catalog assistant will fail.');
  }

  if (problems.length > 0) {
    console.warn('\n  Configuration warnings:');
    for (const p of problems) console.warn(`   - ${p}`);
    console.warn('  See server/.env.example\n');
  }
}

export const isLiveMode = config.flw.secretKey.includes('FLWSECK-') &&
  !config.flw.secretKey.includes('TEST');

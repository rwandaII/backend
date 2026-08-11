// Must be imported before any Router/route is created - it patches Express's
// Router prototype so a rejected promise in an async handler is forwarded to
// error-handling middleware instead of crashing the whole process (Express 4
// does not do this natively; Express 5 does).
import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import hpp from 'hpp';
import { config, assertConfigured } from './config.js';
import { loadCatalog, logCatalogWarnings, catalogStats } from './catalog.js';
import { apiLimiter, authLimiter, assistantLimiter } from './rate-limit.js';
import { requireAdminAuth } from './auth/middleware.js';
import { checkoutRouter } from './routes/checkout.js';
import { webhookRouter } from './routes/webhook.js';
import { authRouter } from './routes/auth.js';
import { adminAuthRouter } from './routes/admin-auth.js';
import { adminCatalogRouter } from './routes/admin-catalog.js';
import { adminAdminsRouter } from './routes/admin-admins.js';
import { adminUsersRouter } from './routes/admin-users.js';
import { adminMediaRouter, PRODUCTS_DIR } from './routes/admin-media.js';
import { adminImportRouter } from './routes/admin-import.js';
import { adminAssistantRouter } from './routes/admin-assistant.js';
import { adminPromotionsRouter } from './routes/admin-promotions.js';
import { catalogPublicRouter } from './routes/catalog-public.js';
import { trackRouter } from './routes/track.js';
import { adminAnalyticsRouter } from './routes/admin-analytics.js';
import { adminReportsRouter } from './routes/admin-reports.js';
import { adminOrdersRouter } from './routes/admin-orders.js';

const app = express();

// Behind a reverse proxy (nginx, Cloudflare, etc.) in production, this makes
// express-rate-limit and req.ip read the real client IP from X-Forwarded-For
// instead of the proxy's own address. Harmless with no proxy in front (dev).
app.set('trust proxy', 1);

app.use(helmet());
app.use(hpp());
// In dev, Vite falls back to the next free port (5174, 5175, ...) whenever
// something else already holds 5173 - accept any localhost origin so that
// doesn't silently break CORS. Production still pins to config.clientUrl.
const isProd = process.env.NODE_ENV === 'production';
app.use(
  cors({
    origin: isProd ? config.clientUrl : /^http:\/\/localhost:\d+$/,
    credentials: true,
  })
);
app.use(express.json({ limit: '100kb' }));
app.use('/api', apiLimiter);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, catalog: catalogStats(), currency: config.currency });
});

// Product photos live on disk (public/products/) and the DB just stores
// "/products/<filename>" - this is what actually serves them to the storefront.
// helmet's default same-origin CORP blocks plain <img> tags from a different
// port in dev (5173 vs 4000) even though CORS already allows it - these are
// public product photos, so relax CORP for this route only.
app.use('/products', (_req, res, next) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
});
app.use('/products', express.static(PRODUCTS_DIR));

app.use('/api/checkout', checkoutRouter);
app.use('/api/webhook', webhookRouter);
app.use('/api/catalog', catalogPublicRouter);
app.use('/api/track', trackRouter);

// Anything that checks a password or triggers an email/SMS send gets the
// tighter limiter, on top of the general one applied to all of /api above.
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/resend-code', authLimiter);
app.use('/api/auth', authRouter);

app.use('/api/admin/auth/login', authLimiter);
app.use('/api/admin/auth', adminAuthRouter);

app.use('/api/admin/orders', requireAdminAuth, adminOrdersRouter);
app.use('/api/admin/catalog', requireAdminAuth, adminCatalogRouter);
app.use('/api/admin/admins', requireAdminAuth, adminAdminsRouter);
app.use('/api/admin/users', requireAdminAuth, adminUsersRouter);
app.use('/api/admin/media', requireAdminAuth, adminMediaRouter);
app.use('/api/admin/import', requireAdminAuth, adminImportRouter);
app.use('/api/admin/assistant', requireAdminAuth, assistantLimiter, adminAssistantRouter);
app.use('/api/admin/promotions', requireAdminAuth, adminPromotionsRouter);
app.use('/api/admin/analytics', requireAdminAuth, adminAnalyticsRouter);
app.use('/api/admin/reports', requireAdminAuth, adminReportsRouter);

app.use((_req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

// Last-resort safety net: any error that reaches here (including async
// route rejections, now forwarded by express-async-errors) gets a normal
// JSON 500 instead of taking the process down or leaking a stack trace.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return;
  res.status(500).json({ ok: false, code: 'SERVER_ERROR', error: 'Something went wrong on our side.' });
});

async function main() {
  await loadCatalog();

  app.listen(config.port, () => {
    console.log(`\n  Target Traders API on http://localhost:${config.port}`);
    console.log(`  Client origin: ${config.clientUrl}`);
    console.log(`  Public URL:    ${config.serverUrl}`);
    logCatalogWarnings();
    assertConfigured();
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

// Defense in depth: express-async-errors covers request handlers, but a
// rejection outside a request (e.g. a background reloadCatalog() call) would
// otherwise still crash the process. Log it and keep serving instead.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection (server kept running):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server kept running):', err);
});

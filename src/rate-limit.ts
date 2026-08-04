import rateLimit from 'express-rate-limit';

/** Generous baseline for the whole API - stops naive scraping/abuse without bothering real users. */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Tight limiter for anything that checks a password or sends an email/SMS -
 * these are the endpoints brute-force and spam abuse actually target.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, code: 'RATE_LIMITED', error: 'Too many attempts. Try again in a few minutes.' },
});

/** The catalog assistant calls a paid external API per message - cap exposure without blocking normal admin use. */
export const assistantLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, code: 'RATE_LIMITED', error: 'Too many assistant messages. Try again in a few minutes.' },
});

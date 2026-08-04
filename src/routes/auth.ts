import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import {
  createUser,
  findUserByEmail,
  findUserByPhone,
  findUserById,
  verifyPassword,
  setPassword,
  markEmailVerified,
  markPhoneVerified,
  signUserToken,
  toPublicUser,
} from '../auth/users.js';
import { createVerificationCode, consumeVerificationCode } from '../auth/codes.js';
import { sendVerificationEmail, sendPasswordResetEmail } from '../notifications/email.js';
import { sendVerificationSms, sendPasswordResetSms } from '../notifications/sms.js';
import { requireUserAuth } from '../auth/middleware.js';
import { normalisePhone } from '../phone.js';

export const authRouter = Router();

function fail(res: import('express').Response, status: number, code: string, error: string) {
  res.status(status).json({ ok: false, code, error });
}

const registerSchema = z.object({
  name: z.string().trim().min(1, 'Full name is required.').max(200),
  email: z.string().trim().email('That email address does not look valid.'),
  phone: z.string().trim().min(9, 'Enter a valid phone number.'),
  password: z.string().min(8, 'Password must be at least 8 characters.'),
  address: z.string().trim().max(500).optional(),
  district: z.string().trim().max(100).optional(),
});

/**
 * POST /api/auth/register
 * Creates the account, then sends a 6-digit code to both the email and the
 * phone number - each verified independently. Login works immediately
 * either way; verification is tracked, not enforced (see PublicUser flags).
 */
authRouter.post('/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return fail(res, 400, 'INVALID_INPUT', parsed.error.issues[0]?.message ?? 'Invalid input.');
  }
  const { name, email, password, address, district } = parsed.data;

  const phone = normalisePhone(parsed.data.phone);
  if (!phone) {
    return fail(res, 400, 'BAD_PHONE', 'Enter a Rwandan mobile number, e.g. 0788123456.');
  }

  if (await findUserByEmail(email)) {
    return fail(res, 409, 'EMAIL_TAKEN', 'An account with that email already exists.');
  }
  if (await findUserByPhone(phone)) {
    return fail(res, 409, 'PHONE_TAKEN', 'An account with that phone number already exists.');
  }

  const user = await createUser({ name, email, phone, password, address, district });

  const emailCode = await createVerificationCode(user.id, 'email', 'verify', 15);
  const phoneCode = await createVerificationCode(user.id, 'phone', 'verify', 15);

  const [emailResult, smsResult] = await Promise.allSettled([
    sendVerificationEmail(email, name, emailCode),
    sendVerificationSms(phone, phoneCode),
  ]);
  if (emailResult.status === 'rejected') console.error('register: failed to send verification email', emailResult.reason);
  if (smsResult.status === 'rejected') console.error('register: failed to send verification sms', smsResult.reason);

  res.status(201).json({ ok: true, user: toPublicUser(user), token: signUserToken(user) });
});

authRouter.post('/verify-email', async (req, res) => {
  const email = String(req.body?.email ?? '');
  const code = String(req.body?.code ?? '');
  const user = await findUserByEmail(email);
  if (!user) return fail(res, 404, 'NOT_FOUND', 'Account not found.');

  const ok = await consumeVerificationCode(user.id, 'email', 'verify', code);
  if (!ok) return fail(res, 400, 'BAD_CODE', 'That code is invalid or expired.');

  await markEmailVerified(user.id);
  res.json({ ok: true });
});

authRouter.post('/verify-phone', async (req, res) => {
  const phone = normalisePhone(String(req.body?.phone ?? ''));
  const code = String(req.body?.code ?? '');
  const user = phone ? await findUserByPhone(phone) : null;
  if (!user) return fail(res, 404, 'NOT_FOUND', 'Account not found.');

  const ok = await consumeVerificationCode(user.id, 'phone', 'verify', code);
  if (!ok) return fail(res, 400, 'BAD_CODE', 'That code is invalid or expired.');

  await markPhoneVerified(user.id);
  res.json({ ok: true });
});

authRouter.post('/resend-code', async (req, res) => {
  const channel = req.body?.channel === 'phone' ? 'phone' : 'email';
  let user;
  if (channel === 'phone') {
    const phone = normalisePhone(String(req.body?.phone ?? ''));
    user = phone ? await findUserByPhone(phone) : null;
  } else {
    user = await findUserByEmail(String(req.body?.email ?? ''));
  }

  if (!user) return fail(res, 404, 'NOT_FOUND', 'Account not found.');

  if (channel === 'phone' && user.phone) {
    const code = await createVerificationCode(user.id, 'phone', 'verify', 15);
    await sendVerificationSms(user.phone, code);
  } else {
    const code = await createVerificationCode(user.id, 'email', 'verify', 15);
    await sendVerificationEmail(user.email, user.name, code);
  }

  res.json({ ok: true });
});

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

/**
 * GET /api/auth/me
 * Restores a session from a stored token on page load - returns the current
 * user's fresh data (not just what was cached from the token payload).
 */
authRouter.get('/me', requireUserAuth, async (req, res) => {
  const user = await findUserById(req.user!.sub);
  if (!user) return fail(res, 404, 'NOT_FOUND', 'Account not found.');
  res.json({ ok: true, user: toPublicUser(user) });
});

authRouter.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 400, 'INVALID_INPUT', 'Email and password are required.');

  const user = await findUserByEmail(parsed.data.email);
  if (!user || !(await verifyPassword(user, parsed.data.password))) {
    return fail(res, 401, 'BAD_CREDENTIALS', 'Incorrect email or password.');
  }

  res.json({ ok: true, user: toPublicUser(user), token: signUserToken(user) });
});

/**
 * POST /api/auth/forgot-password
 * Accepts either an email (sends a reset LINK) or a phone (sends a reset
 * CODE). Always responds ok:true regardless of whether the account exists,
 * so this endpoint can't be used to enumerate registered emails/phones.
 */
authRouter.post('/forgot-password', async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  const rawPhone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : '';

  if (!email && !rawPhone) {
    return fail(res, 400, 'MISSING_FIELD', 'Enter the email or phone number on your account.');
  }

  const phone = rawPhone ? normalisePhone(rawPhone) : null;
  const user = email ? await findUserByEmail(email) : phone ? await findUserByPhone(phone) : null;

  if (user) {
    if (email) {
      const token = await createVerificationCode(user.id, 'email', 'password_reset', 30);
      const link = `${config.clientUrl}/reset-password?uid=${user.id}&channel=email&code=${token}`;
      sendPasswordResetEmail(user.email, user.name, link).catch((err) =>
        console.error('forgot-password: failed to send email', err)
      );
    } else if (user.phone) {
      const code = await createVerificationCode(user.id, 'phone', 'password_reset', 30);
      sendPasswordResetSms(user.phone, code).catch((err) =>
        console.error('forgot-password: failed to send sms', err)
      );
    }
  }

  res.json({ ok: true, message: 'If an account exists, reset instructions were sent.' });
});

const resetSchema = z.object({
  userId: z.coerce.number().int().positive(),
  channel: z.enum(['email', 'phone']),
  code: z.string().min(4),
  newPassword: z.string().min(8, 'Password must be at least 8 characters.'),
});

authRouter.post('/reset-password', async (req, res) => {
  const parsed = resetSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return fail(res, 400, 'INVALID_INPUT', parsed.error.issues[0]?.message ?? 'Invalid request.');
  }
  const { userId, channel, code, newPassword } = parsed.data;

  const user = await findUserById(userId);
  if (!user) return fail(res, 404, 'NOT_FOUND', 'Account not found.');

  const ok = await consumeVerificationCode(userId, channel, 'password_reset', code);
  if (!ok) return fail(res, 400, 'BAD_CODE', 'That reset link or code is invalid or expired.');

  await setPassword(userId, newPassword);
  res.json({ ok: true });
});

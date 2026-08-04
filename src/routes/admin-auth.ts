import { Router } from 'express';
import { z } from 'zod';
import { findAdminByEmail, verifyAdminPassword, signAdminToken, toPublicAdmin } from '../auth/admins.js';
import { requireAdminAuth } from '../auth/middleware.js';

export const adminAuthRouter = Router();

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

adminAuthRouter.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, code: 'INVALID_INPUT', error: 'Email and password are required.' });
  }

  const admin = await findAdminByEmail(parsed.data.email);
  if (!admin || !(await verifyAdminPassword(admin, parsed.data.password))) {
    return res.status(401).json({ ok: false, code: 'BAD_CREDENTIALS', error: 'Incorrect email or password.' });
  }

  res.json({ ok: true, admin: toPublicAdmin(admin), token: signAdminToken(admin) });
});

adminAuthRouter.get('/me', requireAdminAuth, async (req, res) => {
  const admin = await findAdminByEmail(req.admin!.email);
  if (!admin) return res.status(404).json({ ok: false, error: 'Admin not found.' });
  res.json({ ok: true, admin: toPublicAdmin(admin) });
});

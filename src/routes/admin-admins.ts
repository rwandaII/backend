import { Router } from 'express';
import { z } from 'zod';
import {
  listAdmins,
  createAdmin,
  updateAdmin,
  deleteAdmin,
  findAdminByEmail,
  findAdminById,
  countAdmins,
  toPublicAdmin,
} from '../auth/admins.js';
import { requireSuperAdmin } from '../auth/middleware.js';

export const adminAdminsRouter = Router();

// Managing who else can log into the dashboard is sensitive enough to
// restrict to superadmins, unlike catalog/order management.
adminAdminsRouter.use(requireSuperAdmin);

function fail(res: import('express').Response, status: number, error: string, code = 'INVALID_INPUT') {
  res.status(status).json({ ok: false, code, error });
}

adminAdminsRouter.get('/', async (_req, res) => {
  const admins = await listAdmins();
  res.json({ ok: true, admins: admins.map(toPublicAdmin) });
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email(),
  password: z.string().min(8, 'Password must be at least 8 characters.'),
  role: z.enum(['admin', 'superadmin']).default('admin'),
});

adminAdminsRouter.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message ?? 'Invalid input.');

  if (await findAdminByEmail(parsed.data.email)) {
    return fail(res, 409, 'An admin with that email already exists.', 'EMAIL_TAKEN');
  }

  const admin = await createAdmin(parsed.data);
  res.status(201).json({ ok: true, admin: toPublicAdmin(admin) });
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().email().optional(),
  role: z.enum(['admin', 'superadmin']).optional(),
  password: z.string().min(8).optional(),
});

adminAdminsRouter.put('/:id', async (req, res) => {
  const parsed = updateSchema.safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message ?? 'Invalid input.');

  const id = Number(req.params.id);

  // Prevent a superadmin from demoting/locking themselves out by accident.
  if (id === req.admin!.sub && parsed.data.role && parsed.data.role !== 'superadmin') {
    return fail(res, 400, 'You cannot remove your own superadmin role.', 'SELF_DEMOTE');
  }

  const admin = await updateAdmin(id, parsed.data);
  if (!admin) return fail(res, 404, 'Admin not found.', 'NOT_FOUND');
  res.json({ ok: true, admin: toPublicAdmin(admin) });
});

adminAdminsRouter.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);

  if (id === req.admin!.sub) {
    return fail(res, 400, 'You cannot delete your own account.', 'SELF_DELETE');
  }
  if ((await countAdmins()) <= 1) {
    return fail(res, 400, 'Cannot delete the last remaining admin.', 'LAST_ADMIN');
  }

  const existing = await findAdminById(id);
  if (!existing) return fail(res, 404, 'Admin not found.', 'NOT_FOUND');

  await deleteAdmin(id);
  res.json({ ok: true });
});

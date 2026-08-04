import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';

export const adminUsersRouter = Router();

function fail(res: import('express').Response, status: number, error: string, code = 'INVALID_INPUT') {
  res.status(status).json({ ok: false, code, error });
}

const PUBLIC_COLUMNS = `id, name, email, phone, address, district, email_verified_at, phone_verified_at, created_at, updated_at`;

adminUsersRouter.get('/', async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 50));
  const offset = (page - 1) * pageSize;

  const { rows: countRows } = await pool.query(
    `SELECT count(*) FROM users WHERE $1 = '' OR name ILIKE '%'||$1||'%' OR email ILIKE '%'||$1||'%' OR phone ILIKE '%'||$1||'%'`,
    [search]
  );
  const { rows } = await pool.query(
    `SELECT ${PUBLIC_COLUMNS} FROM users
     WHERE $1 = '' OR name ILIKE '%'||$1||'%' OR email ILIKE '%'||$1||'%' OR phone ILIKE '%'||$1||'%'
     ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [search, pageSize, offset]
  );

  res.json({ ok: true, users: rows, total: Number(countRows[0].count), page, pageSize });
});

adminUsersRouter.get('/:id', async (req, res) => {
  const { rows } = await pool.query(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1`, [req.params.id]);
  if (!rows[0]) return fail(res, 404, 'User not found.', 'NOT_FOUND');
  res.json({ ok: true, user: rows[0] });
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().email().optional(),
  phone: z.string().trim().min(9).optional(),
  address: z.string().trim().max(500).optional(),
  district: z.string().trim().max(100).optional(),
});

adminUsersRouter.put('/:id', async (req, res) => {
  const parsed = updateSchema.safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message ?? 'Invalid input.');
  const p = parsed.data;

  try {
    const { rows } = await pool.query(
      `UPDATE users SET
         name = COALESCE($2, name),
         email = COALESCE($3, email),
         phone = COALESCE($4, phone),
         address = COALESCE($5, address),
         district = COALESCE($6, district),
         updated_at = now()
       WHERE id = $1 RETURNING ${PUBLIC_COLUMNS}`,
      [req.params.id, p.name ?? null, p.email?.toLowerCase() ?? null, p.phone ?? null, p.address ?? null, p.district ?? null]
    );
    if (!rows[0]) return fail(res, 404, 'User not found.', 'NOT_FOUND');
    res.json({ ok: true, user: rows[0] });
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === '23505') {
      return fail(res, 409, 'Another account already uses that email or phone.', 'CONFLICT');
    }
    throw err;
  }
});

adminUsersRouter.delete('/:id', async (req, res) => {
  const { rowCount } = await pool.query(`DELETE FROM users WHERE id = $1`, [req.params.id]);
  if (!rowCount) return fail(res, 404, 'User not found.', 'NOT_FOUND');
  res.json({ ok: true });
});

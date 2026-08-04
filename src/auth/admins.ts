import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../db.js';
import { config } from '../config.js';

export type AdminRole = 'admin' | 'superadmin';

export interface AdminRow {
  id: number;
  name: string;
  email: string;
  password_hash: string;
  role: AdminRole;
  created_at: string;
  updated_at: string;
}

export interface PublicAdmin {
  id: number;
  name: string;
  email: string;
  role: AdminRole;
  createdAt: string;
}

export function toPublicAdmin(row: AdminRow): PublicAdmin {
  return { id: row.id, name: row.name, email: row.email, role: row.role, createdAt: row.created_at };
}

export async function createAdmin(input: { name: string; email: string; password: string; role?: AdminRole }): Promise<AdminRow> {
  const passwordHash = await bcrypt.hash(input.password, 10);
  const { rows } = await pool.query<AdminRow>(
    `INSERT INTO admins (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING *`,
    [input.name, input.email.toLowerCase(), passwordHash, input.role ?? 'admin']
  );
  return rows[0];
}

export async function findAdminByEmail(email: string): Promise<AdminRow | null> {
  const { rows } = await pool.query<AdminRow>(`SELECT * FROM admins WHERE email = $1`, [email.toLowerCase()]);
  return rows[0] ?? null;
}

export async function findAdminById(id: number): Promise<AdminRow | null> {
  const { rows } = await pool.query<AdminRow>(`SELECT * FROM admins WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function listAdmins(): Promise<AdminRow[]> {
  const { rows } = await pool.query<AdminRow>(`SELECT * FROM admins ORDER BY created_at ASC`);
  return rows;
}

export async function countAdmins(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(`SELECT count(*) FROM admins`);
  return Number(rows[0].count);
}

export async function updateAdmin(
  id: number,
  patch: { name?: string; email?: string; role?: AdminRole; password?: string }
): Promise<AdminRow | null> {
  const passwordHash = patch.password ? await bcrypt.hash(patch.password, 10) : null;
  const { rows } = await pool.query<AdminRow>(
    `UPDATE admins SET
       name = COALESCE($2, name),
       email = COALESCE($3, email),
       role = COALESCE($4, role),
       password_hash = COALESCE($5, password_hash),
       updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, patch.name ?? null, patch.email?.toLowerCase() ?? null, patch.role ?? null, passwordHash]
  );
  return rows[0] ?? null;
}

export async function deleteAdmin(id: number): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM admins WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

export async function verifyAdminPassword(admin: AdminRow, password: string): Promise<boolean> {
  return bcrypt.compare(password, admin.password_hash);
}

export interface AdminTokenPayload {
  sub: number;
  email: string;
  role: AdminRole;
}

export function signAdminToken(admin: AdminRow): string {
  const payload: AdminTokenPayload = { sub: admin.id, email: admin.email, role: admin.role };
  // Shorter-lived than the customer token - this is an operator session, not a "stay logged in" storefront cookie.
  return jwt.sign(payload, config.adminJwtSecret, { expiresIn: '12h' });
}

export function verifyAdminToken(token: string): AdminTokenPayload {
  return jwt.verify(token, config.adminJwtSecret) as unknown as AdminTokenPayload;
}

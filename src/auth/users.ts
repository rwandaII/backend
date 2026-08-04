import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../db.js';
import { config } from '../config.js';

export interface UserRow {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  password_hash: string | null;
  address: string | null;
  district: string | null;
  email_verified_at: string | null;
  phone_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublicUser {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  emailVerified: boolean;
  phoneVerified: boolean;
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    emailVerified: row.email_verified_at !== null,
    phoneVerified: row.phone_verified_at !== null,
  };
}

export async function createUser(input: {
  name: string;
  email: string;
  phone: string;
  password: string;
  address?: string;
  district?: string;
}): Promise<UserRow> {
  const passwordHash = await bcrypt.hash(input.password, 10);
  const { rows } = await pool.query<UserRow>(
    `INSERT INTO users (name, email, phone, password_hash, address, district)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [input.name, input.email.toLowerCase(), input.phone, passwordHash, input.address ?? null, input.district ?? null]
  );
  return rows[0];
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>(`SELECT * FROM users WHERE email = $1`, [email.toLowerCase()]);
  return rows[0] ?? null;
}

export async function findUserByPhone(phone: string): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>(`SELECT * FROM users WHERE phone = $1`, [phone]);
  return rows[0] ?? null;
}

export async function findUserById(id: number): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function verifyPassword(user: UserRow, password: string): Promise<boolean> {
  if (!user.password_hash) return false;
  return bcrypt.compare(password, user.password_hash);
}

export async function setPassword(userId: number, password: string): Promise<void> {
  const hash = await bcrypt.hash(password, 10);
  await pool.query(`UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`, [hash, userId]);
}

export async function markEmailVerified(userId: number): Promise<void> {
  await pool.query(`UPDATE users SET email_verified_at = now() WHERE id = $1 AND email_verified_at IS NULL`, [userId]);
}

export async function markPhoneVerified(userId: number): Promise<void> {
  await pool.query(`UPDATE users SET phone_verified_at = now() WHERE id = $1 AND phone_verified_at IS NULL`, [userId]);
}

export function signUserToken(user: UserRow): string {
  return jwt.sign({ sub: user.id, email: user.email }, config.userJwtSecret, { expiresIn: '30d' });
}

export interface UserTokenPayload {
  sub: number;
  email: string;
}

export function verifyUserToken(token: string): UserTokenPayload {
  return jwt.verify(token, config.userJwtSecret) as unknown as UserTokenPayload;
}

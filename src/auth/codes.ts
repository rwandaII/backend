import { randomInt, randomBytes, createHash } from 'node:crypto';
import { pool } from '../db.js';

export type CodeChannel = 'email' | 'phone';
export type CodePurpose = 'verify' | 'password_reset';

function hashCode(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function generateToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Creates a new code/token and stores only its hash. Email password-reset
 * uses a long random token (embedded in a link); everything else is a
 * 6-digit OTP suitable for typing in by hand or reading from an SMS.
 */
export async function createVerificationCode(
  userId: number,
  channel: CodeChannel,
  purpose: CodePurpose,
  ttlMinutes: number
): Promise<string> {
  const raw = channel === 'email' && purpose === 'password_reset' ? generateToken() : generateOtp();
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);

  await pool.query(
    `INSERT INTO verification_codes (user_id, channel, purpose, code_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, channel, purpose, hashCode(raw), expiresAt]
  );

  return raw;
}

/**
 * Checks the most recent unconsumed, unexpired code for (user, channel,
 * purpose) against what was supplied. Caps at 5 wrong attempts so a 6-digit
 * OTP can't be brute-forced before it expires.
 */
export async function consumeVerificationCode(
  userId: number,
  channel: CodeChannel,
  purpose: CodePurpose,
  raw: string
): Promise<boolean> {
  const { rows } = await pool.query<{ id: number; code_hash: string; attempts: number }>(
    `SELECT id, code_hash, attempts FROM verification_codes
     WHERE user_id = $1 AND channel = $2 AND purpose = $3
       AND consumed_at IS NULL AND expires_at > now()
     ORDER BY created_at DESC LIMIT 1`,
    [userId, channel, purpose]
  );

  const row = rows[0];
  if (!row || row.attempts >= 5) return false;

  if (row.code_hash !== hashCode(raw)) {
    await pool.query(`UPDATE verification_codes SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
    return false;
  }

  await pool.query(`UPDATE verification_codes SET consumed_at = now() WHERE id = $1`, [row.id]);
  return true;
}

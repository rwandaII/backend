import 'dotenv/config';
import { findAdminByEmail, createAdmin, countAdmins } from './auth/admins.js';
import { pool } from './db.js';

async function main() {
  const name = process.env.ADMIN_NAME ?? 'Admin';
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD in server/.env before running this script.');
  }
  if (password.length < 8) {
    throw new Error('ADMIN_PASSWORD must be at least 8 characters.');
  }

  const existing = await findAdminByEmail(email);
  if (existing) {
    console.log(`Admin ${email} already exists (role: ${existing.role}) - nothing to do.`);
    return;
  }

  // The very first admin is a superadmin so there's always someone who can
  // manage other admin accounts.
  const isFirst = (await countAdmins()) === 0;
  const admin = await createAdmin({ name, email, password, role: isFirst ? 'superadmin' : 'admin' });
  console.log(`Created admin ${admin.email} (role: ${admin.role}).`);
}

main()
  .catch((err) => {
    console.error('seed-admin failed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

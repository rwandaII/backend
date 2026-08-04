import type { Request, Response, NextFunction } from 'express';
import { verifyAdminToken, type AdminTokenPayload } from './admins.js';
import { verifyUserToken, type UserTokenPayload } from './users.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: AdminTokenPayload;
      user?: UserTokenPayload;
    }
  }
}

/** Requires a valid admin session (Authorization: Bearer <token>). */
export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('authorization') ?? '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    res.status(401).json({ ok: false, code: 'UNAUTHENTICATED', error: 'Sign in to the dashboard first.' });
    return;
  }

  try {
    req.admin = verifyAdminToken(token);
    next();
  } catch {
    res.status(401).json({ ok: false, code: 'BAD_TOKEN', error: 'Your session has expired. Sign in again.' });
  }
}

/** Requires requireAdminAuth to have already run. Restricts to superadmin-only actions. */
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.admin?.role !== 'superadmin') {
    res.status(403).json({ ok: false, code: 'FORBIDDEN', error: 'Only a super admin can do that.' });
    return;
  }
  next();
}

/** Requires a valid customer session (Authorization: Bearer <token>). */
export function requireUserAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('authorization') ?? '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    res.status(401).json({ ok: false, code: 'UNAUTHENTICATED', error: 'Sign in first.' });
    return;
  }

  try {
    req.user = verifyUserToken(token);
    next();
  } catch {
    res.status(401).json({ ok: false, code: 'BAD_TOKEN', error: 'Your session has expired. Sign in again.' });
  }
}

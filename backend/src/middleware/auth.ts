import { Request, Response, NextFunction } from 'express';
import { verifyCredential } from '../services/credentials';
import { MemberCredential } from '../types/credentials';
import { createError } from './errorHandler';
import { authenticateAdminSession, AdminSessionIdentity } from '../services/adminSession';

export const ADMIN_ROLES = ['superadmin', 'admin', 'moderator', 'observer'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === 'string' && ADMIN_ROLES.includes(value as AdminRole);
}

declare global {
  namespace Express {
    interface Request {
      credential?: MemberCredential;
      adminUser?: {
        id: string;
        email: string;
        role: AdminRole;
        fullName?: string;
      };
      adminSession?: AdminSessionIdentity;
    }
  }
}

/** Verify a member credential. Domain access still requires server-side scoped authorization. */
export function requireCredential(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    next(createError('Missing or invalid Authorization header', 401));
    return;
  }

  try {
    req.credential = verifyCredential(authHeader.substring(7));
    next();
  } catch {
    next(createError('Invalid or expired credential', 401));
  }
}

/** Verify the server-side browser session; client role claims and mobile tokens grant nothing. */
export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.adminUser && req.adminSession) {
    next();
    return;
  }

  authenticateAdminSession(req)
    .then(identity => {
      if (!identity || !isAdminRole(identity.role)) {
        next(createError('Admin authentication failed', 401));
        return;
      }
      req.adminSession = identity;
      req.adminUser = {
        id: identity.id,
        email: identity.email,
        role: identity.role,
        fullName: identity.fullName,
      };
      next();
    })
    .catch(next);
}

/** Authorize a sensitive operation after requireAdmin has authenticated it. */
export function requireAdminRole(...allowedRoles: AdminRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.adminUser) {
      next(createError('Admin authentication required', 401));
      return;
    }
    if (!allowedRoles.includes(req.adminUser.role)) {
      next(createError('Insufficient admin role', 403));
      return;
    }
    next();
  };
}

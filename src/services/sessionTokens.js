import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { jwtSecret } from './sessionSecurity.js';

const prisma = new PrismaClient();
const digest = (token) => crypto.createHash('sha256').update(token).digest('hex');
export class InvalidSessionError extends Error {}
export const isInvalidSession = error => error instanceof InvalidSessionError || error instanceof jwt.JsonWebTokenError;

export async function verifySessionToken(token, db = prisma) {
  const claims = jwt.verify(token, jwtSecret(), { algorithms: ['HS256'] });
  if (!Number.isFinite(claims.exp)) throw new InvalidSessionError('Session expiry required');
  const revoked = await db.revokedSession.findUnique({ where: { tokenHash: digest(token) } });
  if (revoked) throw new InvalidSessionError('Session revoked');
  return claims;
}

export async function revokeSessionToken(token, db = prisma) {
  let claims;
  try { claims = jwt.verify(token, jwtSecret(), { algorithms: ['HS256'] }); }
  catch (error) {
    // Invalid/expired tokens already cannot authenticate. Configuration errors propagate.
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) return;
    throw error;
  }
  if (!Number.isFinite(claims.exp)) return;
  const tokenHash = digest(token);
  await db.revokedSession.upsert({
    where: { tokenHash }, update: {},
    create: { tokenHash, expiresAt: new Date(claims.exp * 1000) },
  });
}

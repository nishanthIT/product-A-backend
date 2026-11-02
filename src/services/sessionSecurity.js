// Read lazily: server.js loads dotenv after importing routes.
export function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret === 'your-secret-key' || (process.env.NODE_ENV === 'production' && Buffer.byteLength(secret, 'utf8') < 32)) throw new Error('A private JWT_SECRET must be configured');
  return secret;
}

// An explicit bearer credential must never be replaced by a stale browser cookie.
export function readSessionToken(req) {
  const authorization = req.headers?.authorization;
  if (authorization !== undefined) {
    const match = typeof authorization === 'string' && authorization.length <= 8192 ? /^Bearer\s+(\S+)$/i.exec(authorization) : null;
    return match?.[1] ?? null;
  }
  const cookie = req.cookies?.auth_token;
  return typeof cookie === 'string' && cookie.length <= 8192 ? cookie : null;
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  };
}

export function sessionSignOptions() {
  return { algorithm: 'HS256', expiresIn: '7d', issuer: process.env.JWT_ISSUER || 'paymi-api', audience: process.env.JWT_AUDIENCE || 'paymi-app' };
}

// Issued tokens always carry issuer/audience. Legacy sessions may finish their
// existing seven-day lifetime unless operators opt into strict migration.
export function validateSessionClaims(claims) {
  const issuer = process.env.JWT_ISSUER || 'paymi-api';
  const audience = process.env.JWT_AUDIENCE || 'paymi-app';
  if (!claims || typeof claims !== 'object' || !['ADMIN', 'EMPLOYEE', 'CUSTOMER'].includes(claims.userType)
      || !((typeof claims.id === 'string' && /^[1-9]\d*$/.test(claims.id)) || typeof claims.id === 'number')
      || !Number.isSafeInteger(Number(claims.id)) || Number(claims.id) < 1
      || !Number.isFinite(claims.exp)) return false;
  if ((claims.iss !== undefined || process.env.JWT_REQUIRE_ISSUER_AUDIENCE === 'true') && claims.iss !== issuer) return false;
  if ((claims.aud !== undefined || process.env.JWT_REQUIRE_ISSUER_AUDIENCE === 'true') && claims.aud !== audience) return false;
  return true;
}

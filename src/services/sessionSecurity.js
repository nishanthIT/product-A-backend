// Read lazily: server.js loads dotenv after importing routes.
export function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret === 'your-secret-key') throw new Error('A private JWT_SECRET must be configured');
  return secret;
}

// An explicit bearer credential must never be replaced by a stale browser cookie.
export function readSessionToken(req) {
  const authorization = req.headers?.authorization;
  if (authorization !== undefined) {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization);
    return match?.[1] ?? null;
  }
  return req.cookies?.auth_token ?? null;
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  };
}

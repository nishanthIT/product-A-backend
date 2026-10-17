export function restoreGuard(_req, res, next) {
  if (process.env.PAYMI_RESTORE_MODE === '1') return res.status(503).set('Retry-After', '300').json({ error: 'Service recovery in progress' });
  next();
}

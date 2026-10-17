import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const router = express.Router();
const directory = fileURLToPath(new URL('../../public/release/', import.meta.url));
router.use(['/account-deletion', '/support', '/release-resources'], (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  next();
});
router.get('/account-deletion', (_req, res) => res.sendFile(path.join(directory, 'account-deletion.html')));
router.get('/support', (_req, res) => res.sendFile(path.join(directory, 'support.html')));
router.use('/release-resources', express.static(directory, { index: false, dotfiles: 'deny' }));
export default router;

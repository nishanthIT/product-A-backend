// Accept signed decimal numbers without silently truncating malformed input.
export function parseTemperature(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = String(value).trim().replace(/\u2212/g, '-').replace(',', '.');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function validateTemperatureFields(req, res, next) {
  for (const field of ['minSafeTemp', 'maxSafeTemp', 'freezerMinSafeTemp', 'freezerMaxSafeTemp', 'freezerTargetTemp']) {
    if (req.body[field] !== undefined && parseTemperature(req.body[field]) === null) {
      return res.status(400).json({ error: `${field} must be a valid temperature` });
    }
  }
  next();
}

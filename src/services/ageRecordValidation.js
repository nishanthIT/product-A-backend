export function parseProductDetails(body) {
  const data = {};
  for (const field of ['productCategory', 'productName']) {
    if (body[field] === undefined) continue;
    if (body[field] !== null && (typeof body[field] !== 'string' || body[field].trim().length > 200)) {
      return { error: `${field} must be text of 200 characters or fewer` };
    }
    data[field] = body[field]?.trim() || null;
  }
  return { data };
}

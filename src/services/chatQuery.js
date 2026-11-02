const invalidQuery = message => Object.assign(new Error(message), { status: 400 });

export function chatSearchTerm(value) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 200) throw invalidQuery('Search must be text of at most 200 characters.');
  return value.trim();
}

// Prisma contains uses LIKE: treat user-entered %, _ and backslashes literally.
export function messageSearchWhere(term) {
  if (!term) return {};
  const contains = term.replace(/[\\%_]/g, '\\$&');
  return { OR: ['content', 'attachmentName'].map(field => ({ [field]: { contains, mode: 'insensitive' } })) };
}

export function messagePageQuery(query) {
  const positiveInteger = (value, fallback, maximum, name) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || Number(value) > maximum) throw invalidQuery(`${name} must be between 1 and ${maximum}.`);
    return Number(value);
  };
  const page = positiveInteger(query.page, 1, 1000000, 'Page');
  const limit = positiveInteger(query.limit, 50, 100, 'Limit');
  if (query.before !== undefined && (typeof query.before !== 'string' || !query.before || query.before.length > 1024)) throw invalidQuery('Choose a valid message cursor.');
  if (query.before && page !== 1) throw invalidQuery('Use a message cursor or a page number, not both.');
  return { page, limit, before: query.before, search: chatSearchTerm(query.search) };
}

export function encodeMessageCursor(message) {
  return 'v1.' + Buffer.from(JSON.stringify({ id: message.id, at: message.createdAt.toISOString() })).toString('base64url');
}

export async function messageCursorBoundary(before, chatId, db) {
  if (!before) return null;
  if (!before.startsWith('v1.')) {
    const message = await db.message.findFirst({ where: { id: before, chatId }, select: { id: true, createdAt: true } });
    if (!message) throw invalidQuery('This message cursor is no longer available. Refresh the conversation.');
    return message;
  }
  try {
    const value = JSON.parse(Buffer.from(before.slice(3), 'base64url').toString('utf8'));
    if (typeof value.id !== 'string' || !value.id || value.id.length > 512 || typeof value.at !== 'string') throw new Error();
    const createdAt = new Date(value.at);
    if (!Number.isFinite(createdAt.getTime())) throw new Error();
    return { id: value.id, createdAt };
  } catch { throw invalidQuery('Choose a valid message cursor.'); }
}

export function chatUnavailableResponse(error) {
  const schemaMissing = ['P2021', 'P2022', '42P01', '42703'].includes(error?.meta?.code || error?.code);
  return {
    success: false,
    code: schemaMissing ? 'CHAT_SCHEMA_NOT_READY' : 'CHAT_UNAVAILABLE',
    message: schemaMissing ? 'Chat is being updated. Please try again shortly.' : 'Chat is temporarily unavailable. Please try again.',
  };
}

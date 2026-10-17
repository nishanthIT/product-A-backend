// Never log query text, connection URLs, tokens, cache keys or message content.
export function serviceError(error) {
  return {
    name: error?.name || 'Error',
    code: error?.code || 'UNKNOWN',
    databaseCode: error?.meta?.code,
    service: error?.service,
    model: error?.meta?.modelName,
    table: error?.meta?.table,
    column: error?.meta?.column,
    action: ['P2021', 'P2022', '42P01', '42703'].includes(error?.meta?.code || error?.code)
      ? 'Apply pending Prisma migrations and regenerate the client before restarting.' : undefined,
  };
}

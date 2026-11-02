import { serviceError } from './serviceErrors.js';

// Route/controller diagnostics never serialize request objects, account rows,
// supplier prices, SQL, email, credentials or user-authored messages. Detailed
// security evidence belongs in the authorized Security Center with retention.
export function safeLogger(component, sink = console) {
  const emit = (level, values) => {
    const error = values.find(value => value instanceof Error);
    const code = error?.code;
    sink[level]('Application operation', {
      component,
      ...(error && { error: {
        name: ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'PrismaClientKnownRequestError', 'PrismaClientValidationError'].includes(error.name) ? error.name : 'Error',
        code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,40}$/.test(code) ? code : 'UNKNOWN',
        ...(serviceError(error).action && { action: serviceError(error).action }),
      } }),
    });
  };
  return { log() {}, info() {}, debug() {}, error: (...values) => emit('error', values), warn: (...values) => emit('warn', values) };
}

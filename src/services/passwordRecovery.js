import { DatabaseCache } from './databaseCache.js';
import { verifyOtp } from './otpSecurity.js';

const invalidCode = () => ({
  ok: false,
  error: 'Invalid or expired verification code. Please request a new one.',
});

/**
 * Commit proof consumption and the password change together. The caller hashes
 * the password before entering this transaction so bcrypt does not hold a lock.
 * Failed attempts still use the same OTP verifier and shared cache-key lock as
 * every other worker. Any database error rolls the consumed proof back.
 */
export async function resetPasswordWithOtp(db, { email, otp, passwordHash, now = Date.now() }) {
  return db.$transaction(async tx => {
    // Bind DatabaseCache's transaction boundary to this existing transaction;
    // mutate() still takes its normal advisory lock and updates its revision.
    const store = new DatabaseCache({ $transaction: operation => operation(tx) });
    const cache = {
      async change(key, operation) {
        return (await store.mutate(key, operation)).result;
      },
    };
    const verified = await verifyOtp('reset', email, otp, { cache, now });
    if (!verified.ok) return verified;

    for (const [table, userType] of [['admin', 'ADMIN'], ['empolyee', 'EMPLOYEE'], ['customer', 'CUSTOMER']]) {
      const user = await tx[table].findFirst({
        where: { email: { equals: email, mode: 'insensitive' } },
        select: { id: true },
      });
      if (!user) continue;
      await tx[table].update({
        where: { id: user.id },
        data: {
          password: passwordHash,
          sessionVersion: { increment: 1 },
          resetToken: null,
          resetTokenExpiry: null,
        },
      });
      // Redis copies cannot resurrect this proof: reads check authoritative
      // PostgreSQL metadata, and this transaction deletes the cache row.
      return { ok: true, userId: user.id, userType };
    }
    return invalidCode();
  }, { maxWait: 10000, timeout: 15000 });
}

#!/usr/bin/env node
// Read-only diagnostics. Prints IDs and relationship states, never names, emails,
// message bodies or credentials. Does not grant access or recreate missing chats.
// node scripts/inspectShopTeamChats.js [--shop-id=<shop UUID>]
import 'dotenv/config';
import pg from 'pg';

const args = process.argv.slice(2);
if (args.some(arg => !arg.startsWith('--shop-id=') || !arg.slice('--shop-id='.length).trim()) || args.length > 1) {
  console.error('Usage: node scripts/inspectShopTeamChats.js [--shop-id=<shop UUID>]');
  process.exit(1);
}
const shopId = args[0]?.slice('--shop-id='.length) || null;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000, statement_timeout: 30000 });
try {
  await db.connect();
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const { rows } = await db.query(`
    SELECT s.id AS "shopId", s."groupChatId", c.type AS "chatType",
      (SELECT count(*)::int FROM "SupermarketOwnership" o WHERE o."shopId"=s.id) AS "verifiedOwnerCount",
      (SELECT count(*)::int FROM "Customer" o WHERE o."shopId"=s.id
        AND NOT EXISTS (SELECT 1 FROM "SupermarketOwnership" v WHERE v."shopId"=s.id AND v."customerId"=o.id)) AS "legacyOwnersWithoutOwnership",
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'employeeId', m."employeeId", 'status', m.status,
        'hasParticipantRow', EXISTS (SELECT 1 FROM "ChatParticipant" p WHERE p."chatId"=s."groupChatId" AND p."userType"='EMPLOYEE' AND p."userId"=m."employeeId"),
        'hasOpenAccessReview', EXISTS (SELECT 1 FROM "EmployeeAccessReview" r WHERE r."employeeId"=m."employeeId" AND r.status='OPEN')
      ) ORDER BY m."employeeId") FROM "ShopEmployeeMembership" m WHERE m."shopId"=s.id), '[]'::jsonb) AS memberships,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'employeeId', e.id,
        'companyStatus', (SELECT m.status FROM "CompanyStaffMembership" m WHERE m."employeeId"=e.id),
        'reviews', COALESCE((SELECT jsonb_agg(jsonb_build_object('status', r.status, 'reason', r.reason))
          FROM "EmployeeAccessReview" r WHERE r."employeeId"=e.id), '[]'::jsonb)
      ) ORDER BY e.id) FROM "Empolyee" e WHERE e."shopId"=s.id
        AND NOT EXISTS (SELECT 1 FROM "ShopEmployeeMembership" m WHERE m."employeeId"=e.id AND m."shopId"=s.id)), '[]'::jsonb) AS "legacyEmployeesWithoutMembership",
      COALESCE((SELECT jsonb_agg(p."userId" ORDER BY p."userId") FROM "ChatParticipant" p
        WHERE p."chatId"=s."groupChatId" AND p."userType"='EMPLOYEE'
        AND NOT EXISTS (SELECT 1 FROM "ShopEmployeeMembership" m WHERE m."employeeId"=p."userId" AND m."shopId"=s.id AND m.status='ACTIVE')), '[]'::jsonb) AS "staleEmployeeParticipantIds"
    FROM "Shop" s LEFT JOIN "Chat" c ON c.id=s."groupChatId"
    WHERE s."shopType"='CUSTOMER' AND ($1::text IS NULL OR s.id=$1)
    ORDER BY s.id`, [shopId]);
  await db.query('ROLLBACK');
  const shops = rows.map(shop => ({ ...shop, findings: [
    ...(!shop.groupChatId ? ['MISSING_CHAT_LINK_REQUIRES_REVIEW'] : shop.chatType !== 'GROUP' ? ['INVALID_CHAT_LINK_REQUIRES_REVIEW'] : []),
    ...(!shop.verifiedOwnerCount || shop.legacyOwnersWithoutOwnership ? ['OWNERSHIP_REVIEW_REQUIRED'] : []),
    ...(shop.legacyEmployeesWithoutMembership.length ? ['LEGACY_MEMBERSHIP_REVIEW_REQUIRED'] : []),
    ...(shop.memberships.some(m => m.status === 'ACTIVE' && !m.hasParticipantRow) ? ['ACTIVE_ROSTER_DERIVED_WITHOUT_PARTICIPANT_ROWS'] : []),
    ...(shop.staleEmployeeParticipantIds.length ? ['STALE_PARTICIPANTS_DO_NOT_GRANT_ACCESS'] : []),
  ] }));
  console.log(JSON.stringify({ readOnly: true, shopCount: shops.length, shops }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: 'Shop team diagnostics failed', code: error.code, name: error.name }));
  process.exitCode = 1;
} finally {
  await db.end();
}

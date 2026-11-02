-- Preserve all chats, participants and messages; add a durable shop boundary.
ALTER TABLE "Chat" ADD COLUMN "shopId" TEXT;
CREATE INDEX "Chat_shopId_type_idx" ON "Chat"("shopId", "type");
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Restore a dangling canonical ID only when no Chat exists, exactly one shop
-- references it, and the shop has verified ownership or active staff. Reusing
-- the ID preserves links; existing conversations and history are never replaced.
INSERT INTO "Chat" (id, name, type, "createdAt", "updatedAt", "shopId")
SELECT s."groupChatId", s.name || ' - Team Chat', 'GROUP'::"ChatType", now(), now(), s.id
FROM "Shop" s
WHERE s."shopType" = 'CUSTOMER' AND s."groupChatId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "Chat" c WHERE c.id = s."groupChatId")
  AND (SELECT count(*) FROM "Shop" linked WHERE linked."groupChatId" = s."groupChatId") = 1
  AND (EXISTS (SELECT 1 FROM "SupermarketOwnership" o WHERE o."shopId" = s.id)
    OR EXISTS (SELECT 1 FROM "ShopEmployeeMembership" m WHERE m."shopId" = s.id AND m.status = 'ACTIVE'))
ON CONFLICT (id) DO NOTHING;

WITH links AS (
  SELECT "groupChatId" AS id, min(id) AS "shopId" FROM "Shop"
  WHERE "groupChatId" IS NOT NULL
  GROUP BY "groupChatId" HAVING count(*) = 1 AND bool_and("shopType" = 'CUSTOMER')
)
UPDATE "Chat" c SET "shopId" = links."shopId" FROM links
WHERE c.id = links.id AND c.type = 'GROUP' AND c.name IS DISTINCT FROM 'ALL Chat';

-- Only backfill private histories with exactly one common verified shop for ALL
-- participants. Ambiguous/global histories stay stored, unscoped and inaccessible.
WITH eligible AS (
  SELECT 'CUSTOMER'::text AS kind, "customerId" AS uid, "shopId" FROM "SupermarketOwnership" WHERE "shopType" = 'CUSTOMER'
  UNION
  SELECT 'EMPLOYEE', m."employeeId", m."shopId" FROM "ShopEmployeeMembership" m
  JOIN "Shop" s ON s.id = m."shopId" WHERE m.status = 'ACTIVE' AND s."shopType" = 'CUSTOMER'
), candidates AS (
  SELECT p."chatId", e."shopId" FROM "ChatParticipant" p
  JOIN eligible e ON e.uid = p."userId" AND e.kind = p."userType"::text
  GROUP BY p."chatId", e."shopId"
  HAVING count(*) = (SELECT count(*) FROM "ChatParticipant" all_p WHERE all_p."chatId" = p."chatId")
), unique_shop AS (
  SELECT "chatId", min("shopId") AS "shopId" FROM candidates GROUP BY "chatId" HAVING count(*) = 1
)
UPDATE "Chat" c SET "shopId" = u."shopId" FROM unique_shop u
WHERE c.id = u."chatId" AND c."shopId" IS NULL
  AND c.name IS DISTINCT FROM 'ALL Chat'
  AND NOT EXISTS (SELECT 1 FROM "Shop" s WHERE s."groupChatId" = c.id)
  AND ((c.type = 'PERSONAL' AND (SELECT count(*) FROM "ChatParticipant" p WHERE p."chatId" = c.id) = 2)
    OR (c.type = 'GROUP' AND (SELECT count(*) FROM "ChatParticipant" p WHERE p."chatId" = c.id) >= 2));

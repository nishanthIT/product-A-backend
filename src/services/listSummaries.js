/**
 * The list screen only needs summaries, not every product, price and supplier.
 * Keep ownership/tracking and the selected supermarket in the same SQL query so
 * a slow database link does not require two sequential trees of relation reads.
 */
export async function getListSummaries(db, user) {
  const userId = Number(user.id);
  const userType = user.userType;
  const shopId = user.shopId ?? null;

  return db.$queryRaw`
    SELECT l."id", l."name", l."description", l."copiedFromId",
           l."createdAt", l."updatedAt",
           (SELECT (CASE
                     WHEN l."name" = 'Out of Stock' OR l."name" LIKE 'Out of Stock · %'
                     THEN COUNT(*)
                     ELSE COUNT(DISTINCT p."productId")
                   END)::integer
              FROM "ListProduct" lp
              JOIN "ProductAtShop" p ON p."id" = lp."productAtShopId"
             WHERE lp."listId" = l."id") AS "itemCount",
           (t."id" IS NOT NULL) AS "isShared",
           CASE WHEN t."id" IS NOT NULL
                THEN COALESCE(e."name", a."name", c."name")
                ELSE NULL END AS "copiedFromName"
      FROM "List" l
      LEFT JOIN "TrackedList" t
        ON t."listId" = l."id" AND t."userId" = ${userId}
       AND t."userType"::text = ${userType}
      LEFT JOIN "Empolyee" e ON e."id" = l."employeeId"
      LEFT JOIN "Admin" a ON a."id" = l."adminId"
      LEFT JOIN "Customer" c ON c."id" = l."customerId"
     WHERE (${userType} = 'ADMIN' AND l."adminId" = ${userId})
        OR (l."shopId" IS NOT DISTINCT FROM ${shopId}::text
       AND (( ${userType} = 'EMPLOYEE' AND l."employeeId" = ${userId} )
         OR ( ${userType} = 'CUSTOMER' AND l."customerId" = ${userId} )
         OR t."id" IS NOT NULL))
     ORDER BY COALESCE(l."updatedAt", l."createdAt") DESC, l."id" DESC
  `;
}

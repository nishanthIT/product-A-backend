// Classifies existing Empolyee rows into company staff / shop employees / needs-review
// and applies the result as membership rows. Used by scripts/migrateEmployeeMemberships.js
// and by the migration tests. Never infers ownership from names or email domains.

import { DEFAULT_COMPANY_STAFF_PERMISSIONS, defaultShopPermissions } from '../../src/services/accessControl.js';

// Commit 84fd964 (2026-03-03) introduced the shop-owner employee flow, which always
// records createdByCustomerId. Before it, only the company /addEmployee flow existed.
export const DEFAULT_SHOP_FLOW_CUTOFF = new Date('2026-03-03T00:00:00Z');
export const MIGRATION_SOURCE = 'MIGRATION_2026_10_SEPARATE_STAFF';

export const OUTCOME = Object.freeze({
  SHOP_EMPLOYEE: 'SHOP_EMPLOYEE',
  COMPANY_STAFF: 'COMPANY_STAFF',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
});

async function membershipTablesExist(prisma) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT to_regclass('"CompanyStaffMembership"') IS NOT NULL AS company,
            to_regclass('"ShopEmployeeMembership"') IS NOT NULL AS shop,
            to_regclass('"EmployeeAccessReview"') IS NOT NULL AS review`
  );
  const r = rows[0] || {};
  return !!(r.company && r.shop && r.review);
}

/** Read-only: gathers every relationship used as evidence. Works before the schema migration. */
export async function collectFacts(prisma) {
  const hasMembershipTables = await membershipTablesExist(prisma);

  const [employees, customers, shops, lists, tasks, groupChatParticipants, actionLogs, productAdds] = await Promise.all([
    prisma.empolyee.findMany({
      select: { id: true, shopId: true, createdByAdminId: true, createdByCustomerId: true, createdAt: true },
      orderBy: { id: 'asc' },
    }),
    prisma.customer.findMany({ select: { id: true, shopId: true } }),
    prisma.shop.findMany({ select: { id: true, shopType: true, groupChatId: true } }),
    prisma.list.groupBy({ by: ['employeeId', 'shopId'], where: { employeeId: { not: null } }, _count: { _all: true } }),
    prisma.taskAssignment.findMany({ select: { employeeId: true, task: { select: { shopId: true, createdById: true } } } }),
    prisma.chatParticipant.findMany({
      where: { userType: 'EMPLOYEE', chat: { type: 'GROUP' } },
      select: { userId: true, chatId: true },
    }),
    prisma.actionLog.groupBy({ by: ['employeeId', 'shopId'], _count: { _all: true } }),
    prisma.productAtShop.groupBy({ by: ['employeeId'], where: { employeeId: { not: null } }, _count: { _all: true } }),
  ]);

  let companyMemberships = [];
  let shopMemberships = [];
  let reviews = [];
  if (hasMembershipTables) {
    [companyMemberships, shopMemberships, reviews] = await Promise.all([
      prisma.companyStaffMembership.findMany({ select: { employeeId: true, status: true, source: true } }),
      prisma.shopEmployeeMembership.findMany({ select: { employeeId: true, shopId: true, status: true, source: true } }),
      prisma.employeeAccessReview.findMany({ select: { employeeId: true, reason: true, status: true } }),
    ]);
  }

  return { hasMembershipTables, employees, customers, shops, lists, tasks, groupChatParticipants, actionLogs, productAdds, companyMemberships, shopMemberships, reviews };
}

function index(facts) {
  const customerById = new Map(facts.customers.map((c) => [c.id, c]));
  const shopById = new Map(facts.shops.map((s) => [s.id, s]));
  const shopByGroupChat = new Map(facts.shops.filter((s) => s.groupChatId).map((s) => [s.groupChatId, s]));
  const group = (rows, key) => {
    const map = new Map();
    for (const row of rows) {
      const k = key(row);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(row);
    }
    return map;
  };
  return {
    customerById,
    shopById,
    shopByGroupChat,
    listsByEmployee: group(facts.lists, (r) => r.employeeId),
    tasksByEmployee: group(facts.tasks, (r) => r.employeeId),
    chatsByEmployee: group(facts.groupChatParticipants, (r) => r.userId),
    logsByEmployee: group(facts.actionLogs, (r) => r.employeeId),
    productAddsByEmployee: new Map(facts.productAdds.map((r) => [r.employeeId, r._count._all])),
    companyByEmployee: new Map(facts.companyMemberships.map((m) => [m.employeeId, m])),
    shopMembershipsByEmployee: group(facts.shopMemberships, (r) => r.employeeId),
    reviewsByEmployee: group(facts.reviews, (r) => r.employeeId),
  };
}

function evidenceFor(employee, idx) {
  const lists = idx.listsByEmployee.get(employee.id) ?? [];
  const tasks = idx.tasksByEmployee.get(employee.id) ?? [];
  const chats = idx.chatsByEmployee.get(employee.id) ?? [];
  const logs = idx.logsByEmployee.get(employee.id) ?? [];

  const listShopIds = [...new Set(lists.map((l) => l.shopId).filter(Boolean))];
  const taskShopIds = [...new Set(tasks.map((t) => t.task.shopId))];
  const chatShopIds = [...new Set(chats.map((c) => idx.shopByGroupChat.get(c.chatId)?.id).filter(Boolean))];

  let wholesaleCatalogActions = 0;
  let customerShopActions = 0;
  for (const log of logs) {
    const shop = idx.shopById.get(log.shopId);
    if (shop?.shopType === 'WHOLESALE') wholesaleCatalogActions += log._count._all;
    else customerShopActions += log._count._all;
  }

  return {
    listCount: lists.reduce((sum, l) => sum + l._count._all, 0),
    listShopIds,
    taskShopIds,
    groupChatShopIds: chatShopIds,
    wholesaleCatalogActions,
    customerShopActions,
    productAtShopRecords: idx.productAddsByEmployee.get(employee.id) ?? 0,
  };
}

/** Pure classification of one employee. */
export function classifyEmployee(employee, idx, { shopFlowCutoff = DEFAULT_SHOP_FLOW_CUTOFF } = {}) {
  const evidence = evidenceFor(employee, idx);
  const base = {
    employeeId: employee.id,
    createdAt: employee.createdAt,
    currentShopId: employee.shopId,
    createdByAdminId: employee.createdByAdminId,
    createdByCustomerId: employee.createdByCustomerId,
    evidence,
  };
  const review = (reason, detail) => ({ ...base, outcome: OUTCOME.NEEDS_REVIEW, reason, detail });

  const shopEvidenceIds = new Set([...evidence.listShopIds, ...evidence.taskShopIds, ...evidence.groupChatShopIds]);

  if (employee.createdByCustomerId != null) {
    const creator = idx.customerById.get(employee.createdByCustomerId);
    if (!creator) return review('CREATOR_MISSING', 'Created by a shop owner account that no longer exists');
    if (!employee.shopId && !creator.shopId) {
      return review('CREATOR_SHOP_MISSING', 'Created by a shop owner, but neither the employee nor the owner has an existing shop');
    }
    if (!employee.shopId) {
      return review('EMPLOYEE_SHOP_MISSING', "Employee's shop link is gone; the owner's current shop may be a different shop");
    }
    if (employee.shopId !== creator.shopId) {
      return review('SHOP_MISMATCH', "Employee's shop differs from the creating owner's shop");
    }
    const shop = idx.shopById.get(employee.shopId);
    if (!shop || shop.shopType !== 'CUSTOMER') {
      return review('SHOP_NOT_CUSTOMER_TYPE', 'Linked shop is not a customer shop');
    }
    const conflicting = [...shopEvidenceIds].filter((id) => id !== employee.shopId);
    if (conflicting.length > 0) {
      return review('CONFLICTING_SHOP_EVIDENCE', `Lists/tasks/chats reference other shops: ${conflicting.join(', ')}`);
    }
    return { ...base, outcome: OUTCOME.SHOP_EMPLOYEE, shopId: employee.shopId, detail: 'Creator owns the linked customer shop' };
  }

  if (employee.shopId) {
    return review('SHOP_WITHOUT_CREATOR', 'Linked to a shop but no shop-owner creator is recorded');
  }
  if (shopEvidenceIds.size > 0) {
    return review('SHOP_EVIDENCE_WITHOUT_CREATOR', `No creator recorded but has shop activity: ${[...shopEvidenceIds].join(', ')}`);
  }

  const createdBeforeShopFlow = new Date(employee.createdAt) < shopFlowCutoff;
  if (employee.createdByAdminId != null || createdBeforeShopFlow) {
    const why = employee.createdByAdminId != null
      ? 'Created by company admin'
      : 'Created before the shop-owner flow existed (company flow only)';
    return { ...base, outcome: OUTCOME.COMPANY_STAFF, detail: why };
  }

  // After the cutoff an orphaned shop employee (owner and shop deleted) looks the same, and
  // catalog activity may itself be the bug being fixed, so it is evidence, not proof.
  return review(
    'NO_PROVENANCE_AFTER_SHOP_FLOW',
    `No creator or shop recorded and created after the shop-owner flow existed (catalog actions: ${evidence.wholesaleCatalogActions})`
  );
}

/** Builds the full plan and dry-run report. Read-only. */
export function buildPlan(facts, options = {}) {
  const idx = index(facts);
  const items = facts.employees.map((employee) => {
    const company = idx.companyByEmployee.get(employee.id) ?? null;
    const shopMemberships = idx.shopMembershipsByEmployee.get(employee.id) ?? [];
    const reviews = idx.reviewsByEmployee.get(employee.id) ?? [];
    // Applying a review flag clears the employee's shop link, so flagged records are
    // never re-classified; their outcome is decided by the review.
    const classified = reviews.length > 0
      ? {
          employeeId: employee.id,
          createdAt: employee.createdAt,
          currentShopId: employee.shopId,
          createdByAdminId: employee.createdByAdminId,
          createdByCustomerId: employee.createdByCustomerId,
          evidence: evidenceFor(employee, idx),
          outcome: OUTCOME.NEEDS_REVIEW,
          reason: reviews[0].reason,
          detail: `Already flagged (${reviews.map((r) => r.status).join(', ')}); decided via access review`,
        }
      : classifyEmployee(employee, idx, options);
    // A shop-less record whose only gap is provenance is verified by an explicitly granted company membership.
    const result = classified.reason === 'NO_PROVENANCE_AFTER_SHOP_FLOW' && company && reviews.length === 0
      ? { ...classified, outcome: OUTCOME.COMPANY_STAFF, reason: undefined, detail: 'Company membership granted through the staff flow' }
      : classified;
    const actions = [];

    // Implicit company access is revoked (and sessions invalidated) once, on the run that first maps the record.
    if (result.outcome === OUTCOME.SHOP_EMPLOYEE) {
      if (!shopMemberships.some((m) => m.shopId === result.shopId)) {
        actions.push('CREATE_SHOP_MEMBERSHIP');
        if (!company) actions.push('REVOKE_IMPLICIT_COMPANY_ACCESS', 'INVALIDATE_SESSIONS');
      }
    } else if (result.outcome === OUTCOME.COMPANY_STAFF) {
      if (!company) actions.push('CREATE_COMPANY_MEMBERSHIP');
    } else if (!reviews.some((r) => r.reason === result.reason)) {
      actions.push('FLAG_FOR_REVIEW');
      if (!company) actions.push('REVOKE_IMPLICIT_COMPANY_ACCESS', 'INVALIDATE_SESSIONS');
    }

    return {
      ...result,
      existing: {
        companyMembership: company ? { status: company.status, source: company.source } : null,
        shopMemberships: shopMemberships.map((m) => ({ shopId: m.shopId, status: m.status, source: m.source })),
        reviews: reviews.map((r) => ({ reason: r.reason, status: r.status })),
      },
      actions,
    };
  });

  const count = (fn) => items.filter(fn).length;
  const summary = {
    totalEmployees: items.length,
    classifiedShopEmployees: count((i) => i.outcome === OUTCOME.SHOP_EMPLOYEE),
    classifiedCompanyStaff: count((i) => i.outcome === OUTCOME.COMPANY_STAFF),
    needsReview: count((i) => i.outcome === OUTCOME.NEEDS_REVIEW),
    shopMembershipsToCreate: count((i) => i.actions.includes('CREATE_SHOP_MEMBERSHIP')),
    companyMembershipsToCreate: count((i) => i.actions.includes('CREATE_COMPANY_MEMBERSHIP')),
    implicitCompanyAccessRevoked: count((i) => i.actions.includes('REVOKE_IMPLICIT_COMPANY_ACCESS')),
    reviewsToCreate: count((i) => i.actions.includes('FLAG_FOR_REVIEW')),
    sessionsToInvalidate: count((i) => i.actions.includes('INVALIDATE_SESSIONS')),
    alreadyMigrated: count((i) => i.actions.length === 0),
    reviewReasons: items
      .filter((i) => i.outcome === OUTCOME.NEEDS_REVIEW)
      .reduce((acc, i) => ({ ...acc, [i.reason]: (acc[i.reason] ?? 0) + 1 }), {}),
  };

  return { hasMembershipTables: facts.hasMembershipTables, summary, items };
}

/** Applies the plan in one transaction per employee. Returns ids created (for rollback). */
export async function applyPlan(prisma, plan) {
  if (!plan.hasMembershipTables) {
    throw new Error('Membership tables are missing. Run `npx prisma migrate deploy` first.');
  }
  const created = { companyMemberships: [], shopMemberships: [], reviews: [], sessionsInvalidated: [] };

  for (const item of plan.items) {
    if (item.actions.length === 0) continue;
    await prisma.$transaction(async (tx) => {
      if (item.actions.includes('CREATE_COMPANY_MEMBERSHIP')) {
        const m = await tx.companyStaffMembership.create({
          data: {
            employeeId: item.employeeId,
            role: 'STAFF',
            permissions: [...DEFAULT_COMPANY_STAFF_PERMISSIONS],
            status: 'ACTIVE',
            grantedByAdminId: item.createdByAdminId ?? null,
            source: MIGRATION_SOURCE,
          },
        });
        created.companyMemberships.push(m.id);
      }

      if (item.actions.includes('CREATE_SHOP_MEMBERSHIP')) {
        const otherActive = await tx.shopEmployeeMembership.findFirst({
          where: { employeeId: item.employeeId, status: 'ACTIVE' },
          select: { id: true },
        });
        const m = await tx.shopEmployeeMembership.create({
          data: {
            employeeId: item.employeeId,
            shopId: item.shopId,
            role: 'EMPLOYEE',
            permissions: defaultShopPermissions('EMPLOYEE'),
            status: otherActive ? 'INACTIVE' : 'ACTIVE',
            createdByCustomerId: item.createdByCustomerId,
            source: MIGRATION_SOURCE,
          },
        });
        created.shopMemberships.push(m.id);
      }

      if (item.actions.includes('FLAG_FOR_REVIEW')) {
        const r = await tx.employeeAccessReview.create({
          data: {
            employeeId: item.employeeId,
            reason: item.reason,
            evidence: JSON.parse(JSON.stringify({ detail: item.detail, ...item.evidence, createdByCustomerId: item.createdByCustomerId, currentShopId: item.currentShopId })),
          },
        });
        created.reviews.push(r.id);
      }

      // Mirror only an ACTIVE shop membership into the legacy pointer.
      const active = await tx.shopEmployeeMembership.findFirst({
        where: { employeeId: item.employeeId, status: 'ACTIVE' },
        select: { shopId: true },
      });
      await tx.empolyee.update({
        where: { id: item.employeeId },
        data: {
          shopId: active?.shopId ?? null,
          ...(item.actions.includes('INVALIDATE_SESSIONS') && { sessionVersion: { increment: 1 } }),
        },
      });
      if (item.actions.includes('INVALIDATE_SESSIONS')) created.sessionsInvalidated.push(item.employeeId);
    }, { maxWait: 30_000, timeout: 120_000 });
  }

  return created;
}

/** Removes exactly the rows a previous --apply run created. Accounts and lists are never touched. */
export async function rollbackRun(prisma, runLog) {
  const { created, snapshot } = runLog;
  await prisma.$transaction(async (tx) => {
    await tx.employeeAccessReview.deleteMany({ where: { id: { in: created.reviews } } });
    await tx.shopEmployeeMembership.deleteMany({ where: { id: { in: created.shopMemberships } } });
    await tx.companyStaffMembership.deleteMany({ where: { id: { in: created.companyMemberships } } });
    for (const row of snapshot) {
      await tx.empolyee.update({ where: { id: row.id }, data: { shopId: row.shopId } });
    }
  }, { maxWait: 30_000, timeout: 300_000 });
}

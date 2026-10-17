import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
// No mail or external notification is sent. Wire exit code/output to the approved host alerting service.
const db = new PrismaClient();
try {
  const now = Date.now();
  const [openReports, urgentReports, oldReports, overdueDeletions, retryingDeletions, externalReviews] = await Promise.all([
    db.contentReport.count({ where: { status: { in: ['PENDING', 'UNDER_REVIEW'] } } }),
    db.contentReport.count({ where: { status: { in: ['PENDING', 'UNDER_REVIEW'] }, reason: { in: ['CHILD_SAFETY', 'THREATS'] } } }),
    db.contentReport.count({ where: { status: { in: ['PENDING', 'UNDER_REVIEW'] }, createdAt: { lt: new Date(now - 86400000) } } }),
    db.accountDeletionJob.count({ where: { status: { not: 'COMPLETE' }, createdAt: { lt: new Date(now - 7 * 86400000) } } }),
    db.accountDeletionJob.count({ where: { status: { in: ['PROCESSING', 'FILES_PENDING'] }, updatedAt: { lt: new Date(now - 3600000) } } }),
    db.accountDeletionJob.count({ where: { status: 'EXTERNAL_REVIEW' } }),
  ]);
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), openReports, urgentReports, oldReports, overdueDeletions, retryingDeletions, externalReviews }));
  if (urgentReports || oldReports || overdueDeletions || retryingDeletions) process.exitCode = 2;
} finally { await db.$disconnect(); }

// Read-only verification; never seeds, repairs links or modifies chat data.
import 'dotenv/config';
import fs from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { verifyServiceSchema } from '../src/services/serviceReadiness.js';
import { listUserChats } from '../src/services/chatDirectory.js';
import { serviceError } from '../src/services/serviceErrors.js';
const db = new PrismaClient();
try {
  const report = await db.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const services = await verifyServiceSchema(tx);
    const fingerprints={};
    for(const table of ['Chat','Message','ChatParticipant']) {
      fingerprints[table]=(await tx.$queryRawUnsafe(`SELECT count(*)::int AS count, md5(coalesce(string_agg(md5(row_to_json(t)::text),'' ORDER BY id::text),'')) AS digest FROM "${table}" t`))[0];
    }
    const accounts=(await Promise.all(['admin','customer','empolyee'].map(model=>tx[model].findMany({select:{id:true,userType:true}})))).flat();
    const existing = await tx.chat.findMany({ select: { id: true, type: true, participants: { select: { userId: true, userType: true } } } });
    const candidateIds = user => existing.filter(c => (user.userType === 'ADMIN' && c.type === 'GROUP') || c.participants.some(p => p.userId === user.id && p.userType === user.userType)).map(c => c.id);
    const visible = new Set(), coverage = [], roles = new Set();
    accounts.sort((a,b) => candidateIds(b).length - candidateIds(a).length);
    for(const user of accounts) {
      if (roles.has(user.userType) && candidateIds(user).every(id => visible.has(id))) continue;
      const chats=await listUserChats(user,tx); chats.forEach(c=>visible.add(c.id));
      roles.add(user.userType);
      coverage.push({role:user.userType,groups:chats.filter(c=>c.type==='GROUP').length,direct:chats.filter(c=>c.type==='PERSONAL').length});
    }
    const pending=await tx.moderationDeletionJob.count({where:{status:{in:['PENDING','PROCESSING']}}});
    const unlinkedShops=await tx.shop.count({where:{shopType:'CUSTOMER',groupChatId:null}});
    return {checkedAt:new Date().toISOString(),services,fingerprints,accountsChecked:coverage.length,totalAccounts:accounts.length,coverage,conversationsVisibleToAuthorizedAccounts:visible.size,pendingModerationJobs:pending,unlinkedCustomerShops:unlinkedShops};
  },{maxWait:10000,timeout:180000});
  if(process.argv[2]) {
    const before=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
    report.chatDataUnchanged=JSON.stringify(before)===JSON.stringify(report.fingerprints);
  }
  console.log(JSON.stringify(report,null,2));
} catch(error) { console.error(JSON.stringify(serviceError(error)));process.exitCode=1; }
finally { await db.$disconnect(); }

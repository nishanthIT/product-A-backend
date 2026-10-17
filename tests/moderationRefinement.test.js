import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { getPrisma, resetDatabase, seedBase, startApp, createCompanyStaff } from './helpers/harness.js';
import { processModerationDeletion } from '../src/services/moderation.js';
let db, app, seed, a, b, admin, staff, chat, message, report;
before(async () => {
  await resetDatabase(); db = await getPrisma(); seed = await seedBase(db); app = await startApp();
  a = await app.login(seed.a.owner.email, seed.password); b = await app.login(seed.b.owner.email, seed.password); admin = await app.login(seed.admin.email, seed.password);
  const user = await createCompanyStaff(db, { email:'staff@moderation.test', passwordHash:seed.passwordHash, permissions:['content.manage'] });
  staff = await app.login(user.email, seed.password);
  chat = await db.chat.create({ data:{ name:'ALL Chat', type:'GROUP' } });
});
after(async () => { await app?.close(); await db?.$disconnect(); });
const post = (token, route, body) => app.request('POST', route, { token, body });
const send = (token, content) => post(token, '/chat/message', { chatId:chat.id, content });
test('new and existing accounts send, receive and upload without any acceptance row', async () => {
  await db.communityAcceptance.deleteMany();
  const fresh = await db.customer.create({ data:{ name:'Fresh', email:'fresh@moderation.test', mobile:'fresh', password:seed.passwordHash } });
  const login = await app.login(fresh.email,seed.password);
  const socket = await app.connectSocket(b.token); socket.emit('join_chat',chat.id); await setTimeout(60);
  for (const token of [a.token,login.token]) {
    const sent = await send(token,'immediate message'); assert.equal(sent.status,201);
    await setTimeout(60); assert.ok(socket.received.some(e => e.event === 'message_received' && e.payload.id === sent.body.message.id));
  }
  const form = new FormData(); form.append('file',new Blob(['synthetic moderation fixture'],{type:'text/plain'}),'fixture.txt');
  const upload = await fetch(`${app.origin}/api/chat/upload`,{method:'POST',headers:{Authorization:`Bearer ${a.token}`},body:form});
  assert.equal(upload.status,200);
  const file = (await upload.json()).file;
  const attached = await post(a.token,'/chat/message',{chatId:chat.id,content:'fixture attachment',attachmentUrl:file.url});
  assert.equal(attached.status,201);
  await app.request('DELETE',`/chat/message/${attached.body.message.id}`,{token:a.token});
  assert.equal(await db.communityAcceptance.count(),0);
});
test('report identity, explanation and exact snapshot persist; own and inaccessible reports fail; races dedupe', async () => {
  message = (await send(a.token,'original content for evidence')).body.message;
  assert.equal((await post(a.token,'/chat-safety/report',{messageId:message.id,reason:'ABUSE'})).status,400);
  const body = {messageId:message.id,reason:'SCAM',explanation:'Synthetic suspicious invoice test'};
  const replies = await Promise.all([post(b.token,'/chat-safety/report',body),post(b.token,'/chat-safety/report',body)]);
  assert.equal(replies[0].status,202); assert.equal(replies[1].body.id,replies[0].body.id); report = replies[0].body;
  const saved = await db.contentReport.findUnique({where:{id:report.id}});
  assert.equal(saved.reporterId,seed.b.owner.id); assert.equal(saved.reportedUserId,seed.a.owner.id); assert.equal(saved.chatId,chat.id); assert.equal(saved.explanation,body.explanation);
  const privateMessage = await db.message.create({data:{chatId:seed.a.shop.groupChatId,senderId:seed.a.owner.id,senderType:'CUSTOMER',content:'private'}});
  assert.equal((await post(b.token,'/chat-safety/report',{messageId:privateMessage.id,reason:'OTHER'})).status,404);
  assert.equal((await post(b.token,'/chat-safety/report',{...body,explanation:'a'.repeat(1001)})).status,400);
});
test('all admin operations reject customer and delegated staff, and never expose reporter details publicly', async () => {
  for (const token of [a.token,staff.token]) {
    for (const path of ['/reports',`/reports/${report.id}`,`/reports/${report.id}/attachment`,'/suspensions','/deletion-jobs']) assert.equal((await app.request('GET',`/chat-safety${path}`,{token})).status,403);
    for (const path of [`reports/${report.id}/status`,`reports/${report.id}/notes`,`reports/${report.id}/suspension`,`reports/${report.id}/delete-user-messages`,`messages/${message.id}/remove`,`suspensions/missing/lift`,`suspensions/missing/extend`]) assert.equal((await post(token,`/chat-safety/${path}`,{})).status,403);
  }
  assert.equal((await app.request('GET','/chat-safety/reports')).status,401);
});
test('admin can filter, investigate context, record internal notes and transition status without restricting account', async () => {
  const list = await app.request('GET',`/chat-safety/reports?reporter=CUSTOMER:${seed.b.owner.id}&reportedUser=CUSTOMER:${seed.a.owner.id}&status=PENDING&sort=reporter&direction=asc`,{token:admin.token});
  assert.equal(list.body.length,1); assert.equal(list.body[0].reporter.email,seed.b.owner.email); assert.equal(list.body[0].reportedUser.email,seed.a.owner.email);
  assert.equal((await app.request('GET','/chat-safety/reports?q=Alpha',{token:admin.token})).body.length,1);
  const detail = await app.request('GET',`/chat-safety/reports/${report.id}`,{token:admin.token}); assert.equal(detail.status,200); assert.ok(detail.body.context.length<=11); assert.ok(detail.body.context.every(m=>m.chatId===chat.id));
  for (const status of ['UNDER_REVIEW','RESOLVED','DISMISSED','PENDING']) assert.equal((await post(admin.token,`/chat-safety/reports/${report.id}/status`,{status,note:'Synthetic investigation decision'})).status,204);
  assert.equal((await post(admin.token,`/chat-safety/reports/${report.id}/notes`,{note:'Confidential internal fixture'})).status,204);
  assert.equal(await db.chatSuspension.count(),0); assert.equal((await send(a.token,'status alone permits chat')).status,201);
  assert.equal((await post(admin.token,`/chat-safety/reports/${report.id}/status`,{status:'INVALID',note:'invalid fixture'})).status,400);
});
test('account suspension denies existing sessions, login and socket reconnect; expiry and early reactivation preserve data', async () => {
  const socket = await app.connectSocket(a.token);
  const route = `/chat-safety/reports/${report.id}/suspension`;
  for (const minutes of [0,-1,1.5,43201,'60']) assert.equal((await post(admin.token,route,{scope:'ACCOUNT',minutes,reason:'invalid duration'})).status,400);
  const restricted = await post(admin.token,route,{scope:'ACCOUNT',minutes:60,reason:'Synthetic account investigation'}); assert.equal(restricted.status,200);
  await setTimeout(80); assert.equal(socket.connected,false);
  const result = await app.request('GET','/lists',{token:a.token}); assert.equal(result.status,403); assert.equal(result.body.code,'ACCOUNT_SUSPENDED');
  const deniedLogin = await app.login(seed.a.owner.email,seed.password);
  assert.equal(deniedLogin.status,403); assert.match(deniedLogin.body.error,/Synthetic account investigation/);
  await assert.rejects(app.connectSocket(a.token));
  assert.ok(await db.customer.findUnique({where:{id:seed.a.owner.id}}));
  assert.equal((await post(admin.token,`/chat-safety/suspensions/${restricted.body.id}/lift`,{reason:'Appeal accepted fixture'})).status,204);
  assert.equal((await app.request('GET','/lists',{token:a.token})).status,200);
  await post(admin.token,route,{scope:'ACCOUNT',minutes:1,reason:'Expiry restart fixture'});
  await db.chatSuspension.update({where:{id:restricted.body.id},data:{until:new Date(Date.now()-1000)}});
  await app.close(); app=await startApp(); assert.equal((await app.login(seed.a.owner.email,seed.password)).status,200);
});
test('chat and account restrictions are independent, custom durations expire and chat blocks direct API writes', async () => {
  const route=`/chat-safety/reports/${report.id}/suspension`;
  const chatBan=await post(admin.token,route,{scope:'CHAT',minutes:17,reason:'Synthetic chat restriction'}); assert.equal(chatBan.status,200);
  const accountBan=await post(admin.token,route,{scope:'ACCOUNT',minutes:60,reason:'Synthetic account restriction'}); assert.equal(accountBan.status,200);
  await post(admin.token,`/chat-safety/suspensions/${accountBan.body.id}/lift`,{reason:'Account appeal fixture'});
  assert.equal((await send(a.token,'blocked through API')).status,403); assert.equal((await app.request('GET','/lists',{token:a.token})).status,200);
  await post(admin.token,`/chat-safety/suspensions/${chatBan.body.id}/lift`,{reason:'Chat appeal accepted'});
  assert.equal((await send(a.token,'allowed now')).status,201);
});
test('individual deletion preserves evidence, other authors and report status; concurrent requests are idempotent', async () => {
  const other=(await send(b.token,'preserve peer message')).body.message;
  const body={reason:'Remove reported fixture',confirm:message.id};
  const responses=await Promise.all([post(admin.token,`/chat-safety/messages/${message.id}/remove`,body),post(admin.token,`/chat-safety/messages/${message.id}/remove`,body)]);
  assert.ok(responses.every(r=>r.status===204));
  assert.equal((await db.contentReport.findUnique({where:{id:report.id}})).status,'PENDING');
  const detail=await app.request('GET',`/chat-safety/reports/${report.id}`,{token:admin.token}); assert.equal(detail.body.evidence.content,'original content for evidence');
  assert.equal((await db.message.findUnique({where:{id:other.id}})).deletedAt,null);
  assert.equal(await db.chatModerationAction.count({where:{action:'REMOVE_MESSAGE'}}),1);
});
test('bulk deletion requires both confirmations, survives retry/restart and preserves newer messages and other authors', async () => {
  await db.message.createMany({data:Array.from({length:215},(_,i)=>({chatId:chat.id,senderId:seed.a.owner.id,senderType:'CUSTOMER',content:`bulk fixture ${i}`}))});
  const route=`/chat-safety/reports/${report.id}/delete-user-messages`,body={reason:'Synthetic bulk removal',confirm:`CUSTOMER:${seed.a.owner.id}`,confirmAll:true};
  assert.equal((await post(admin.token,route,{...body,confirmAll:false})).status,400);
  assert.equal((await post(admin.token,route,{...body,confirm:'CUSTOMER:99999'})).status,400);
  const requests=await Promise.all([post(admin.token,route,body),post(admin.token,route,body)]); assert.equal(requests[0].status,202); assert.equal(requests[0].body.id,requests[1].body.id);
  const job=requests[0].body;
  await setTimeout(5); const newer=(await send(a.token,'new message beyond cutoff')).body.message;
  const otherBefore=await db.message.count({where:{senderId:seed.b.owner.id,senderType:'CUSTOMER',deletedAt:null}});
  const first=await processModerationDeletion(job.id,{db}); assert.equal(first.status,'PROCESSING'); assert.equal(first.removed,100);
  await app.close(); app=await startApp();
  await Promise.all([processModerationDeletion(job.id,{db}),processModerationDeletion(job.id,{db})]);
  const done=await processModerationDeletion(job.id,{db}); assert.equal(done.status,'COMPLETED'); assert.ok(done.removed>=215);
  assert.equal((await processModerationDeletion(job.id,{db})).removed,done.removed);
  assert.equal((await db.message.findUnique({where:{id:newer.id}})).deletedAt,null);
  assert.equal(await db.message.count({where:{senderId:seed.b.owner.id,senderType:'CUSTOMER',deletedAt:null}}),otherBefore);
  assert.equal(await db.message.count({where:{senderId:seed.a.owner.id,senderType:'CUSTOMER',createdAt:{lte:new Date(job.cutoff)},deletedAt:null}}),0);
  assert.ok(await db.customer.findUnique({where:{id:seed.a.owner.id}}));
  assert.equal((await db.contentReport.findUnique({where:{id:report.id}})).evidence.content,'original content for evidence');
});

test('a failed bulk batch rolls back fully and the startup worker resumes the durable job', async () => {
  await db.message.createMany({data:[1,2,3].map(i=>({chatId:chat.id,senderId:seed.a.owner.id,senderType:'CUSTOMER',content:`retry fixture ${i}`}))});
  const response=await post(admin.token,`/chat-safety/reports/${report.id}/delete-user-messages`,{reason:'Synthetic rollback recovery',confirm:`CUSTOMER:${seed.a.owner.id}`,confirmAll:true});
  const job=response.body;
  const where={senderId:seed.a.owner.id,senderType:'CUSTOMER',deletedAt:null,createdAt:{lte:new Date(job.cutoff)}};
  const count=await db.message.count({where});
  const failingDb={ moderationDeletionJob:db.moderationDeletionJob, $transaction: (fn,options)=>db.$transaction(async tx=>{
    const update=tx.message.update.bind(tx.message);
    tx.message.update=async args=>{ await update(args); throw new Error('Synthetic batch failure'); };
    return fn(tx);
  },options) };
  await assert.rejects(processModerationDeletion(job.id,{db:failingDb}),/Synthetic batch failure/);
  assert.equal(await db.message.count({where}),count);
  const failed=await db.moderationDeletionJob.findUnique({where:{id:job.id}});
  assert.equal(failed.removed,0); assert.match(failed.lastError,/retried/);
  const {startModerationWorker}=await import('../src/services/moderation.js'); const stop=startModerationWorker();
  try {
    for(let i=0;i<30;i++) { if((await db.moderationDeletionJob.findUnique({where:{id:job.id}})).status==='COMPLETED') break; await setTimeout(100); }
    assert.equal((await db.moderationDeletionJob.findUnique({where:{id:job.id}})).status,'COMPLETED');
    assert.equal(await db.message.count({where}),0);
  } finally { stop(); }
});

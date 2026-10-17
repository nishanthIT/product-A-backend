import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { getPrisma, resetDatabase, seedBase, startApp, createCompanyStaff } from './helpers/harness.js';
let db, app, seed, owner, employee, third, custom, direct, all, employeeSession;
before(async () => {
  await resetDatabase(); db=await getPrisma(); seed=await seedBase(db); app=await startApp();
  owner=await app.login(seed.a.owner.email,seed.password);
  const group=await db.chat.create({data:{name:'Second shop - Team Chat',type:'GROUP'}});
  third=await db.shop.create({data:{name:'Second shop',address:'synthetic',mobile:'synthetic',shopType:'CUSTOMER',groupChatId:group.id}});
  await db.supermarketOwnership.create({data:{shopId:third.id,customerId:seed.a.owner.id,source:'TEST'}});
  employee=await createCompanyStaff(db,{email:'chat-staff@fixture.test',passwordHash:seed.passwordHash,permissions:['catalog.read']});
  await db.shopEmployeeMembership.create({data:{employeeId:employee.id,shopId:seed.a.shop.id,status:'ACTIVE',permissions:[]}});
  await db.shopEmployeeMembership.create({data:{employeeId:employee.id,shopId:third.id,status:'ACTIVE',permissions:[]}});
  employeeSession=await app.login(employee.email,seed.password);
  all=await db.chat.create({data:{name:'ALL Chat',type:'GROUP'}});
  custom=await db.chat.create({data:{name:'Existing custom group',type:'GROUP',participants:{create:[{userId:seed.a.owner.id,userType:'CUSTOMER'},{userId:employee.id,userType:'EMPLOYEE'}]}}});
  direct=await db.chat.create({data:{type:'PERSONAL',participants:{create:[{userId:seed.a.owner.id,userType:'CUSTOMER'},{userId:seed.admin.id,userType:'ADMIN'}]}}});
  await db.message.createMany({data:[
    {chatId:custom.id,senderId:employee.id,senderType:'EMPLOYEE',content:'old group history',createdAt:new Date('2020-01-02')},
    {chatId:direct.id,senderId:seed.admin.id,senderType:'ADMIN',content:'new direct history',createdAt:new Date()},
    {chatId:third.groupChatId,senderId:employee.id,senderType:'EMPLOYEE',content:'second shop history'},
  ]});
  // Stale membership in another owner's team must never grant private access.
  await db.chatParticipant.create({data:{chatId:seed.b.shop.groupChatId,userId:seed.a.owner.id,userType:'CUSTOMER'}});
});
after(async()=>{await app?.close();await db?.$disconnect();});
const snapshot=async()=>JSON.stringify(await Promise.all([db.chat.findMany({orderBy:{id:'asc'}}),db.message.findMany({orderBy:{id:'asc'}}),db.chatParticipant.findMany({orderBy:{id:'asc'}})]));
test('all authorized existing groups, teams and direct histories are visible; listing is strictly read-only',async()=>{
  const before=await snapshot();
  const response=await app.request('GET','/chat',{token:owner.token});
  assert.equal(response.status,200);
  const chats=response.body.chats,ids=chats.map(c=>c.id);
  for(const id of [all.id,custom.id,direct.id,seed.a.shop.groupChatId,third.groupChatId]) assert.ok(ids.includes(id));
  assert.ok(!ids.includes(seed.b.shop.groupChatId));
  assert.deepEqual(chats.map(c=>c.lastActivityAt),chats.map(c=>c.lastActivityAt).sort((a,b)=>new Date(b)-new Date(a)));
  const dm=chats.find(c=>c.id===direct.id);assert.equal(dm.name,seed.admin.name);assert.equal(dm.lastMessage,'new direct history');
  for(const id of [custom.id,direct.id,third.groupChatId]) {
    const thread=await app.request('GET',`/chat/${id}`,{token:owner.token});assert.equal(thread.status,200);assert.equal(thread.body.chat.messages.length,1);
  }
  assert.equal(await snapshot(),before);
});
test('team rosters derive from active memberships without recreating participant records',async()=>{
  const response=await app.request('GET','/chat',{token:owner.token});
  for(const id of [seed.a.shop.groupChatId,third.groupChatId]) {
    const chat=response.body.chats.find(c=>c.id===id);
    assert.ok(chat.participants.some(p=>p.id===employee.id&&p.userType==='EMPLOYEE'));
    assert.ok(chat.participants.some(p=>p.id===seed.a.owner.id&&p.userType==='CUSTOMER'));
  }
  assert.equal(await db.chatParticipant.count({where:{chatId:third.groupChatId}}),0);
  const employeeChats=await app.request('GET','/chat',{token:employeeSession.token});assert.equal(employeeChats.status,200);
  assert.ok(employeeChats.body.chats.some(c=>c.id===third.groupChatId));
  assert.equal((await app.request('GET',`/chat/${third.groupChatId}`,{token:employeeSession.token})).status,200);
  await db.shopEmployeeMembership.updateMany({where:{employeeId:employee.id,shopId:third.id},data:{status:'INACTIVE'}});
  const after=await app.request('GET','/chat',{token:owner.token});
  assert.ok(!after.body.chats.find(c=>c.id===third.groupChatId).participants.some(p=>p.id===employee.id&&p.userType==='EMPLOYEE'));
  assert.equal((await app.request('GET',`/chat/${third.groupChatId}`,{token:employeeSession.token})).status,403);
  assert.equal(await db.message.count({where:{chatId:third.groupChatId}}),1);
});
test('missing shop links do not trigger replacement chat creation',async()=>{
  const shop=await db.shop.create({data:{name:'Unlinked fixture',address:'x',mobile:'x',shopType:'CUSTOMER'}});
  await db.supermarketOwnership.create({data:{shopId:shop.id,customerId:seed.a.owner.id,source:'TEST'}});
  const before=await snapshot();
  assert.equal((await app.request('GET','/chat',{token:owner.token,shopId:shop.id})).status,200);
  assert.equal(await snapshot(),before);assert.equal((await db.shop.findUnique({where:{id:shop.id}})).groupChatId,null);
});

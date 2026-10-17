// Local read-only smoke test. The short-lived diagnostic token is never printed,
// persisted, or returned to a client. No credentials, users or chats are changed.
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { jwtSecret } from '../src/services/sessionSecurity.js';
import { serviceError } from '../src/services/serviceErrors.js';
const db=new PrismaClient();
const origin=`http://127.0.0.1:${Number(process.env.PORT||3000)}`;
try {
 const user=await db.customer.findFirst({where:{supermarketOwnerships:{some:{}}},select:{id:true,sessionVersion:true}});
 if(!user) throw new Error('No existing owner account available for read-only probe');
 const token=jwt.sign({id:user.id,userType:'CUSTOMER',sv:user.sessionVersion},jwtSecret(),{algorithm:'HS256',expiresIn:'60s'});
 const evidence={checkedAt:new Date().toISOString(),tests:[]};
 for(const route of ['/api/health','/api/auth/me','/api/chat']) {
  const started=Date.now();
  const response=await fetch(origin+route,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(60000)});
  const body=await response.json();
  const result={route,status:response.status,durationMs:Date.now()-started};
  if(route.endsWith('/health')){result.services=body.services;result.cache=body.cache;}
  if(route==='/api/chat'){
   result.conversations=body.chats?.length;result.groups=body.chats?.filter(c=>c.type==='GROUP').length;result.direct=body.chats?.filter(c=>c.type==='PERSONAL').length;
  }
  evidence.tests.push(result); if(response.status!==200)process.exitCode=1;
 }
 console.log(JSON.stringify(evidence,null,2));
}catch(error){console.error(JSON.stringify(serviceError(error)));process.exitCode=1;}finally{await db.$disconnect();}

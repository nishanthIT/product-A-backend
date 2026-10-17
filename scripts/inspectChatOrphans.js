import 'dotenv/config';
import pg from 'pg';
const db=new pg.Client({connectionString:process.env.DATABASE_URL});
try {
 await db.connect(); await db.query('BEGIN READ ONLY');
 const result=await db.query(`SELECT c.id,c.type,count(DISTINCT p.id)::int AS participants,
 count(DISTINCT p.id) FILTER (WHERE u.id IS NOT NULL OR e.id IS NOT NULL OR a.id IS NOT NULL)::int AS existing_accounts,
 (SELECT count(*)::int FROM "Message" m WHERE m."chatId"=c.id) AS messages,
 jsonb_agg(DISTINCT jsonb_build_object('type',p."userType",'accountExists',coalesce(u.id,e.id,a.id) IS NOT NULL,'declaredType',coalesce(u."userType",e."userType",a."userType"))) FILTER(WHERE p.id IS NOT NULL) AS identities
 FROM "Chat" c LEFT JOIN "ChatParticipant" p ON p."chatId"=c.id
 LEFT JOIN "Customer" u ON p."userType"='CUSTOMER' AND p."userId"=u.id
 LEFT JOIN "Empolyee" e ON p."userType"='EMPLOYEE' AND p."userId"=e.id
 LEFT JOIN "Admin" a ON p."userType"='ADMIN' AND p."userId"=a.id
 WHERE c.type='PERSONAL' GROUP BY c.id ORDER BY c.id`);
 console.log(JSON.stringify(result.rows,null,2)); await db.query('ROLLBACK');
} catch(e){console.error(JSON.stringify({code:e.code,name:e.name}));process.exitCode=1;}finally{await db.end();}

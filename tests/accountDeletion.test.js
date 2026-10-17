import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getPrisma, resetDatabase, seedBase, startApp, createCompanyStaff } from './helpers/harness.js';
import { processDeletion, requestDeletion } from '../src/services/accountDeletion.js';

let db, app, seed, files;
before(async () => { await resetDatabase(); db = await getPrisma(); seed = await seedBase(db); app = await startApp(); files = await fs.mkdtemp(path.join(os.tmpdir(), 'paymi-delete-test-')); });
after(async () => { await app?.close(); await db?.$disconnect(); if (files) await fs.rm(files, { recursive: true, force: true }); });

test('public deletion resource needs no app and does not embed credentials or permit framing', async () => {
  const res = await fetch(`${app.origin}/account-deletion`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const html = await res.text();
  assert.match(html, /Kaliam/); assert.match(html, /support@paymi.co.uk/);
  assert.match(html, /id="recovery"/); assert.match(html, /id="status"/);
});

test('request reauthenticates current account, is idempotent, and status requires a private receipt', async () => {
  const login = await app.login(seed.a.owner.email, seed.password);
  assert.equal((await app.request('POST', '/account-deletion/request', { body: { password: seed.password, confirmation: 'DELETE' } })).status, 401);
  assert.equal((await app.request('POST', '/account-deletion/request', { token: login.token, body: { password: 'wrong', confirmation: 'DELETE' } })).status, 403);
  const request = () => app.request('POST', '/account-deletion/request', { token: login.token, body: { password: seed.password, confirmation: 'DELETE', userId: seed.b.owner.id } });
  const first = await request(), second = await request();
  assert.equal(first.status, 202); assert.equal(second.status, 202);
  assert.equal(first.body.id, second.body.id); assert.notEqual(first.body.receipt, second.body.receipt);
  const rows = await db.accountDeletionJob.findMany();
  assert.equal(rows.length, 1); assert.equal(rows[0].userId, seed.a.owner.id);
  assert.notEqual(rows[0].receiptHash, second.body.receipt);
  assert.equal((await app.request('POST', '/account-deletion/status', { body: { receipt: first.body.receipt } })).status, 404);
  assert.equal((await app.request('POST', '/account-deletion/status', { body: { receipt: second.body.receipt } })).status, 200);
  assert.equal((await app.request('GET', '/account-deletion/queue', { token: login.token })).status, 403);
});

test('owner deletion preserves staff, co-owner, workspace, tasks and shared lists; files and stale sessions are removed', async () => {
  const { owner, shop } = seed.a;
  await db.supermarketOwnership.create({ data: { customerId: seed.b.owner.id, shopId: shop.id, source: 'VERIFIED_TEST_FIXTURE' } });
  const employee = await db.empolyee.create({ data: { email: 'worker@shop.test', name: 'Worker', phoneNo: 'worker', password: seed.passwordHash, createdByCustomerId: owner.id, shopMemberships: { create: { shopId: shop.id, createdByCustomerId: owner.id } } } });
  const task = await db.task.create({ data: { title: 'Keep shared task', createdById: owner.id, shopId: shop.id, assignments: { create: { employeeId: employee.id } } } });
  const shared = await db.list.create({ data: { name: 'Shared', description: '', customerId: owner.id, shopId: shop.id } });
  const personal = await db.list.create({ data: { name: 'Personal', description: '', customerId: owner.id } });
  await fs.mkdir(path.join(files, 'chat'));
  await fs.writeFile(path.join(files, 'chat', 'mine.jpg'), 'synthetic');
  await db.chatUpload.create({ data: { filename: 'mine.jpg', uploaderId: owner.id, uploaderType: 'CUSTOMER' } });
  await db.message.create({ data: { content: 'Personal message', chatId: shop.groupChatId, senderId: owner.id, senderType: 'CUSTOMER', attachmentUrl: '/uploads/chat/mine.jpg' } });
  const others = await db.message.create({ data: { content: 'Keep other member content', chatId: shop.groupChatId, senderId: seed.b.owner.id, senderType: 'CUSTOMER' } });
  const login = await app.login(owner.email, seed.password);
  const requested = await requestDeletion(db, { id: owner.id, userType: 'CUSTOMER' });
  const result = await processDeletion(db, requested.id, { uploadsRoot: files });
  assert.equal(result.status, 'EXTERNAL_REVIEW');
  assert.equal((await processDeletion(db, requested.id, { uploadsRoot: files })).status, 'EXTERNAL_REVIEW');
  assert.equal(await db.customer.findUnique({ where: { id: owner.id } }), null);
  assert.ok(await db.shop.findUnique({ where: { id: shop.id } }));
  assert.ok(await db.empolyee.findUnique({ where: { id: employee.id } }));
  assert.equal(await db.supermarketOwnership.count({ where: { shopId: shop.id } }), 1);
  assert.equal((await db.task.findUnique({ where: { id: task.id } })).createdById, null);
  assert.equal((await db.list.findUnique({ where: { id: shared.id } })).customerId, null);
  assert.equal(await db.list.findUnique({ where: { id: personal.id } }), null);
  assert.ok(await db.message.findUnique({ where: { id: others.id } }));
  await assert.rejects(fs.stat(path.join(files, 'chat', 'mine.jpg')), { code: 'ENOENT' });
  assert.equal((await app.request('GET', '/auth/me', { token: login.token })).status, 401);
  assert.equal((await app.request('GET', '/lists', { token: login.token })).status, 401);
  const status = await app.request('POST', '/account-deletion/status', { body: { receipt: requested.receipt } });
  assert.equal(status.status, 200); assert.equal(status.body.completedAt, null);
});

test('employee deletion cannot remove another role with the same ID; file errors remain retryable', async () => {
  const employee = await createCompanyStaff(db, { email: 'delete-employee@company.test', passwordHash: seed.passwordHash, permissions: [] });
  await fs.mkdir(path.join(files, 'chat', 'retry.jpg')); // unlink deliberately fails once
  await db.chatUpload.create({ data: { filename: 'retry.jpg', uploaderId: employee.id, uploaderType: 'EMPLOYEE' } });
  const request = await requestDeletion(db, { id: employee.id, userType: 'EMPLOYEE' });
  await assert.rejects(processDeletion(db, request.id, { uploadsRoot: files }));
  assert.equal((await db.accountDeletionJob.findUnique({ where: { id: request.id } })).status, 'FILES_PENDING');
  assert.equal(await db.empolyee.findUnique({ where: { id: employee.id } }), null);
  assert.ok(await db.customer.findUnique({ where: { id: seed.b.owner.id } }));
  await fs.rmdir(path.join(files, 'chat', 'retry.jpg'));
  assert.equal((await processDeletion(db, request.id, { uploadsRoot: files })).status, 'EXTERNAL_REVIEW');
});

test('admin deletion removes the account without deleting its managed shop', async () => {
  await db.admin.update({ where: { id: seed.admin.id }, data: { shopId: seed.wholesale.id } });
  const request = await requestDeletion(db, { id: seed.admin.id, userType: 'ADMIN' });
  await processDeletion(db, request.id, { uploadsRoot: files });
  assert.equal(await db.admin.findUnique({ where: { id: seed.admin.id } }), null);
  assert.ok(await db.shop.findUnique({ where: { id: seed.wholesale.id } }));
});

test('former employees can request deletion with credentials without regaining workspace access', async () => {
  const employee = await db.empolyee.create({ data: { email: 'departed@shop.test', name: 'Departed', phoneNo: 'departed', password: seed.passwordHash } });
  assert.notEqual((await app.login(employee.email, seed.password)).status, 200);
  const result = await app.request('POST', '/account-deletion/request-with-password', { body: { email: employee.email, password: seed.password, confirmation: 'DELETE' } });
  assert.equal(result.status, 202);
  assert.equal(result.body.token, undefined);
  const job = await db.accountDeletionJob.findUnique({ where: { id: result.body.id } });
  assert.equal(job.userType, 'EMPLOYEE'); assert.equal(job.userId, employee.id);
});

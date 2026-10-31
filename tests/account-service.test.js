import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountStore, createAuthService, validateCredentials, snapshotPayload, accountErrorMessage } from '../account-service.js';
import { solveArrangement } from '../arrangement.js';

const input = () => ({
  students: [{ id: '2501', score: 3, vision: true }, { id: '2502', score: 8, vision: false }], relations: [],
  settings: { groupCount: 2, groupColumns: 2, scoreMode: 'balanced', friendMode: 'ignore', respectVision: true, avoidPrevious: false },
});
const envelope = (owner = 'A') => ({
  classroom: { id: 'class', owner_id: owner, group_count: 2, group_columns: 2, score_mode: 'balanced', friend_mode: 'ignore', respect_vision: true, avoid_previous: false, revision: 1 },
  students: [{ id: 'db1', student_number: '2501', score: 3, vision_priority: true, sort_order: 0 }, { id: 'db2', student_number: '2502', score: 8, vision_priority: false, sort_order: 1 }],
  relations: [{ first_student_id: 'db1', second_student_id: 'db2', relation_type: 'friend' }],
});

test('signup validates email, minimum password and confirmation; signin permits existing shorter passwords', () => {
  const valid = { email: 'Teacher@example.com', password: 'test-pass-123', confirmation: 'test-pass-123' };
  assert.equal(validateCredentials(valid, 'signup'), '');
  for (const patch of [{ email: '' }, { email: 'not-email' }, { password: '1234567' }, { confirmation: 'different' }]) {
    assert.notEqual(validateCredentials({ ...valid, ...patch }, 'signup'), '');
  }
  assert.equal(validateCredentials({ email: 'a@example.com', password: '123456' }, 'signin'), '');
});

test('auth uses Supabase signup, signin and confirmation redirect without persisting passwords', async () => {
  const calls = [];
  const client = { auth: {
    signUp: async args => { calls.push(['signup', args]); return { data: { session: null } }; },
    signInWithPassword: async args => { calls.push(['signin', args]); return { data: { session: { user: { id: 'A' } } } }; },
    resend: async args => { calls.push(['resend', args]); return {}; },
    signOut: async args => { calls.push(['signout', args]); return {}; },
  } };
  const service = createAuthService(client, 'http://127.0.0.1:5173/');
  const credentials = { email: ' Teacher@Example.com ', password: 'test-pass-123', confirmation: 'test-pass-123' };
  assert.equal((await service.submit(credentials, 'signup')).session, null);
  assert.equal((await service.submit(credentials, 'signin')).session.user.id, 'A');
  await service.resend(credentials.email); await service.signOut();
  assert.deepEqual(calls.map(call => call[0]), ['signup', 'signin', 'resend', 'signout']);
  assert.equal(calls[0][1].email, 'teacher@example.com');
  assert.equal(calls[0][1].options.emailRedirectTo, 'http://127.0.0.1:5173/');
  assert.equal(calls[0][1].confirmation, undefined);
  assert.deepEqual(calls[3][1], { scope: 'local' });
  const count = calls.length;
  await assert.rejects(service.submit({ ...credentials, confirmation: 'bad' }, 'signup'), { code: 'INVALID_CREDENTIALS_INPUT' });
  await assert.rejects(service.resend('bad'), { code: 'INVALID_CREDENTIALS_INPUT' });
  assert.equal(calls.length, count);
});

test('failed signin does not invent an authenticated session', async () => {
  const service = createAuthService({ auth: { signInWithPassword: async () => ({ data: null, error: { code: 'invalid_credentials' } }) } }, 'http://localhost/');
  await assert.rejects(service.submit({ email: 'a@example.com', password: 'wrong' }, 'signin'), { code: 'invalid_credentials' });
});

test('saving makes one RPC containing an explicit owner, version and complete snapshot', async () => {
  const calls = [];
  const client = { rpc(name, args) { calls.push({ name, args }); return { abortSignal: async () => ({ data: envelope() }) }; } };
  const store = createAccountStore(client); store.setUser({ id: 'A' });
  const data = input();
  const result = solveArrangement(data, { seed: 1 });
  const saved = await store.save(data, { expectedRevision: 7, result });
  assert.equal(calls.length, 1); assert.equal(calls[0].name, 'save_classroom');
  assert.equal(calls[0].args.p_owner_id, 'A'); assert.equal(calls[0].args.p_expected_revision, 7);
  assert.equal(calls[0].args.p_snapshot.arrangement.assignments.length, 2);
  assert.equal(saved.students[0].id, '2501');
  assert.deepEqual(saved.relations, [{ first: '2501', second: '2502', type: 'friend' }]);
  assert.equal(saved.settings.groupColumns, 2);
});

test('signed-out or invalid input saves never call the DB', async () => {
  let calls = 0;
  const store = createAccountStore({ rpc() { calls++; throw new Error('must not call'); } });
  await assert.rejects(store.save(input()), { code: 'SIGNED_OUT' });
  store.setUser({ id: 'A' }); const data = input(); data.students[0].score = 99;
  await assert.rejects(store.save(data), { code: 'INVALID_INPUT' });
  assert.equal(calls, 0);
});

test('account changes abort old reads and stale data cannot be returned to the next account', async () => {
  let finish, signal;
  const store = createAccountStore({ rpc() { return { abortSignal(value) { signal = value; return new Promise(resolve => { finish = resolve; }); } }; } });
  store.setUser({ id: 'A' }); const read = store.load(); store.setUser({ id: 'B' });
  assert.equal(signal.aborted, true); finish({ data: envelope('A') });
  await assert.rejects(read, { code: 'SESSION_CHANGED' });
});

test('a foreign-owner response is rejected even if the server adapter is defective', async () => {
  const store = createAccountStore({ rpc() { return { abortSignal: async () => ({ data: envelope('B') }) }; } });
  store.setUser({ id: 'A' }); await assert.rejects(store.load(), { code: '42501' });
});

test('DB errors and deadlines propagate; duplicate save clicks are blocked', async () => {
  let finish;
  const store = createAccountStore({ rpc() { return { abortSignal: () => new Promise(resolve => { finish = resolve; }) }; } });
  store.setUser({ id: 'A' }); const save = store.save(input());
  await assert.rejects(store.save(input()), { code: 'SAVE_IN_PROGRESS' });
  finish({ error: { code: 'PT409', message: 'CLASSROOM_VERSION_CONFLICT' } });
  await assert.rejects(save, { code: 'PT409' });
  const timeoutStore = createAccountStore({ rpc() { return { abortSignal: signal => new Promise(resolve => signal.addEventListener('abort', () => resolve({ error: new Error('AbortError') }))) }; } }, { timeoutMs: 10 });
  timeoutStore.setUser({ id: 'A' }); await assert.rejects(timeoutStore.load(), /AbortError/);
});

test('snapshot excludes unrelated properties and invalid inputs; errors give actionable Korean messages', () => {
  const data = input(); data.students[0].unrelated = 'not sent';
  assert.equal(snapshotPayload(data).students[0].unrelated, undefined);
  assert.match(accountErrorMessage({ code: 'PGRST202' }), /supabase-schema.sql/);
  assert.match(accountErrorMessage({ code: 'email_not_confirmed' }), /이메일 인증/);
  assert.match(accountErrorMessage(new Error('Failed to fetch')), /서버에 연결/);
  assert.match(accountErrorMessage({ message: 'CLASSROOM_VERSION_CONFLICT' }), /다른 창/);
});

test('legacy optional layout settings are normalized to the database contract', () => {
  const data = input(); delete data.settings.groupColumns; delete data.settings.avoidPrevious;
  data.settings.unrelated = 'not sent';
  const payload = snapshotPayload(data);
  assert.equal(payload.settings.groupColumns, 2);
  assert.equal(payload.settings.avoidPrevious, false);
  assert.equal(payload.settings.unrelated, undefined);
});

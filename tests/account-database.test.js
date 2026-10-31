import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { snapshotPayload } from '../account-service.js';
import { solveArrangement } from '../arrangement.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const input = () => ({
  students: [1, 10, 2, 9].map((score, index) => ({ id: String(2501 + index), score, vision: index === 0 })),
  relations: [{ first: '2501', second: '2502', type: 'friend' }, { first: '2501', second: '2503', type: 'rival' }],
  settings: { groupCount: 2, groupColumns: 2, scoreMode: 'balanced', friendMode: 'together', respectVision: true, avoidPrevious: false },
});

// Real PostgreSQL SQL/RLS execution in an isolated, in-memory test DB.
// auth.users and auth.uid() are minimal test stubs, not an authentication server.
test('account database: atomic saves, RLS isolation and schema upgrades', { timeout: 60000 }, async t => {
  const db = await PGlite.create(); t.after(() => db.close());
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth, public to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);
  const schema = await readFile(new URL('../supabase-schema.sql', import.meta.url), 'utf8');
  await db.exec(schema); await db.exec(schema);
  await db.query('insert into auth.users(id) values ($1),($2)', [A, B]);
  async function asUser(user, action) {
    await db.exec(`set role ${user ? 'authenticated' : 'anon'}`);
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user ?? '']);
    try { return await action(); } finally { await db.exec('reset role'); }
  }
  const load = owner => db.query('select public.load_classroom($1) as data', [owner]).then(r => r.rows[0].data);
  const save = (owner, payload, version = null) => db.query('select public.save_classroom($1,$2::jsonb,$3) as data', [owner, JSON.stringify(payload), version]).then(r => r.rows[0].data);
  const data = input(); const payload = snapshotPayload(data, solveArrangement(data, { seed: 2 }));
  let savedA, savedB;

  await t.test('anonymous visitors can check readiness but cannot read or save account data', async () => {
    await asUser(null, async () => {
      assert.equal((await db.query('select public.classroom_backend_status() as status')).rows[0].status.schema_version, 3);
      await assert.rejects(load(A), /permission denied/);
      await assert.rejects(save(A, payload), /permission denied/);
      await assert.rejects(db.query('select * from public.students'), /permission denied/);
    });
  });
  await t.test('two owners can save the same student numbers without sharing rows', async () => {
    savedA = await asUser(A, () => save(A, payload));
    savedB = await asUser(B, () => save(B, payload));
    assert.notEqual(savedA.classroom.id, savedB.classroom.id);
    assert.notEqual(savedA.students[0].id, savedB.students[0].id);
    assert.equal(savedA.students.length, 4); assert.equal(savedA.relations.length, 2);
    assert.equal(savedA.classroom.revision, 1); assert.ok(savedA.run_id);
    await asUser(A, async () => {
      const loaded = await load(A);
      assert.equal(loaded.students[0].student_number, '2501');
      assert.equal(loaded.classroom.group_columns, 2);
      assert.equal((await db.query('select * from public.arrangement_assignments')).rows.length, 4);
    });
  });
  await t.test('RLS blocks foreign reads, updates, deletes and owner transfers', async () => {
    await asUser(A, async () => {
      for (const [table, expected] of [['classes', 1], ['students', 4], ['student_relations', 2], ['arrangement_runs', 1], ['arrangement_assignments', 4]]) {
        assert.equal((await db.query(`select * from public.${table}`)).rows.length, expected);
      }
      assert.equal((await db.query('update public.students set score=1 where class_id=$1 returning id', [savedB.classroom.id])).rows.length, 0);
      assert.equal((await db.query('delete from public.classes where id=$1 returning id', [savedB.classroom.id])).rows.length, 0);
      await assert.rejects(db.query('insert into public.classes(owner_id,name) values ($1,$2)', [B, 'forged']), /row-level security/);
      await assert.rejects(db.query('update public.classes set owner_id=$1 where id=$2', [B, savedA.classroom.id]), /row-level security/);
    });
    assert.equal((await asUser(B, () => load(B))).students.length, 4);
  });
  await t.test('foreign student references cannot be attached to owned relations or results', async () => {
    await asUser(A, async () => {
      await assert.rejects(db.query('insert into public.student_relations(class_id,first_student_id,second_student_id,relation_type) values ($1,$2,$3,$4)', [savedA.classroom.id, savedA.students[0].id, savedB.students[1].id, 'friend']), /row-level security/);
      await assert.rejects(db.query('insert into public.arrangement_assignments(run_id,student_id,group_number,seat_index) values ($1,$2,1,99)', [savedA.run_id, savedB.students[0].id]), /row-level security/);
    });
  });
  await t.test('RPC checks auth.uid even when the caller forges the owner argument', async () => {
    await asUser(A, async () => {
      await assert.rejects(load(B), /CLASSROOM_OWNER_MISMATCH/);
      await assert.rejects(save(B, payload), /CLASSROOM_OWNER_MISMATCH/);
      await assert.rejects(load(null), /CLASSROOM_OWNER_MISMATCH/);
    });
  });
  await t.test('existing data requires explicit overwrite acknowledgement and rejects stale versions', async () => {
    await asUser(A, async () => {
      await assert.rejects(save(A, payload), /CLASSROOM_LOAD_REQUIRED/);
      await assert.rejects(save(A, payload, 0), /CLASSROOM_VERSION_CONFLICT/);
      assert.equal((await load(A)).classroom.revision, 1);
    });
  });
  await t.test('removed students are hidden on reload but retained for old arrangement history', async () => {
    const smaller = input(); smaller.students.pop();
    savedA = await asUser(A, () => save(A, snapshotPayload(smaller), 1));
    assert.equal(savedA.students.length, 3); assert.equal(savedA.classroom.revision, 2);
    await asUser(A, async () => {
      assert.equal((await db.query('select * from public.students')).rows.length, 4);
      assert.equal((await db.query('select * from public.arrangement_assignments')).rows.length, 4);
    });
  });
  await t.test('late result failure rolls back students, relations, settings and revision together', async () => {
    await asUser(A, async () => {
      const before = await load(A);
      const invalid = structuredClone(payload); invalid.students[0].score = 8;
      invalid.arrangement.assignments[0].seatIndex = invalid.arrangement.assignments[1].seatIndex;
      await assert.rejects(save(A, invalid, 2), /CLASSROOM_INVALID_INPUT/);
      assert.deepEqual(await load(A), before);
      assert.equal((await db.query('select * from public.arrangement_runs')).rows.length, 1);
    });
  });
  await t.test('server validates malformed inputs even when frontend validation is bypassed', async () => {
    const mutations = [
      p => { p.students[0].score = 0; }, p => { p.students[0].id = p.students[1].id; },
      p => { p.students[0].vision = 'yes'; }, p => { p.settings.groupColumns = 3; },
      p => { p.relations[0].second = '9999'; }, p => { p.relations[0].second = p.relations[0].first; },
      p => { p.relations.push({ ...p.relations[0], first: p.relations[0].second, second: p.relations[0].first }); },
    ];
    await asUser(A, async () => {
      for (const mutate of mutations) { const invalid = structuredClone(payload); mutate(invalid); await assert.rejects(save(A, invalid, 2), /CLASSROOM_INVALID_INPUT/); }
      assert.equal((await load(A)).classroom.revision, 2);
    });
  });
  await t.test('reapplying schema preserves saved data and all RPCs remain security invoker', async () => {
    await db.exec(schema);
    assert.equal((await asUser(A, () => load(A))).classroom.revision, 2);
    const functions = await db.query("select prosecdef from pg_proc where proname in ('save_classroom','load_classroom','classroom_backend_status')");
    assert.equal(functions.rows.length, 3); assert.ok(functions.rows.every(row => row.prosecdef === false));
  });
});

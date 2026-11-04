import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const fixture = `
create role anon; create role authenticated; create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.user_id', true), '')::uuid $$;
create function auth.jwt() returns jsonb language sql as $$ select '{}'::jsonb $$;
create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb);
create table public.admin_users(user_id uuid primary key, active boolean);
create table public.budget_submissions(
 id uuid primary key default gen_random_uuid(), request_number text unique, requester_name text,
 requester_email text, institution text, justification text, status text, admin_notes text,
 created_at timestamptz default now(), reviewed_at timestamptz
);
create table public.submission_modifications(id uuid primary key default gen_random_uuid(),
 submission_id uuid references budget_submissions(id) on delete cascade, current_expenditure numeric);
create table public.budget_reference(
 id uuid primary key default gen_random_uuid(), source_key text unique, sync_batch text,
 institution text, title text, activity_title text, object_code text, budget numeric, budget_item_description text);
create table public.expenditure_reference(institution text, project text, object_code text, expenditure_amount numeric);
create function public.gen_random_bytes(n integer) returns bytea language sql as $$
 select substring(decode(replace(gen_random_uuid()::text, '-', ''), 'hex') from 1 for n) $$;
`;
const adminId = '00000000-0000-0000-0000-000000000001';
function lines(amount = 100) {
  return ['1000s', '2000s', '3000s', '4000s', '5000s', '6000s'].map((category, i) => ({
    title: 'Project R10', activity_title: 'Activity', object_category: category, object_code: category.slice(0, 4),
    current_budget: 0, current_budget_description: '', proposed_budget: i === 0 ? amount : 0,
    proposed_budget_description: i === 0 ? 'Budget description' : '', is_new_line: true
  }));
}

test('migrations, atomic budgets, private drafts, stale submissions and expenditure snapshots', async () => {
  const db = new PGlite();
  try {
    await db.exec(fixture);
    const migration = readFileSync(new URL('../DATABASE_SETUP.sql', import.meta.url), 'utf8')
      .replace('create extension if not exists pgcrypto;', '');
    await db.exec(migration);
    await db.exec(migration);
    await db.exec(`insert into institutions(name) values ('College');
      insert into admin_users values ('${adminId}', true);
      set test.user_id = '${adminId}';
      insert into college_allocations(institution, round, allocation_amount) values ('College','R10',100);`);
    const fingerprint = async () => (await db.query(`select budget_fingerprint('College','R10') hash`)).rows[0].hash;
    const before = await fingerprint();
    // Admins can save amounts over, under, or without allocation; requesters cannot.
    await db.query(`select admin_save_budget('College','R10',$1,'Manual correction',$2)`, [before, JSON.stringify(lines(250))]);
    assert.equal((await db.query('select sum(budget)::numeric total from budget_reference')).rows[0].total, '250');
    assert.equal((await db.query('select count(*)::integer n from budget_changes')).rows[0].n, 1);
    await db.query(`select admin_save_budget('College','R11',budget_fingerprint('College','R11'),'No allocation',$1)`,
      [JSON.stringify(lines(15))]);
    assert.equal((await db.query(`select sum(budget)::numeric total from budget_reference where round='R11'`)).rows[0].total, '15');
    await assert.rejects(db.query(`select admin_save_budget('College','R10',$1,'Stale',$2)`, [before, JSON.stringify(lines())]), /changed/);
    await db.exec(`set test.user_id = '';`);
    await assert.rejects(db.query(`select admin_save_budget('College','R10',$1,'Unauthorized',$2)`, [await fingerprint(), JSON.stringify(lines())]), /Not authorized/);
    await db.exec(`set test.user_id = '${adminId}';`);
    const token = 'a'.repeat(64);
    const payload = { projects: [], baselineHash: await fingerprint() };
    const draft = await db.query(`select save_budget_draft($1,0,'College','R10','Requester','requester@example.invalid',$2) result`, [token, JSON.stringify(payload)]);
    assert.equal(draft.rows[0].result.version, 1);
    const retried = await db.query(`select save_budget_draft($1,0,'College','R10','Requester','requester@example.invalid',$2) result`, [token, JSON.stringify(payload)]);
    assert.equal(retried.rows[0].result.version, 1);
    await assert.rejects(db.query(`select save_budget_draft($1,9,'College','R10','Requester','requester@example.invalid',$2)`, [token, JSON.stringify(payload)]), /another window/);
    await db.exec('set role anon;');
    await assert.rejects(db.query('select * from budget_drafts'), /permission denied/);
    await assert.rejects(db.query(`select save_budget_draft($1,0,'College','R10','Requester','requester@example.invalid',$2)`, [token, JSON.stringify(payload)]), /permission denied/);
    await db.exec('reset role;');
    const hash = await fingerprint();
    await assert.rejects(db.query(`select submit_budget_request('College','R10','Requester','requester@example.invalid','Reason',$1,$2)`,
      [JSON.stringify(lines(250)), hash]), /allocation/);
    await assert.rejects(db.query(`select submit_budget_request('College','R10','Requester','requester@example.invalid','Reason',$1,$2)`,
      [JSON.stringify(lines()), before]), /changed/);
    const submitted = await db.query(`select submit_budget_request('College','R10','Requester','requester@example.invalid','Reason',$1,$2,$3,1) result`,
      [JSON.stringify(lines()), hash, token]);
    const request = submitted.rows[0].result.request_number;
    assert.ok(request.startsWith('REQ-'));
    assert.equal((await db.query('select submitted_request from budget_drafts')).rows[0].submitted_request, request);
    await assert.rejects(db.query(`select submit_budget_request('College','R10','Requester','requester@example.invalid','Reason',$1,$2,$3,1)`,
      [JSON.stringify(lines()), hash, token]), /already submitted/);
    const id = (await db.query('select id from budget_submissions')).rows[0].id;
    await db.query(`update budget_submissions set status='Approved' where id=$1`, [id]);
    await db.query(`select admin_save_budget('College','R10',$1,'New correction',$2)`, [hash, JSON.stringify(lines(300))]);
    assert.equal((await db.query(`select get_request_edit_context($1) result`, [request])).rows[0].result.baseline_stale, true);
    await assert.rejects(db.query('select admin_finalize_submission($1)', [id]), /changed/);
    // A revision against the new baseline allows finalization, atomically.
    await db.query(`select submit_budget_request('College','R10','Requester','requester@example.invalid','Revised',$1,$2)`,
      [JSON.stringify(lines()), await fingerprint()]);
    assert.equal((await db.query('select count(*)::integer n from submission_revisions')).rows[0].n, 1);
    await db.query(`update budget_submissions set status='Approved' where id=$1`, [id]);
    await db.query('select admin_finalize_submission($1)', [id]);
    assert.equal((await db.query(`select sum(budget)::numeric total from budget_reference where round='R10'`)).rows[0].total, '100');
    // Protected manual/finalized budgets survive external imports.
    await db.exec(`insert into budget_reference(source_key,sync_batch,institution,round,title,activity_title,object_code,budget)
      values ('import','import:batch','College','R10','Project R10','Activity','1000',999);`);
    assert.equal((await db.query(`select sum(budget)::numeric total from budget_reference where round='R10'`)).rows[0].total, '100');
    const rows = [{ institution: 'College', round: 'R10', project: 'Project R10', object_category: '1000s', expenditure_amount: 20 }];
    await db.query('select replace_expenditure_snapshot($1,now())', [JSON.stringify(rows)]);
    await db.query('select replace_expenditure_snapshot($1,now())', [JSON.stringify(rows)]);
    assert.equal((await db.query('select sum(expenditure_amount)::numeric total from expenditure_snapshot')).rows[0].total, '20');
    await assert.rejects(db.query('select replace_expenditure_snapshot($1,now())', [JSON.stringify([])]), /Empty/);
    await assert.rejects(db.query('select replace_expenditure_snapshot($1,now())', [JSON.stringify([...rows, ...rows])]), /Duplicate/);
    await assert.rejects(db.query('select replace_expenditure_snapshot($1,now())', [
      JSON.stringify([{ ...rows[0], institution: 'Unknown' }])
    ]), /unknown institution/);
    assert.equal((await db.query(`select get_expenditures('College') result`)).rows[0].result.length, 1);
  } finally {
    await db.close();
  }
});

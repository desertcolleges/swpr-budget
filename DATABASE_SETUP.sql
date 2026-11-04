-- IEDRC Budget Modification: normalized object-category workflow + status portal setup
-- Run in Supabase SQL editor. Safe to re-run.

create extension if not exists pgcrypto;

create table if not exists public.site_config (
  id integer primary key,
  visible_rounds text[] not null default array['R10']::text[],
  updated_at timestamptz not null default now()
);

insert into public.site_config (id, visible_rounds)
values (1, array['R10']::text[])
on conflict (id) do nothing;

alter table public.submission_modifications
  add column if not exists round text,
  add column if not exists title text,
  add column if not exists activity_title text,
  add column if not exists object_category text,
  add column if not exists object_code text,
  add column if not exists current_budget numeric,
  add column if not exists proposed_budget numeric,
  add column if not exists current_budget_description text,
  add column if not exists proposed_budget_description text,
  add column if not exists activity_status text,
  add column if not exists is_new_line boolean not null default false;

-- Legacy compatibility columns (used by existing data and older requests)
alter table public.submission_modifications
  add column if not exists budget_item_description text,
  add column if not exists proposed_description text;

create index if not exists idx_submission_mod_submission_project_activity
  on public.submission_modifications (submission_id, title, activity_title);

-- One row per submission + project + activity + object category
create unique index if not exists uq_submission_mod_project_activity_category
  on public.submission_modifications (submission_id, title, activity_title, object_category);

alter table public.budget_submissions
  add column if not exists round text,
  add column if not exists status_access_token text;

create table if not exists public.activity_management (
  id uuid primary key default gen_random_uuid(),
  project_title text,
  activity_name text not null,
  object_code text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.site_config enable row level security;
alter table public.activity_management enable row level security;

-- Site config policies
DROP POLICY IF EXISTS "Public can read site config" ON public.site_config;
create policy "Public can read site config"
on public.site_config
for select
to anon, authenticated
using (true);

DROP POLICY IF EXISTS "Active admins can update site config" ON public.site_config;
create policy "Active admins can update site config"
on public.site_config
for update
to authenticated
using (
  exists (
    select 1
    from public.admin_users a
    where a.user_id = auth.uid() and a.active = true
  )
)
with check (
  exists (
    select 1
    from public.admin_users a
    where a.user_id = auth.uid() and a.active = true
  )
);

DROP POLICY IF EXISTS "Active admins can insert site config" ON public.site_config;
create policy "Active admins can insert site config"
on public.site_config
for insert
to authenticated
with check (
  exists (
    select 1
    from public.admin_users a
    where a.user_id = auth.uid() and a.active = true
  )
);

-- Activity management placeholder policies
DROP POLICY IF EXISTS "Active admins can read activity management" ON public.activity_management;
create policy "Active admins can read activity management"
on public.activity_management
for select
to authenticated
using (
  exists (
    select 1
    from public.admin_users a
    where a.user_id = auth.uid() and a.active = true
  )
);

DROP POLICY IF EXISTS "Active admins can manage activity management" ON public.activity_management;
create policy "Active admins can manage activity management"
on public.activity_management
for all
to authenticated
using (
  exists (
    select 1
    from public.admin_users a
    where a.user_id = auth.uid() and a.active = true
  )
)
with check (
  exists (
    select 1
    from public.admin_users a
    where a.user_id = auth.uid() and a.active = true
  )
);

-- Request status lookup by request number (semi-public).
-- Remove stale overload that makes rpc('get_request_status', {p_request_number}) ambiguous.
drop function if exists public.get_request_status(text, text, text);

create or replace function public.get_request_status(
  p_request_number text
)
returns table (
  submission_id uuid,
  request_number text,
  requester_name text,
  requester_email text,
  institution text,
  round text,
  status text,
  admin_notes text,
  justification text,
  created_at timestamptz,
  reviewed_at timestamptz,
  title text,
  activity_title text,
  object_category text,
  object_code text,
  current_budget_description text,
  proposed_budget_description text,
  current_budget numeric,
  proposed_budget numeric,
  is_new_line boolean,
  modification_round text
)
language sql
security definer
set search_path = public
as $$
  select
    bs.id as submission_id,
    bs.request_number,
    bs.requester_name,
    bs.requester_email,
    bs.institution,
    bs.round,
    bs.status,
    bs.admin_notes,
    bs.justification,
    bs.created_at,
    bs.reviewed_at,
    sm.title,
    sm.activity_title,
    sm.object_category,
    sm.object_code,
    coalesce(sm.current_budget_description, sm.budget_item_description) as current_budget_description,
    coalesce(sm.proposed_budget_description, sm.proposed_description) as proposed_budget_description,
    sm.current_budget,
    sm.proposed_budget,
    sm.is_new_line,
    sm.round as modification_round
  from public.budget_submissions bs
  left join public.submission_modifications sm
    on sm.submission_id = bs.id
  where lower(bs.request_number) = lower(trim(p_request_number));
$$;

revoke all on function public.get_request_status(text) from public;
grant execute on function public.get_request_status(text) to anon, authenticated;

-- Requesters read active approved activities.
DROP POLICY IF EXISTS "Public can read active activities" ON public.activity_management;
create policy "Public can read active activities"
on public.activity_management
for select
to anon, authenticated
using (is_active = true);

-- Per-college round allocations.
create table if not exists public.college_allocations (
  id uuid primary key default gen_random_uuid(),
  institution text not null,
  round text not null,
  allocation_amount numeric not null default 0,
  updated_at timestamptz not null default now(),
  unique (institution, round)
);

alter table public.college_allocations enable row level security;

DROP POLICY IF EXISTS "Public can read allocations" ON public.college_allocations;
create policy "Public can read allocations"
on public.college_allocations
for select
to anon, authenticated
using (true);

DROP POLICY IF EXISTS "Active admins can manage allocations" ON public.college_allocations;
create policy "Active admins can manage allocations"
on public.college_allocations
for all
to authenticated
using (
  exists (
    select 1 from public.admin_users a
    where a.user_id = auth.uid() and a.active = true
  )
)
with check (
  exists (
    select 1 from public.admin_users a
    where a.user_id = auth.uid() and a.active = true
  )
);

-- Editable institution list.
create table if not exists public.institutions (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- One-time seed from the pre-existing get_public_institutions() function.
do $$
begin
  if not exists (select 1 from public.institutions) then
    begin
      insert into public.institutions (name)
      select distinct institution from public.get_public_institutions()
      where institution is not null
      on conflict do nothing;
    exception when others then
      insert into public.institutions (name)
      select distinct institution from public.college_allocations
      on conflict do nothing;
    end;
  end if;
end $$;

alter table public.institutions enable row level security;

DROP POLICY IF EXISTS "Public can read active institutions" ON public.institutions;
create policy "Public can read active institutions"
on public.institutions
for select
to anon, authenticated
using (is_active = true);

DROP POLICY IF EXISTS "Active admins can manage institutions" ON public.institutions;
create policy "Active admins can manage institutions"
on public.institutions
for all
to authenticated
using (
  exists (
    select 1 from public.admin_users a
    where a.user_id = auth.uid() and a.active = true
  )
)
with check (
  exists (
    select 1 from public.admin_users a
    where a.user_id = auth.uid() and a.active = true
  )
);

-- Requester/admin dropdown source (now backed by the institutions table).
create or replace function public.get_public_institutions()
returns table (institution text)
language sql
security definer
set search_path = public
as $$
  select name from public.institutions where is_active order by name;
$$;

grant execute on function public.get_public_institutions() to anon, authenticated;

-- Rename an institution and keep existing records in sync.
create or replace function public.rename_institution(p_id uuid, p_new_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old text;
begin
  if not exists (
    select 1 from public.admin_users a
    where a.user_id = auth.uid() and a.active = true
  ) then
    raise exception 'Not authorized';
  end if;

  select name into v_old from public.institutions where id = p_id;
  if v_old is null then
    raise exception 'Institution not found';
  end if;

  update public.institutions set name = btrim(p_new_name) where id = p_id;
  update public.college_allocations set institution = btrim(p_new_name) where institution = v_old;
  update public.budget_submissions set institution = btrim(p_new_name) where institution = v_old;
end;
$$;

grant execute on function public.rename_institution(uuid, text) to authenticated;

-- =====================================================================
-- Projects (each belongs to exactly one round) and their activities
-- =====================================================================
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  round text check (round is null or round ~ '^R[0-9]+$'),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.project_activities (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  activity_name text not null,
  created_at timestamptz not null default now(),
  unique (project_id, activity_name)
);

alter table public.projects enable row level security;
alter table public.project_activities enable row level security;

DROP POLICY IF EXISTS "Public can read active projects" ON public.projects;
create policy "Public can read active projects"
on public.projects for select to anon, authenticated
using (is_active = true);

DROP POLICY IF EXISTS "Active admins can manage projects" ON public.projects;
create policy "Active admins can manage projects"
on public.projects for all to authenticated
using (exists (select 1 from public.admin_users a where a.user_id = auth.uid() and a.active = true))
with check (exists (select 1 from public.admin_users a where a.user_id = auth.uid() and a.active = true));

DROP POLICY IF EXISTS "Public can read activities of active projects" ON public.project_activities;
create policy "Public can read activities of active projects"
on public.project_activities for select to anon, authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.is_active = true));

DROP POLICY IF EXISTS "Active admins can manage project activities" ON public.project_activities;
create policy "Active admins can manage project activities"
on public.project_activities for all to authenticated
using (exists (select 1 from public.admin_users a where a.user_id = auth.uid() and a.active = true))
with check (exists (select 1 from public.admin_users a where a.user_id = auth.uid() and a.active = true));

-- One-time seed from the legacy activity_management table.
-- Round is parsed from the project name when it contains an "R<number>" token; otherwise it is
-- left blank (project hidden from requesters until you set a round on the Projects tab).
-- Legacy activities with no project are copied into every seeded project.
do $$
begin
  if not exists (select 1 from public.projects) then
    insert into public.projects (name, round)
    select distinct btrim(project_title),
           case when project_title ~* '\mR\s*[0-9]+\M'
                then 'R' || ((regexp_match(project_title, '\mR\s*([0-9]+)\M', 'i'))[1])::int
           end
    from public.activity_management
    where project_title is not null and btrim(project_title) <> ''
    on conflict (name) do nothing;

    insert into public.project_activities (project_id, activity_name)
    select p.id, btrim(am.activity_name)
    from public.activity_management am
    join public.projects p on lower(p.name) = lower(btrim(am.project_title))
    where am.is_active
    on conflict do nothing;

    insert into public.project_activities (project_id, activity_name)
    select p.id, btrim(am.activity_name)
    from public.activity_management am
    cross join public.projects p
    where am.is_active and (am.project_title is null or btrim(am.project_title) = '')
    on conflict do nothing;
  end if;
end $$;

-- Copy a project (and its activities) under a new name/round.
create or replace function public.copy_project(p_source uuid, p_name text, p_round text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new uuid;
begin
  if not exists (
    select 1 from public.admin_users a where a.user_id = auth.uid() and a.active = true
  ) then
    raise exception 'Not authorized';
  end if;

  insert into public.projects (name, round, is_active)
  values (btrim(p_name), p_round, true)
  returning id into v_new;

  insert into public.project_activities (project_id, activity_name)
  select v_new, activity_name from public.project_activities where project_id = p_source;

  return v_new;
end;
$$;

grant execute on function public.copy_project(uuid, text, text) to authenticated;

-- =====================================================================
-- Google SSO: admin allow-list (desertcolleges.org accounts only)
-- =====================================================================
create table if not exists public.admin_allowlist (
  email text primary key check (lower(email) like '%@desertcolleges.org' and email = lower(email)),
  display_name text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.admin_allowlist enable row level security;

DROP POLICY IF EXISTS "Active admins can manage allowlist" ON public.admin_allowlist;
create policy "Active admins can manage allowlist"
on public.admin_allowlist for all to authenticated
using (exists (select 1 from public.admin_users a where a.user_id = auth.uid() and a.active = true))
with check (exists (select 1 from public.admin_users a where a.user_id = auth.uid() and a.active = true));

-- Seed the allow-list from existing admins that already have a desertcolleges.org email.
insert into public.admin_allowlist (email, display_name)
select lower(u.email), coalesce(u.raw_user_meta_data->>'full_name', '')
from public.admin_users a
join auth.users u on u.id = a.user_id
where a.active = true and lower(u.email) like '%@desertcolleges.org'
on conflict (email) do nothing;

-- Called after Google sign-in: grants admin access if the account is on the allow-list.
create or replace function public.claim_admin_access()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if auth.uid() is null or v_email not like '%@desertcolleges.org' then
    return false;
  end if;

  if not exists (
    select 1 from public.admin_allowlist where email = v_email and active = true
  ) then
    return false;
  end if;

  update public.admin_users set active = true where user_id = auth.uid();
  if not found then
    insert into public.admin_users (user_id, active) values (auth.uid(), true);
  end if;
  return true;
end;
$$;

grant execute on function public.claim_admin_access() to authenticated;

-- Keep admin_users in sync when an allow-list entry is deactivated, deleted, or re-emailed.
create or replace function public.sync_admin_allowlist()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    update public.admin_users set active = false
    where user_id in (select id from auth.users where lower(email) = old.email)
      and (tg_op = 'DELETE' or not new.active or new.email <> old.email);
  end if;
  return coalesce(new, old);
end;
$$;

DROP TRIGGER IF EXISTS trg_sync_admin_allowlist ON public.admin_allowlist;
create trigger trg_sync_admin_allowlist
after update or delete on public.admin_allowlist
for each row execute function public.sync_admin_allowlist();

-- ---------------------------------------------------------------------------
-- Modification lifecycle: one open request per institution + round,
-- Finalized status, revision history, admin delete, requester history.
-- Open = Pending, Approved or Rejected (editable and resubmittable).
-- Finalized closes the request so a fresh one can be started.
-- ---------------------------------------------------------------------------

-- Drop any legacy CHECK constraint limiting status values.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.budget_submissions'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format('alter table public.budget_submissions drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.budget_submissions
  add column if not exists revision_no integer not null default 1,
  add column if not exists finalized_at timestamptz,
  add column if not exists updated_at timestamptz;

-- Guarded: skipped with a notice if duplicate open requests already exist; resolve them, then re-run.
do $$
begin
  create unique index if not exists uq_one_open_request_per_round
    on public.budget_submissions (lower(institution), upper(round))
    where status in ('Pending', 'Approved', 'Rejected');
exception when unique_violation then
  raise notice 'Duplicate open requests exist for an institution/round; delete or Finalize extras, then re-run to enforce one open request.';
end $$;

-- Snapshot of each prior version, written by the submit-budget edge function on resubmission.
create table if not exists public.submission_revisions (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.budget_submissions(id) on delete cascade,
  revision_no integer not null,
  status text,
  justification text,
  admin_notes text,
  modifications jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.submission_revisions enable row level security;

DROP POLICY IF EXISTS "Active admins can read revisions" ON public.submission_revisions;
create policy "Active admins can read revisions"
on public.submission_revisions for select to authenticated
using (exists (select 1 from public.admin_users a where a.user_id = auth.uid() and a.active = true));

-- Admin delete (removes line items and revisions too).
create or replace function public.admin_delete_submission(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.admin_users a where a.user_id = auth.uid() and a.active = true) then
    raise exception 'Not authorized';
  end if;
  delete from public.submission_modifications where submission_id = p_id;
  delete from public.submission_revisions where submission_id = p_id;
  delete from public.budget_submissions where id = p_id;
end;
$$;

revoke all on function public.admin_delete_submission(uuid) from public;
grant execute on function public.admin_delete_submission(uuid) to authenticated;

-- Requester history for an institution + round (semi-public, like get_request_status).
create or replace function public.get_round_history(p_institution text, p_round text)
returns table (
  request_number text,
  requester_name text,
  requester_email text,
  status text,
  justification text,
  admin_notes text,
  revision_no integer,
  created_at timestamptz,
  reviewed_at timestamptz,
  finalized_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select bs.request_number, bs.requester_name, bs.requester_email, bs.status,
         bs.justification, bs.admin_notes, bs.revision_no,
         bs.created_at, bs.reviewed_at, bs.finalized_at
  from public.budget_submissions bs
  where lower(bs.institution) = lower(trim(p_institution))
    and upper(bs.round) = upper(trim(p_round))
  order by bs.created_at desc;
$$;

revoke all on function public.get_round_history(text, text) from public;
grant execute on function public.get_round_history(text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Finalize applies the approved request as the new budget for that
-- institution + round. Prior values stay in submission_modifications
-- (current_budget vs proposed_budget) and submission_revisions.
-- ---------------------------------------------------------------------------

alter table public.budget_reference
  add column if not exists round text;

-- Backfill round from the title (e.g. "... R10 ...") for existing rows.
update public.budget_reference
set round = 'R' || ((regexp_match(title, '\mR\s*(\d+)\M', 'i'))[1])::int
where round is null
  and title ~* '\mR\s*\d+\M';

create index if not exists idx_budget_reference_institution_round
  on public.budget_reference (institution, round);

create or replace function public.admin_finalize_submission(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.budget_submissions%rowtype;
begin
  if not exists (select 1 from public.admin_users a where a.user_id = auth.uid() and a.active = true) then
    raise exception 'Not authorized';
  end if;

  select * into s from public.budget_submissions where id = p_id;

  if not found then
    raise exception 'Request not found';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(lower(s.institution) || '|' || upper(s.round), 0));
  select * into s from public.budget_submissions where id = p_id for update;
  if not found then raise exception 'Request not found'; end if;
  if s.status <> 'Approved' then
    raise exception 'Only approved requests can be finalized';
  end if;

  if (s.baseline_hash is not null and s.baseline_hash <> public.budget_fingerprint(s.institution, s.round))
     or (s.baseline_hash is null and exists (
       select 1 from public.budget_changes c
       where lower(c.institution) = lower(s.institution) and upper(c.round) = upper(s.round)
         and c.created_at > s.created_at
     )) then
    raise exception 'The budget changed after this request was prepared. Revise and resubmit it before finalizing.';
  end if;

  -- Lets the guard trigger below allow this function to replace finalized rows.
  perform set_config('app.finalizing', 'on', true);

  -- The submitted budget replaces the whole round budget, so projects,
  -- activities and object codes may be added, removed or changed.
  delete from public.budget_reference
  where lower(institution) = lower(s.institution)
    and upper(round) = upper(s.round);

  insert into public.budget_reference
    (source_key, sync_batch, institution, round, title, activity_title, object_code, budget, budget_item_description)
  select
    'finalized:' || s.request_number || ':' || md5(
      coalesce(sm.title, '') || '|' || coalesce(sm.activity_title, '') || '|' || coalesce(sm.object_category, '')
    ),
    'finalized:' || s.request_number,
    s.institution,
    upper(s.round),
    sm.title,
    sm.activity_title,
    coalesce(nullif(trim(sm.object_code), ''), left(sm.object_category, 1) || '000'),
    coalesce(sm.proposed_budget, 0),
    coalesce(sm.proposed_budget_description, '')
  from public.submission_modifications sm
  where sm.submission_id = p_id
    and (coalesce(sm.proposed_budget, 0) > 0 or coalesce(sm.proposed_budget_description, '') <> '');

  perform set_config('app.finalizing', 'off', true);

  delete from public.budget_round_resets
  where lower(institution) = lower(s.institution) and upper(round) = upper(s.round);

  update public.budget_submissions
  set status = 'Finalized', finalized_at = now(), updated_at = now()
  where id = p_id;
end;
$$;

revoke all on function public.admin_finalize_submission(uuid) from public;
grant execute on function public.admin_finalize_submission(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Guard finalized budgets against the external import into budget_reference.
-- Rows written by admin_finalize_submission have sync_batch 'finalized:...'.
--  * Imported rows for an institution + round that has finalized rows are skipped.
--  * Finalized rows cannot be updated or deleted except by admin_finalize_submission.
--  * TRUNCATE is refused while finalized rows exist.
-- Imported rows without a round also get round filled in from the title.
-- ---------------------------------------------------------------------------

-- Rounds an admin has reset; imports for these institution + rounds are skipped until a budget is finalized.
create table if not exists public.budget_round_resets (
  institution text not null,
  round text not null,
  reset_at timestamptz not null default now(),
  reset_by uuid,
  primary key (institution, round)
);

alter table public.budget_round_resets enable row level security;

create or replace function public.guard_budget_reference_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round text;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    lower(case when tg_op = 'DELETE' then old.institution else new.institution end) || '|' ||
    upper(coalesce(case when tg_op = 'DELETE' then old.round else new.round end, '')), 0));
  if tg_op = 'INSERT' then
    v_round := upper(coalesce(
      nullif(new.round, ''),
      'R' || ((regexp_match(new.title, '\mR\s*(\d+)\M', 'i'))[1])::int
    ));

    if new.round is null then
      new.round := v_round;
    end if;
    perform pg_advisory_xact_lock(hashtextextended(lower(new.institution) || '|' || coalesce(v_round, ''), 0));

    if coalesce(new.sync_batch, '') not like 'finalized:%'
       and v_round is not null
       and (
         exists (
           select 1 from public.budget_reference b
           where b.sync_batch like 'finalized:%'
             and lower(b.institution) = lower(new.institution)
             and upper(b.round) = v_round
         )
         or exists (
           select 1 from public.budget_round_resets r
           where lower(r.institution) = lower(new.institution)
             and upper(r.round) = v_round
         )
       ) then
      return null;
    end if;

    return new;
  end if;

  if old.sync_batch like 'finalized:%'
     and coalesce(current_setting('app.finalizing', true), '') <> 'on' then
    return null;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_budget_reference_write on public.budget_reference;
create trigger trg_guard_budget_reference_write
before insert or update or delete on public.budget_reference
for each row execute function public.guard_budget_reference_write();

create or replace function public.guard_budget_reference_truncate()
returns trigger
language plpgsql
as $$
begin
  if exists (select 1 from public.budget_reference where sync_batch like 'finalized:%') then
    raise exception 'budget_reference contains finalized budgets; delete non-finalized rows instead of truncating';
  end if;
  return null;
end;
$$;

drop trigger if exists trg_guard_budget_reference_truncate on public.budget_reference;
create trigger trg_guard_budget_reference_truncate
before truncate on public.budget_reference
for each statement execute function public.guard_budget_reference_truncate();

-- ---------------------------------------------------------------------------
-- Admin reset of a college's budget for a round. Removes the budget so the
-- requester must build a new one (like a new allocation). Open requests are
-- closed with status 'Reset'; all requests and revisions stay in history.
-- ---------------------------------------------------------------------------

create or replace function public.admin_reset_budget(p_institution text, p_round text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round text := upper(trim(p_round));
begin
  if not exists (select 1 from public.admin_users a where a.user_id = auth.uid() and a.active = true) then
    raise exception 'Not authorized';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(lower(trim(p_institution)) || '|' || v_round, 0));
  perform set_config('app.finalizing', 'on', true);

  delete from public.budget_reference
  where lower(institution) = lower(trim(p_institution))
    and (
      upper(round) = v_round
      or (round is null and upper(title) ~ ('\m' || v_round || '\M'))
    );

  perform set_config('app.finalizing', 'off', true);

  update public.budget_submissions
  set status = 'Reset', updated_at = now()
  where lower(institution) = lower(trim(p_institution))
    and upper(round) = v_round
    and status in ('Pending', 'Approved', 'Rejected');

  insert into public.budget_round_resets (institution, round, reset_by)
  values (trim(p_institution), v_round, auth.uid())
  on conflict (institution, round) do update set reset_at = now(), reset_by = auth.uid();
end;
$$;

revoke all on function public.admin_reset_budget(text, text) from public;
grant execute on function public.admin_reset_budget(text, text) to authenticated;

-- Private drafts, atomic submissions/admin edits, and project-category expenditures.
alter table public.budget_submissions
  add column if not exists baseline_hash text,
  add column if not exists baseline_rows jsonb;

create or replace function public.budget_fingerprint(p_institution text, p_round text)
returns text language sql stable security definer set search_path = public as $$
  select md5(coalesce(jsonb_agg(jsonb_build_array(title, activity_title, object_code, budget,
    budget_item_description) order by title, activity_title, object_code, budget, budget_item_description)::text, '[]'))
  from public.budget_reference
  where lower(institution) = lower(trim(p_institution)) and upper(round) = upper(trim(p_round));
$$;
revoke all on function public.budget_fingerprint(text, text) from public;
grant execute on function public.budget_fingerprint(text, text) to service_role;

create or replace function public.get_budget_snapshot(p_institution text, p_round text default null)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(to_jsonb(b) order by title, activity_title, object_code)
      from public.budget_reference b where lower(institution) = lower(trim(p_institution))
        and (p_round is null or upper(round) = upper(trim(p_round)))), '[]'::jsonb),
    'fingerprints', coalesce((select jsonb_object_agg(r, public.budget_fingerprint(p_institution, r))
      from (select distinct round r from public.budget_reference
        where lower(institution) = lower(trim(p_institution)) and round is not null) rounds), '{}'::jsonb),
    'empty_fingerprint', md5('[]')
  );
$$;
revoke all on function public.get_budget_snapshot(text, text) from public;
grant execute on function public.get_budget_snapshot(text, text) to anon, authenticated, service_role;

create table if not exists public.budget_changes (
  id uuid primary key default gen_random_uuid(),
  institution text not null,
  round text not null,
  admin_id uuid not null,
  reason text not null,
  before_rows jsonb not null,
  after_rows jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.budget_changes enable row level security;
drop policy if exists "Admins can read budget changes" on public.budget_changes;
create policy "Admins can read budget changes" on public.budget_changes for select to authenticated
using (exists (select 1 from public.admin_users where user_id = auth.uid() and active));

create table if not exists public.budget_drafts (
  id uuid primary key default gen_random_uuid(),
  token_hash text unique not null,
  institution text not null,
  round text not null,
  requester_name text not null,
  requester_email text not null,
  payload jsonb not null,
  version integer not null default 1,
  submitted_request text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '90 days'
);
alter table public.budget_drafts enable row level security;
revoke all on public.budget_drafts from anon, authenticated;

create or replace function public.save_budget_draft(
  p_token_hash text, p_version integer, p_institution text, p_round text,
  p_name text, p_email text, p_payload jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.budget_drafts%rowtype;
begin
  if p_token_hash !~ '^[a-f0-9]{64}$' or btrim(p_name) = '' or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or p_round !~ '^R[1-9][0-9]*$' or jsonb_typeof(p_payload->'projects') <> 'array'
    or octet_length(p_payload::text) > 1000000 then raise exception 'Invalid draft'; end if;
  if not exists (select 1 from public.institutions where name = p_institution and is_active) then
    raise exception 'Institution not found';
  end if;
  if p_version = 0 then
    insert into public.budget_drafts (token_hash, institution, round, requester_name, requester_email, payload)
    values (p_token_hash, p_institution, p_round, btrim(p_name), btrim(p_email), p_payload)
    on conflict (token_hash) do nothing returning * into d;
    if not found then
      select * into d from public.budget_drafts where token_hash = p_token_hash;
      if d.payload is distinct from p_payload or d.institution <> p_institution or d.round <> p_round
        or d.requester_name <> btrim(p_name) or d.requester_email <> btrim(p_email)
        or d.expires_at <= now() or d.submitted_request is not null then
        raise exception 'Draft already exists. Reopen the saved link before editing.';
      end if;
    end if;
  else
    update public.budget_drafts set requester_name = btrim(p_name), requester_email = btrim(p_email),
      payload = p_payload, version = version + 1, updated_at = now(), expires_at = now() + interval '90 days'
    where token_hash = p_token_hash and version = p_version and expires_at > now() and submitted_request is null
      and institution = p_institution and round = p_round
    returning * into d;
    if not found then raise exception 'Draft changed in another window, expired, or was submitted. Reopen the saved link before editing.'; end if;
  end if;
  return jsonb_build_object('version', d.version, 'updated_at', d.updated_at, 'expires_at', d.expires_at);
end;
$$;
revoke all on function public.save_budget_draft(text, integer, text, text, text, text, jsonb) from public;
grant execute on function public.save_budget_draft(text, integer, text, text, text, text, jsonb) to service_role;

create or replace function public.validate_budget_lines(p_lines jsonb)
returns void language plpgsql set search_path = public as $$
begin
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0
    or jsonb_array_length(p_lines) > 6000 then raise exception 'Provide at least one activity'; end if;
  if exists (select 1 from jsonb_array_elements(p_lines) l where
    coalesce(btrim(l->>'title'), '') = '' or coalesce(btrim(l->>'activity_title'), '') = ''
    or coalesce(l->>'object_category', '') not in ('1000s','2000s','3000s','4000s','5000s','6000s')
    or coalesce(l->>'proposed_budget', '') !~ '^[0-9]+(\.0+)?$'
    or (coalesce(l->>'object_code', '') <> '' and l->>'object_code' !~ ('^' || left(l->>'object_category', 1) || '[0-9]{3}$'))
    or ((l->>'proposed_budget')::numeric > 0 and coalesce(btrim(l->>'proposed_budget_description'), '') = '')
  ) then raise exception 'Invalid category, amount, activity, or missing funded-line description'; end if;
  if exists (select 1 from jsonb_array_elements(p_lines) l
    group by lower(btrim(l->>'title')), lower(btrim(l->>'activity_title')), l->>'object_category' having count(*) > 1
  ) then raise exception 'Duplicate activity/category'; end if;
end;
$$;
revoke all on function public.validate_budget_lines(jsonb) from public;

create or replace function public.admin_save_budget(
  p_institution text, p_round text, p_baseline_hash text, p_reason text, p_lines jsonb
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid := gen_random_uuid(); v_before jsonb; v_after jsonb;
begin
  if not exists (select 1 from public.admin_users where user_id = auth.uid() and active) then raise exception 'Not authorized'; end if;
  if coalesce(btrim(p_reason), '') = '' or p_round !~ '^R[1-9][0-9]*$'
    or not exists (select 1 from public.institutions where name = p_institution and is_active) then
    raise exception 'Institution, round, and change reason are required';
  end if;
  perform public.validate_budget_lines(p_lines);
  perform pg_advisory_xact_lock(hashtextextended(lower(p_institution) || '|' || p_round, 0));
  if p_baseline_hash is distinct from public.budget_fingerprint(p_institution, p_round) then
    raise exception 'Budget changed since you opened it. Reload before saving.';
  end if;
  select coalesce(jsonb_agg(to_jsonb(b)), '[]'::jsonb) into v_before from public.budget_reference b
    where lower(institution) = lower(p_institution) and upper(round) = p_round;
  perform set_config('app.finalizing', 'on', true);
  delete from public.budget_reference where lower(institution) = lower(p_institution) and upper(round) = p_round;
  insert into public.budget_reference (source_key, sync_batch, institution, round, title, activity_title, object_code, budget, budget_item_description)
  select 'finalized:admin:' || v_id || ':' || ord, 'finalized:admin:' || v_id, p_institution, p_round,
    l->>'title', l->>'activity_title', coalesce(nullif(l->>'object_code', ''), left(l->>'object_category', 1) || '000'),
    (l->>'proposed_budget')::numeric, coalesce(l->>'proposed_budget_description', '')
  from jsonb_array_elements(p_lines) with ordinality as line(l, ord);
  perform set_config('app.finalizing', 'off', true);
  delete from public.budget_round_resets where lower(institution) = lower(p_institution) and upper(round) = p_round;
  select coalesce(jsonb_agg(to_jsonb(b)), '[]'::jsonb) into v_after from public.budget_reference b
    where lower(institution) = lower(p_institution) and upper(round) = p_round;
  insert into public.budget_changes (id, institution, round, admin_id, reason, before_rows, after_rows)
    values (v_id, p_institution, p_round, auth.uid(), btrim(p_reason), v_before, v_after);
  return v_id;
end;
$$;
revoke all on function public.admin_save_budget(text, text, text, text, jsonb) from public;
grant execute on function public.admin_save_budget(text, text, text, text, jsonb) to authenticated;

create or replace function public.submit_budget_request(
  p_institution text, p_round text, p_name text, p_email text, p_justification text,
  p_lines jsonb, p_baseline_hash text, p_draft_hash text default null, p_draft_version integer default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.budget_submissions%rowtype; v_total numeric; v_allocation numeric; v_resubmitted boolean;
  d public.budget_drafts%rowtype;
begin
  if coalesce(btrim(p_name), '') = '' or coalesce(btrim(p_justification), '') = ''
    or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or p_round !~ '^R[1-9][0-9]*$' then
    raise exception 'Complete all requester information';
  end if;
  perform public.validate_budget_lines(p_lines);
  if exists (select 1 from jsonb_array_elements(p_lines) l group by l->>'title', l->>'activity_title'
    having sum((l->>'proposed_budget')::numeric) = 0) then raise exception 'Each submitted activity needs a funded category'; end if;
  perform pg_advisory_xact_lock(hashtextextended(lower(p_institution) || '|' || p_round, 0));
  if p_baseline_hash is distinct from public.budget_fingerprint(p_institution, p_round) then
    raise exception 'The current budget changed. Reopen the budget and review your changes before submitting.';
  end if;
  if p_draft_hash is not null then
    select * into d from public.budget_drafts where token_hash = p_draft_hash for update;
    if not found or d.expires_at <= now() or d.submitted_request is not null
      or d.version is distinct from p_draft_version or d.institution <> p_institution or d.round <> p_round then
      raise exception 'Draft changed, expired, or was already submitted. Reopen your saved link.';
    end if;
  end if;
  select allocation_amount into v_allocation from public.college_allocations where institution = p_institution and round = p_round;
  select sum((l->>'proposed_budget')::numeric) into v_total from jsonb_array_elements(p_lines) l;
  if v_allocation is null or v_allocation <= 0 or v_total <> v_allocation then raise exception 'Proposed total must equal the round allocation'; end if;
  select * into s from public.budget_submissions where lower(institution) = lower(p_institution) and upper(round) = p_round
    and status in ('Pending','Approved','Rejected') for update;
  v_resubmitted := found;
  if v_resubmitted then
    insert into public.submission_revisions (submission_id, revision_no, status, justification, admin_notes, modifications)
      select s.id, s.revision_no, s.status, s.justification, s.admin_notes,
        coalesce(jsonb_agg(to_jsonb(m)), '[]'::jsonb) from public.submission_modifications m where submission_id = s.id;
    delete from public.submission_modifications where submission_id = s.id;
    update public.budget_submissions set requester_name = btrim(p_name), requester_email = btrim(p_email),
      justification = btrim(p_justification), status = 'Pending', admin_notes = null, reviewed_at = null,
      baseline_hash = p_baseline_hash,
      baseline_rows = (public.get_budget_snapshot(p_institution, p_round)->'rows'),
      revision_no = revision_no + 1, updated_at = now() where id = s.id;
  else
    insert into public.budget_submissions (request_number, institution, round, requester_name, requester_email, justification, status, baseline_hash, baseline_rows)
    values ('REQ-' || upper(encode(gen_random_bytes(4), 'hex')), p_institution, p_round,
      btrim(p_name), btrim(p_email), btrim(p_justification), 'Pending', p_baseline_hash,
      public.get_budget_snapshot(p_institution, p_round)->'rows') returning * into s;
  end if;
  insert into public.submission_modifications (submission_id, round, title, activity_title, object_category, object_code,
    current_budget, proposed_budget, current_budget_description, proposed_budget_description, activity_status, is_new_line, current_expenditure)
  select s.id, p_round, l->>'title', l->>'activity_title', l->>'object_category', l->>'object_code',
    coalesce((l->>'current_budget')::numeric, 0), (l->>'proposed_budget')::numeric,
    coalesce(l->>'current_budget_description', ''), coalesce(l->>'proposed_budget_description', ''), 'active',
    coalesce((l->>'is_new_line')::boolean, false), 0 from jsonb_array_elements(p_lines) l;
  if p_draft_hash is not null then
    update public.budget_drafts set submitted_request = s.request_number, updated_at = now(), version = version + 1 where id = d.id;
  end if;
  return jsonb_build_object('request_number', s.request_number, 'resubmitted', v_resubmitted);
end;
$$;
revoke all on function public.submit_budget_request(text, text, text, text, text, jsonb, text, text, integer) from public;
grant execute on function public.submit_budget_request(text, text, text, text, text, jsonb, text, text, integer) to service_role;

create table if not exists public.expenditure_sync_state (
  id integer primary key check (id = 1),
  last_success_at timestamptz,
  last_attempt_at timestamptz,
  last_error text,
  row_count integer not null default 0
);
insert into public.expenditure_sync_state (id) values (1) on conflict do nothing;
create table if not exists public.expenditure_snapshot (
  institution text not null,
  round text not null,
  project text not null,
  object_category text not null,
  expenditure_amount numeric not null,
  primary key (institution, round, project, object_category)
);
alter table public.expenditure_snapshot enable row level security;
alter table public.expenditure_sync_state enable row level security;
drop policy if exists "Public can read expenditure sync state" on public.expenditure_sync_state;
create policy "Public can read expenditure sync state" on public.expenditure_sync_state for select to anon, authenticated using (true);

create or replace function public.get_expenditures(p_institution text)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when exists (select 1 from public.expenditure_sync_state where last_success_at is not null)
    then coalesce((select jsonb_agg(to_jsonb(e)) from public.expenditure_snapshot e where institution = p_institution), '[]'::jsonb)
    else coalesce((select jsonb_agg(to_jsonb(e)) from public.expenditure_reference e where institution = p_institution), '[]'::jsonb)
  end;
$$;
revoke all on function public.get_expenditures(text) from public;
grant execute on function public.get_expenditures(text) to anon, authenticated;

create or replace function public.replace_expenditure_snapshot(p_rows jsonb, p_started_at timestamptz)
returns integer language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('expenditure-sheet-sync', 0));
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'Empty imports are not allowed'; end if;
  if exists (select 1 from public.expenditure_sync_state where last_success_at > p_started_at) then
    raise exception 'A newer sync already completed; this older snapshot was not applied';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) l where
    coalesce(l->>'round', '') !~ '^R[1-9][0-9]*$' or coalesce(btrim(l->>'project'), '') = ''
    or coalesce(l->>'object_category', '') not in ('1000s','2000s','3000s','4000s','5000s','6000s')
    or coalesce(l->>'expenditure_amount', '') !~ '^-?[0-9]+(\.[0-9]{1,2})?$'
    or not exists (select 1 from public.institutions where name = l->>'institution' and is_active)
  ) then raise exception 'Invalid expenditure data or unknown institution'; end if;
  if exists (select 1 from jsonb_array_elements(p_rows) l
    group by lower(btrim(l->>'institution')), upper(l->>'round'), lower(btrim(l->>'project')), l->>'object_category' having count(*) > 1
  ) then raise exception 'Duplicate project/category expenditure totals'; end if;
  delete from public.expenditure_snapshot;
  insert into public.expenditure_snapshot (institution, round, project, object_category, expenditure_amount)
    select l->>'institution', l->>'round', btrim(l->>'project'), l->>'object_category', (l->>'expenditure_amount')::numeric
    from jsonb_array_elements(p_rows) l;
  get diagnostics v_count = row_count;
  update public.expenditure_sync_state set last_success_at = now(), last_attempt_at = p_started_at,
    last_error = null, row_count = v_count where id = 1;
  return v_count;
end;
$$;
revoke all on function public.replace_expenditure_snapshot(jsonb, timestamptz) from public;
grant execute on function public.replace_expenditure_snapshot(jsonb, timestamptz) to service_role;

create or replace function public.get_request_edit_context(p_request_number text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('baseline_hash', s.baseline_hash, 'baseline_rows', s.baseline_rows,
    'baseline_stale', case when s.baseline_hash is not null
      then s.baseline_hash <> public.budget_fingerprint(s.institution, s.round)
      else exists (select 1 from public.budget_changes c
        where lower(c.institution) = lower(s.institution) and c.round = s.round and c.created_at > s.created_at) end)
  from public.budget_submissions s where lower(s.request_number) = lower(trim(p_request_number));
$$;
revoke all on function public.get_request_edit_context(text) from public;
grant execute on function public.get_request_edit_context(text) to anon, authenticated;

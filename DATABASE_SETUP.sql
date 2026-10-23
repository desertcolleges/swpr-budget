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

  select * into s from public.budget_submissions where id = p_id for update;

  if not found then
    raise exception 'Request not found';
  end if;

  if s.status <> 'Approved' then
    raise exception 'Only approved requests can be finalized';
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
    and coalesce(sm.proposed_budget, 0) > 0;

  perform set_config('app.finalizing', 'off', true);

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

create or replace function public.guard_budget_reference_write()
returns trigger
language plpgsql
as $$
declare
  v_round text;
begin
  if tg_op = 'INSERT' then
    v_round := upper(coalesce(
      nullif(new.round, ''),
      'R' || ((regexp_match(new.title, '\mR\s*(\d+)\M', 'i'))[1])::int
    ));

    if new.round is null then
      new.round := v_round;
    end if;

    if new.sync_batch not like 'finalized:%'
       and v_round is not null
       and exists (
         select 1 from public.budget_reference b
         where b.sync_batch like 'finalized:%'
           and lower(b.institution) = lower(new.institution)
           and upper(b.round) = v_round
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

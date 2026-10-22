-- K12Plus pilot, item 2: consent records
-- 24 October 2026
--
-- Additive only: new tables consents and data_removals, a private storage
-- bucket for scanned consent forms, and updated pilot_* functions.
-- No existing data is changed or deleted.
--
-- Rule: a learner takes part in the pilot only while
--   * they are enrolled in a pilot class, and
--   * their school has given consent (one signed letter per school), and
--   * a parent or guardian has given consent for them.
-- Every report, export, message and data collection uses pilot_active()
-- or the pilot_participants view, which apply exactly this rule.

-- ============ 1. Consent records ============
create table if not exists public.consents (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('school', 'guardian')),
  school_id uuid references public.schools(id),
  learner_id uuid references public.profiles(id) on delete cascade,
  status text not null default 'given' check (status in ('given', 'withdrawn', 'replaced')),
  given_by_name text not null,
  given_by_relation text not null,
  method text not null check (method in ('paper_form', 'text_message')),
  evidence_path text,
  guardian_phone text,
  signed_on date not null,
  recorded_by uuid references public.profiles(id) on delete set null,
  recorded_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  withdrawn_by uuid references public.profiles(id) on delete set null,
  withdrawal_reason text,
  check ((kind = 'school' and school_id is not null and learner_id is null)
      or (kind = 'guardian' and learner_id is not null and school_id is null)),
  check (method <> 'paper_form' or evidence_path is not null),
  check (method <> 'text_message' or guardian_phone is not null)
);
create unique index if not exists consents_one_school_idx on public.consents (school_id) where kind = 'school' and status = 'given';
create unique index if not exists consents_one_guardian_idx on public.consents (learner_id) where kind = 'guardian' and status = 'given';
alter table public.consents enable row level security;

-- Pilot data to remove after a withdrawal
create table if not exists public.data_removals (
  id bigint generated always as identity primary key,
  learner_id uuid not null references public.profiles(id) on delete cascade,
  reason text,
  requested_at timestamptz not null default now(),
  requested_by uuid references public.profiles(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'done')),
  done_at timestamptz,
  done_by uuid references public.profiles(id) on delete set null
);
create unique index if not exists data_removals_pending_idx on public.data_removals (learner_id) where status = 'pending';
alter table public.data_removals enable row level security;

-- Private bucket for scanned consent forms (only the server and administrators can read them)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('consent-forms', 'consent-forms', false, 3145728, array['image/jpeg', 'image/png', 'application/pdf'])
on conflict (id) do nothing;

-- ============ 2. The consent rule ============
create or replace view public.pilot_participants as
  select e.learner_id, e.pseudo_id, e.class_id, c.school_id, s.region_id, s.setting, c.grade, e.enrolled_at
    from public.enrolments e
    join public.classes c on c.id = e.class_id and c.pilot
    join public.schools s on s.id = c.school_id
   where e.status = 'active'
     and exists (select 1 from public.consents k where k.kind = 'school' and k.school_id = c.school_id and k.status = 'given')
     and exists (select 1 from public.consents k where k.kind = 'guardian' and k.learner_id = e.learner_id and k.status = 'given');
revoke all on public.pilot_participants from public, anon, authenticated;
grant select on public.pilot_participants to service_role;

create or replace function public.pilot_active(p_learner uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from pilot_participants where learner_id = p_learner);
$$;
revoke execute on function public.pilot_active(uuid) from public, anon, authenticated;
grant execute on function public.pilot_active(uuid) to service_role;

-- consent state of one enrolled learner, for the screens
create or replace function public.pilot_consent_state(p_learner uuid, p_school uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'school', exists (select 1 from consents where kind = 'school' and school_id = p_school and status = 'given'),
    'guardian', (select jsonb_build_object('id', id, 'name', given_by_name, 'relation', given_by_relation,
                                           'signed_on', signed_on, 'method', method)
                   from consents where kind = 'guardian' and learner_id = p_learner and status = 'given'),
    'withdrawn', exists (select 1 from consents where kind = 'guardian' and learner_id = p_learner and status = 'withdrawn')
                 and not exists (select 1 from consents where kind = 'guardian' and learner_id = p_learner and status = 'given')
  );
$$;
revoke execute on function public.pilot_consent_state(uuid, uuid) from public, anon, authenticated;

-- ============ 3. Recording consent (called by the pilot-admin Edge Function) ============
-- p: {kind, school_id | learner_id, given_by_name, given_by_relation, method, evidence_path,
--     guardian_phone, signed_on, recorded_by}
create or replace function public.pilot_save_consent(p jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  new_id bigint;
begin
  if p->>'kind' = 'school' then
    update consents set status = 'replaced'
     where kind = 'school' and school_id = (p->>'school_id')::uuid and status = 'given';
  else
    update consents set status = 'replaced'
     where kind = 'guardian' and learner_id = (p->>'learner_id')::uuid and status = 'given';
  end if;
  insert into consents (kind, school_id, learner_id, given_by_name, given_by_relation, method,
                        evidence_path, guardian_phone, signed_on, recorded_by)
  values (p->>'kind', (p->>'school_id')::uuid, (p->>'learner_id')::uuid,
          left(trim(p->>'given_by_name'), 80), lower(trim(p->>'given_by_relation')), p->>'method',
          p->>'evidence_path', nullif(trim(coalesce(p->>'guardian_phone', '')), ''),
          (p->>'signed_on')::date, (p->>'recorded_by')::uuid)
  returning id into new_id;
  -- consent given again: any pending removal for this learner is cancelled
  if p->>'kind' = 'guardian' then
    delete from data_removals where learner_id = (p->>'learner_id')::uuid and status = 'pending';
  end if;
  return new_id;
end;
$$;
revoke execute on function public.pilot_save_consent(jsonb) from public, anon, authenticated;
grant execute on function public.pilot_save_consent(jsonb) to service_role;

-- Can the caller record or withdraw a guardian consent for this learner?
create or replace function public.pilot_can_manage_learner(p_learner uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select pilot_is_admin() or exists (
    select 1 from enrolments e join class_teachers ct on ct.class_id = e.class_id
     where e.learner_id = p_learner and e.status = 'active' and ct.teacher_id = auth.uid());
$$;
revoke execute on function public.pilot_can_manage_learner(uuid) from public, anon;
grant execute on function public.pilot_can_manage_learner(uuid) to authenticated, service_role;

-- Can the caller record or withdraw school consent? (administrator, or the regional champion)
create or replace function public.pilot_can_manage_school(p_school uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select pilot_is_admin() or exists (
    select 1 from schools s where s.id = p_school and s.in_pilot
       and s.region_id = pilot_champion_region());
$$;
revoke execute on function public.pilot_can_manage_school(uuid) from public, anon;
grant execute on function public.pilot_can_manage_school(uuid) to authenticated, service_role;

-- ============ 4. Withdrawing consent ============
create or replace function public.pilot_withdraw_guardian_consent(p_learner uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  if not pilot_can_manage_learner(p_learner) then
    raise exception 'Only the learner''s teachers or K-12 EdTech can record a withdrawal.';
  end if;
  update consents
     set status = 'withdrawn', withdrawn_at = now(), withdrawn_by = auth.uid(),
         withdrawal_reason = left(nullif(trim(coalesce(p_reason, '')), ''), 300)
   where kind = 'guardian' and learner_id = p_learner and status = 'given';
  get diagnostics n = row_count;
  if n = 0 then raise exception 'There is no consent to withdraw for this learner.'; end if;
  insert into data_removals (learner_id, reason, requested_by)
  values (p_learner, 'Parent or guardian withdrew consent', auth.uid())
  on conflict do nothing;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.pilot_withdraw_school_consent(p_school uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  if not pilot_can_manage_school(p_school) then
    raise exception 'Only K-12 EdTech or the regional champion can record a school withdrawal.';
  end if;
  update consents
     set status = 'withdrawn', withdrawn_at = now(), withdrawn_by = auth.uid(),
         withdrawal_reason = left(nullif(trim(coalesce(p_reason, '')), ''), 300)
   where kind = 'school' and school_id = p_school and status = 'given';
  get diagnostics n = row_count;
  if n = 0 then raise exception 'There is no school consent to withdraw.'; end if;
  insert into data_removals (learner_id, reason, requested_by)
  select e.learner_id, 'School withdrew consent', auth.uid()
    from enrolments e join classes c on c.id = e.class_id
   where c.school_id = p_school and e.status = 'active'
  on conflict do nothing;
  return jsonb_build_object('ok', true);
end;
$$;

-- ============ 5. Data removal after withdrawal (administrators) ============
create or replace function public.pilot_pending_removals()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not pilot_is_admin() then raise exception 'Only K-12 EdTech administrators can see data removals.'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', d.id, 'reason', d.reason, 'requested_at', d.requested_at,
      'pseudo_id', (select e.pseudo_id from enrolments e where e.learner_id = d.learner_id order by e.enrolled_at desc limit 1),
      'school', (select s.name from enrolments e join classes c on c.id = e.class_id join schools s on s.id = c.school_id
                  where e.learner_id = d.learner_id order by e.enrolled_at desc limit 1)
    ) order by d.requested_at)
      from data_removals d where d.status = 'pending'), '[]'::jsonb);
end;
$$;

-- Removes the learner's pilot data. Each later pilot item that stores learner
-- data adds its table here. The consent record itself is kept as evidence.
create or replace function public.pilot_remove_data(p_removal bigint)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  lid uuid;
begin
  if not pilot_is_admin() then raise exception 'Only K-12 EdTech administrators can remove pilot data.'; end if;
  select learner_id into lid from data_removals where id = p_removal and status = 'pending';
  if lid is null then raise exception 'This removal was already done or does not exist.'; end if;
  if pilot_active(lid) then raise exception 'This learner has consent again, so their data cannot be removed.'; end if;
  -- (pilot data tables are added here by later items)
  update data_removals set status = 'done', done_at = now(), done_by = auth.uid() where id = p_removal;
  return jsonb_build_object('ok', true);
end;
$$;

-- ============ 6. Screens: include consent state ============
create or replace function public.pilot_my_classes()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Please log in first.'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', c.id, 'name', c.name, 'grade', c.grade, 'code', c.class_code,
      'school', s.name, 'region', r.name, 'setting', s.setting,
      'school_consent', exists (select 1 from consents k where k.kind = 'school' and k.school_id = s.id and k.status = 'given'),
      'learners', coalesce((
        select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.username, 'k12id', p.learner_uid,
                                            'joined', e.enrolled_at,
                                            'consent', pilot_consent_state(p.id, s.id),
                                            'taking_part', pilot_active(p.id))
                         order by p.username)
          from enrolments e join profiles p on p.id = e.learner_id
         where e.class_id = c.id and e.status = 'active'), '[]'::jsonb)
    ) order by c.grade)
      from class_teachers ct
      join classes c on c.id = ct.class_id
      join schools s on s.id = c.school_id
      left join regions r on r.id = s.region_id
     where ct.teacher_id = auth.uid()), '[]'::jsonb);
end;
$$;

create or replace function public.pilot_region_detail(p_region smallint)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not (pilot_is_admin() or coalesce(pilot_champion_region() = p_region, false)) then
    raise exception 'You can only see your own region.';
  end if;
  return (
    select jsonb_build_object(
      'region_id', r.id, 'region', r.name,
      'champion', (select jsonb_build_object('id', p.id, 'name', p.username) from profiles p where p.champion_region_id = r.id limit 1),
      'schools', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', s.id, 'name', s.name, 'town', s.region, 'setting', s.setting,
          'consent', (select jsonb_build_object('id', k.id, 'name', k.given_by_name, 'signed_on', k.signed_on)
                        from consents k where k.kind = 'school' and k.school_id = s.id and k.status = 'given'),
          'classes', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', c.id, 'name', c.name, 'grade', c.grade, 'code', c.class_code,
              'teachers', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.username) order by p.username)
                                      from class_teachers ct join profiles p on p.id = ct.teacher_id where ct.class_id = c.id), '[]'::jsonb),
              'learners', (select count(*) from enrolments e where e.class_id = c.id and e.status = 'active'),
              'taking_part', (select count(*) from pilot_participants pp where pp.class_id = c.id)
            ) order by c.grade) from classes c where c.school_id = s.id and c.pilot), '[]'::jsonb)
        ) order by s.setting, s.name) from schools s where s.region_id = r.id and s.in_pilot), '[]'::jsonb)
    ) from regions r where r.id = p_region
  );
end;
$$;

create or replace function public.pilot_overview()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not pilot_is_admin() then raise exception 'Only K-12 EdTech administrators can see the whole pilot.'; end if;
  return (
    select jsonb_agg(jsonb_build_object(
      'region_id', r.id, 'region', r.name,
      'champion', (select p.username from profiles p where p.champion_region_id = r.id limit 1),
      'schools', (select count(*) from schools s where s.region_id = r.id and s.in_pilot),
      'rural', (select count(*) from schools s where s.region_id = r.id and s.in_pilot and s.setting = 'rural'),
      'urban', (select count(*) from schools s where s.region_id = r.id and s.in_pilot and s.setting = 'urban'),
      'school_consents', (select count(*) from schools s where s.region_id = r.id and s.in_pilot
                           and exists (select 1 from consents k where k.kind = 'school' and k.school_id = s.id and k.status = 'given')),
      'classes', (select count(*) from classes c join schools s on s.id = c.school_id where s.region_id = r.id and c.pilot),
      'teachers', (select count(distinct ct.teacher_id) from class_teachers ct join classes c on c.id = ct.class_id
                    join schools s on s.id = c.school_id where s.region_id = r.id),
      'learners', (select count(*) from pilot_participants pp where pp.region_id = r.id),
      'awaiting', (select count(*) from enrolments e join classes c on c.id = e.class_id join schools s on s.id = c.school_id
                    where s.region_id = r.id and e.status = 'active') - (select count(*) from pilot_participants pp where pp.region_id = r.id)
    ) order by r.name) from regions r
  );
end;
$$;

-- Only learners who are taking part (enrolled and both consents given)
create or replace function public.pilot_learner_records()
returns table (learner_id uuid, pseudo_id text, region text, school text, setting text, class_name text, grade int, joined_via text, enrolled_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not pilot_is_admin() then raise exception 'Only K-12 EdTech administrators can list pilot learners.'; end if;
  return query
    select pp.learner_id, pp.pseudo_id, r.name, s.name, s.setting, c.name, c.grade, e.joined_via, e.enrolled_at
      from pilot_participants pp
      join enrolments e on e.learner_id = pp.learner_id and e.class_id = pp.class_id and e.status = 'active'
      join classes c on c.id = pp.class_id
      join schools s on s.id = c.school_id
      left join regions r on r.id = s.region_id
     order by r.name, s.name, c.grade;
end;
$$;

create or replace function public.pilot_whoami()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me record;
begin
  select * into me from profiles where id = auth.uid();
  if not found then return jsonb_build_object('signed_in', false); end if;
  return jsonb_build_object(
    'signed_in', true,
    'admin', me.role = 'admin',
    'champion_region_id', me.champion_region_id,
    'champion_region', (select name from regions where id = me.champion_region_id),
    'teaches', (select count(*) from class_teachers where teacher_id = me.id),
    'class', (select jsonb_build_object('name', c.name, 'school', s.name, 'region', r.name, 'setting', s.setting,
                                        'taking_part', pilot_active(me.id),
                                        'consent', pilot_consent_state(me.id, s.id))
                from enrolments e join classes c on c.id = e.class_id join schools s on s.id = c.school_id
                left join regions r on r.id = s.region_id
               where e.learner_id = me.id and e.status = 'active')
  );
end;
$$;

-- ============ 7. Who may call what ============
do $$
declare f text;
begin
  foreach f in array array[
    'pilot_withdraw_guardian_consent(uuid, text)', 'pilot_withdraw_school_consent(uuid, text)',
    'pilot_pending_removals()', 'pilot_remove_data(bigint)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

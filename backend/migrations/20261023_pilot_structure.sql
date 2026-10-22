-- K12Plus pilot, item 1: pilot structure (regions, schools, classes, roles)
-- 23 October 2026
--
-- Additive only:
--   * new tables: regions, classes, class_teachers, enrolments
--   * new columns that start empty: schools.region_id, schools.setting,
--     schools.in_pilot (false), profiles.champion_region_id
--   * one new role value: 'admin' (K-12 EdTech staff)
--   * schools.region_id is filled in from the existing region text,
--     for example 'Omusati (Tsandi)' -> Omusati. The region text is not changed.
-- No existing value is changed or deleted.
--
-- Access: the new tables have row level security switched on and no policies,
-- so nobody can read or write them directly. Everything goes through the
-- pilot_* functions below, which check who is asking.

-- ============ 1. Regions ============
create table if not exists public.regions (
  id smallint primary key,
  name text not null unique,
  country text not null default 'NA'
);
insert into public.regions (id, name) values
  (1, 'Erongo'), (2, 'Hardap'), (3, 'ǁKaras'), (4, 'Kavango East'), (5, 'Kavango West'),
  (6, 'Khomas'), (7, 'Kunene'), (8, 'Ohangwena'), (9, 'Omaheke'), (10, 'Omusati'),
  (11, 'Oshana'), (12, 'Oshikoto'), (13, 'Otjozondjupa'), (14, 'Zambezi')
on conflict (id) do nothing;
alter table public.regions enable row level security;
drop policy if exists regions_read on public.regions;
create policy regions_read on public.regions for select to anon, authenticated using (true);

-- ============ 2. Schools: pilot fields ============
alter table public.schools add column if not exists region_id smallint references public.regions(id);
alter table public.schools add column if not exists setting text check (setting in ('rural', 'urban'));
alter table public.schools add column if not exists in_pilot boolean not null default false;
create index if not exists schools_region_id_idx on public.schools (region_id);

-- Fill the new region_id from the existing text ('Omusati (Tsandi)' -> Omusati)
update public.schools s
   set region_id = r.id
  from public.regions r
 where s.region_id is null
   and trim(split_part(s.region, '(', 1)) = r.name;

-- ============ 3. Roles ============
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in
  ('learner', 'educator', 'parent', 'school_admin', 'principal', 'hod', 'ministry', 'admin'));
-- A regional champion is a teacher who also supports the pilot schools in one region.
alter table public.profiles add column if not exists champion_region_id smallint references public.regions(id);

-- Users must not be able to make themselves a champion: protect the new column.
create or replace function public.guard_profile_privileges()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') not in ('authenticated', 'anon') then
    return new;
  end if;
  -- the pilot_* functions below check the caller's role themselves, then switch
  -- this on for the rest of their own transaction only; it cannot be set through the API
  if current_setting('k12.trusted_write', true) = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.role not in ('learner', 'educator', 'parent') then
      raise exception 'ROLE_NOT_ALLOWED: % accounts are created by K12Plus staff', new.role;
    end if;
    new.plan := 'free';
    new.plan_expires_at := null;
    new.verified_educator := false;
    new.champion_region_id := null;
    return new;
  end if;
  if new.role is distinct from old.role
     or new.plan is distinct from old.plan
     or new.plan_expires_at is distinct from old.plan_expires_at
     or new.school_id is distinct from old.school_id
     or new.learner_uid is distinct from old.learner_uid
     or new.verified_educator is distinct from old.verified_educator
     or new.champion_region_id is distinct from old.champion_region_id then
    raise exception 'PROTECTED_FIELD: role, plan, school, learner ID, verification and champion region can only be changed by K12Plus staff';
  end if;
  return new;
end;
$$;

-- ============ 4. Classes, teachers and enrolments ============
create table if not exists public.classes (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id),
  grade int not null check (grade between 8 and 12),
  subject text not null default 'Mathematics',
  name text not null,
  class_code text not null unique,
  pilot boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (school_id, name)
);

create table if not exists public.class_teachers (
  class_id uuid not null references public.classes(id) on delete cascade,
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  added_by uuid references public.profiles(id) on delete set null,
  added_at timestamptz not null default now(),
  primary key (class_id, teacher_id)
);
create index if not exists class_teachers_teacher_idx on public.class_teachers (teacher_id);

create table if not exists public.enrolments (
  id bigint generated always as identity primary key,
  class_id uuid not null references public.classes(id) on delete cascade,
  learner_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'withdrawn')),
  -- random ID for the independent evaluator; never shows a name or phone number
  pseudo_id text not null unique default ('P' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))),
  joined_via text not null check (joined_via in ('class_code', 'teacher', 'ussd', 'admin')),
  enrolled_by uuid references public.profiles(id) on delete set null,
  enrolled_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  unique (class_id, learner_id)
);
-- a learner can be active in only one pilot class at a time
create unique index if not exists enrolments_one_active_idx on public.enrolments (learner_id) where status = 'active';

alter table public.classes enable row level security;
alter table public.class_teachers enable row level security;
alter table public.enrolments enable row level security;

-- ============ 5. Helpers ============
create or replace function public.pilot_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin');
$$;

create or replace function public.pilot_champion_region() returns smallint
language sql stable security definer set search_path = public as $$
  select champion_region_id from profiles where id = auth.uid();
$$;

create or replace function public.pilot_teaches(p_class uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from class_teachers where class_id = p_class and teacher_id = auth.uid());
$$;

-- Class codes: 6 characters with no look-alikes (no 0/O, 1/I/L), random from gen_random_uuid()
create or replace function public.pilot_new_class_code() returns text
language plpgsql volatile security definer set search_path = public as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  code text;
  bytes bytea;
begin
  loop
    bytes := uuid_send(gen_random_uuid());
    code := '';
    for i in 0..5 loop
      code := code || substr(alphabet, 1 + (get_byte(bytes, i) % length(alphabet)), 1);
    end loop;
    exit when not exists (select 1 from classes where class_code = code);
  end loop;
  return code;
end;
$$;

-- Find one account from an email address, k12plus ID or mobile number.
create or replace function public.pilot_find_profile(p_identifier text) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  ident text := trim(coalesce(p_identifier, ''));
  digits text := regexp_replace(ident, '\D', '', 'g');
  cands text[];
  ids uuid[];
begin
  if ident = '' then return null; end if;
  if position('@' in ident) > 0 then
    select array_agg(p.id) into ids from profiles p join auth.users u on u.id = p.id
     where lower(u.email) = lower(ident);
  elsif upper(ident) like 'K12-%' then
    select array_agg(id) into ids from profiles where learner_uid = upper(ident);
  elsif length(digits) >= 7 then
    if digits like '00%' then cands := array[substr(digits, 3)];
    elsif digits like '0%' then cands := array['264' || substr(digits, 2), '27' || substr(digits, 2)];
    else cands := array[digits];
    end if;
    select array_agg(id) into ids from profiles where phone_e164 = any (cands);
  end if;
  if ids is null or array_length(ids, 1) = 0 then return null; end if;
  if array_length(ids, 1) > 1 then
    raise exception 'More than one account uses %. Use the k12plus ID instead.', ident;
  end if;
  return ids[1];
end;
$$;

-- ============ 6. Administrator: set up a region ============
-- p_schools: [{"school_id": "...", "setting": "rural"}, {"school_id": "...", "setting": "urban"}]
-- Marks the schools as pilot schools and creates a Grade 11 and a Grade 12
-- mathematics class in each, with class codes. Safe to run again.
create or replace function public.pilot_setup_region(p_region smallint, p_schools jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  item jsonb;
  sid uuid;
  stg text;
  g int;
  sch record;
begin
  if not pilot_is_admin() then raise exception 'Only K-12 EdTech administrators can set up pilot regions.'; end if;
  if not exists (select 1 from regions where id = p_region) then raise exception 'Unknown region.'; end if;
  if jsonb_typeof(p_schools) <> 'array' or jsonb_array_length(p_schools) = 0 then
    raise exception 'Choose at least one school.';
  end if;
  for item in select * from jsonb_array_elements(p_schools) loop
    sid := (item->>'school_id')::uuid;
    stg := lower(item->>'setting');
    if stg not in ('rural', 'urban') then raise exception 'Mark each school as rural or urban.'; end if;
    select * into sch from schools where id = sid;
    if not found then raise exception 'School not found.'; end if;
    if sch.region_id is not null and sch.region_id <> p_region then
      raise exception '% is in another region.', sch.name;
    end if;
    update schools set region_id = p_region, setting = stg, in_pilot = true where id = sid;
    foreach g in array array[11, 12] loop
      insert into classes (school_id, grade, subject, name, class_code, created_by)
      values (sid, g, 'Mathematics', 'Grade ' || g || ' Mathematics', pilot_new_class_code(), auth.uid())
      on conflict (school_id, name) do nothing;
    end loop;
  end loop;
  return pilot_region_detail(p_region);
end;
$$;

-- ============ 7. Administrator: teachers and champions ============
create or replace function public.pilot_assign_teacher(p_class uuid, p_identifier text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  cls record;
  tid uuid;
  t record;
begin
  select c.*, s.region_id into cls from classes c join schools s on s.id = c.school_id where c.id = p_class;
  if not found then raise exception 'Class not found.'; end if;
  if not (pilot_is_admin() or coalesce(pilot_champion_region() = cls.region_id, false)) then
    raise exception 'Only administrators or the regional champion can assign teachers.';
  end if;
  tid := pilot_find_profile(p_identifier);
  if tid is null then raise exception 'No account found for %. The teacher must sign up at k12plus.app first.', p_identifier; end if;
  select * into t from profiles where id = tid;
  if t.role not in ('educator', 'hod', 'principal', 'school_admin') then
    raise exception '% is not registered as a teacher.', t.username;
  end if;
  if t.school_id is not null and t.school_id <> cls.school_id then
    raise exception '% is registered at another school.', t.username;
  end if;
  if (select count(*) from class_teachers where class_id = p_class and teacher_id <> tid) >= 2 then
    raise exception 'This class already has two teachers.';
  end if;
  perform set_config('k12.trusted_write', 'on', true);
  if t.school_id is null then update profiles set school_id = cls.school_id where id = tid; end if;
  insert into class_teachers (class_id, teacher_id, added_by) values (p_class, tid, auth.uid())
  on conflict do nothing;
  return jsonb_build_object('ok', true, 'teacher', t.username);
end;
$$;

create or replace function public.pilot_remove_teacher(p_class uuid, p_teacher uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  reg smallint;
begin
  select s.region_id into reg from classes c join schools s on s.id = c.school_id where c.id = p_class;
  if not (pilot_is_admin() or coalesce(pilot_champion_region() = reg, false)) then
    raise exception 'Only administrators or the regional champion can remove teachers.';
  end if;
  delete from class_teachers where class_id = p_class and teacher_id = p_teacher;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.pilot_set_champion(p_region smallint, p_identifier text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  tid uuid;
  t record;
begin
  if not pilot_is_admin() then raise exception 'Only K-12 EdTech administrators can appoint champions.'; end if;
  if not exists (select 1 from regions where id = p_region) then raise exception 'Unknown region.'; end if;
  perform set_config('k12.trusted_write', 'on', true);
  update profiles set champion_region_id = null where champion_region_id = p_region;
  if coalesce(trim(p_identifier), '') = '' then return jsonb_build_object('ok', true, 'champion', null); end if;
  tid := pilot_find_profile(p_identifier);
  if tid is null then raise exception 'No account found for %. The champion must sign up at k12plus.app first.', p_identifier; end if;
  select * into t from profiles where id = tid;
  if t.role not in ('educator', 'hod', 'principal', 'school_admin') then
    raise exception '% is not registered as a teacher.', t.username;
  end if;
  update profiles set champion_region_id = p_region where id = tid;
  return jsonb_build_object('ok', true, 'champion', t.username);
end;
$$;

-- ============ 8. Enrolment ============
-- Internal: enrol one learner in one class (checks done by the callers).
create or replace function public.pilot_enrol(p_class uuid, p_learner uuid, p_via text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  cls record;
  lrn record;
  other text;
begin
  select c.*, s.name as school_name into cls from classes c join schools s on s.id = c.school_id where c.id = p_class;
  if not found then raise exception 'Class not found.'; end if;
  select * into lrn from profiles where id = p_learner;
  if not found or lrn.role <> 'learner' then raise exception 'Only learner accounts can join a class.'; end if;
  if lrn.grade is not null and lrn.grade <> cls.grade then
    raise exception 'This class is for Grade % learners, and this account is in Grade %.', cls.grade, lrn.grade;
  end if;
  select c.name || ' at ' || s.name into other
    from enrolments e join classes c on c.id = e.class_id join schools s on s.id = c.school_id
   where e.learner_id = p_learner and e.status = 'active' and e.class_id <> p_class;
  if other is not null then
    raise exception 'This learner is already in %. Ask the teacher to remove them from that class first.', other;
  end if;
  perform set_config('k12.trusted_write', 'on', true);
  update profiles
     set school_id = cls.school_id,
         grade = coalesce(grade, cls.grade)
   where id = p_learner and (school_id is distinct from cls.school_id or grade is null);
  insert into enrolments (class_id, learner_id, joined_via, enrolled_by)
  values (p_class, p_learner, p_via, auth.uid())
  on conflict (class_id, learner_id) do update
     set status = 'active', withdrawn_at = null, joined_via = excluded.joined_via, enrolled_by = excluded.enrolled_by
   where enrolments.status <> 'active';
  return jsonb_build_object('ok', true, 'class', cls.name, 'school', cls.school_name);
end;
$$;

-- Learner joins with a class code
create or replace function public.pilot_join_class(p_code text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  cid uuid;
begin
  if auth.uid() is null then raise exception 'Please log in first.'; end if;
  select id into cid from classes where class_code = upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')) and pilot;
  if cid is null then raise exception 'That class code was not found. Check it with your teacher.'; end if;
  return pilot_enrol(cid, auth.uid(), 'class_code');
end;
$$;

-- Teacher adds an existing learner account (k12plus ID or mobile number)
create or replace function public.pilot_add_learner(p_class uuid, p_identifier text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  lid uuid;
begin
  if not (pilot_is_admin() or pilot_teaches(p_class)) then raise exception 'Only this class''s teachers can add learners.'; end if;
  lid := pilot_find_profile(p_identifier);
  if lid is null then raise exception 'No learner account found for %.', p_identifier; end if;
  return pilot_enrol(p_class, lid, case when pilot_is_admin() then 'admin' else 'teacher' end);
end;
$$;

-- Teacher or administrator removes a learner from a class
create or replace function public.pilot_remove_learner(p_class uuid, p_learner uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not (pilot_is_admin() or pilot_teaches(p_class)) then raise exception 'Only this class''s teachers can remove learners.'; end if;
  update enrolments set status = 'withdrawn', withdrawn_at = now()
   where class_id = p_class and learner_id = p_learner and status = 'active';
  return jsonb_build_object('ok', true);
end;
$$;

-- ============ 9. Read functions for the screens ============
-- One region: schools, classes, teachers, learner counts (no learner names)
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
          'classes', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', c.id, 'name', c.name, 'grade', c.grade, 'code', c.class_code,
              'teachers', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.username) order by p.username)
                                      from class_teachers ct join profiles p on p.id = ct.teacher_id where ct.class_id = c.id), '[]'::jsonb),
              'learners', (select count(*) from enrolments e where e.class_id = c.id and e.status = 'active')
            ) order by c.grade) from classes c where c.school_id = s.id and c.pilot), '[]'::jsonb)
        ) order by s.setting, s.name) from schools s where s.region_id = r.id and s.in_pilot), '[]'::jsonb)
    ) from regions r where r.id = p_region
  );
end;
$$;

-- Administrator: all 14 regions at a glance
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
      'classes', (select count(*) from classes c join schools s on s.id = c.school_id where s.region_id = r.id and c.pilot),
      'teachers', (select count(distinct ct.teacher_id) from class_teachers ct join classes c on c.id = ct.class_id
                    join schools s on s.id = c.school_id where s.region_id = r.id),
      'learners', (select count(*) from enrolments e join classes c on c.id = e.class_id
                    join schools s on s.id = c.school_id where s.region_id = r.id and e.status = 'active')
    ) order by r.name) from regions r
  );
end;
$$;

-- Administrator: schools in a region to choose from when setting it up
create or replace function public.pilot_region_schools(p_region smallint)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not pilot_is_admin() then raise exception 'Only K-12 EdTech administrators can set up pilot regions.'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'town', s.region,
                                        'setting', s.setting, 'in_pilot', s.in_pilot) order by s.name)
      from schools s where s.region_id = p_region), '[]'::jsonb);
end;
$$;

-- Teacher: my pilot classes with their learners
create or replace function public.pilot_my_classes()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Please log in first.'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', c.id, 'name', c.name, 'grade', c.grade, 'code', c.class_code,
      'school', s.name, 'region', r.name, 'setting', s.setting,
      'learners', coalesce((
        select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.username, 'k12id', p.learner_uid,
                                            'basic_phone', e.joined_via = 'ussd', 'joined', e.enrolled_at)
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

-- Anyone signed in: what pilot role do I have?
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
    'class', (select jsonb_build_object('name', c.name, 'school', s.name, 'region', r.name, 'setting', s.setting)
                from enrolments e join classes c on c.id = e.class_id join schools s on s.id = c.school_id
                left join regions r on r.id = s.region_id
               where e.learner_id = me.id and e.status = 'active')
  );
end;
$$;

-- Administrator: every pilot learner with region, school, setting and class
-- (the acceptance check for item 1)
create or replace function public.pilot_learner_records()
returns table (learner_id uuid, pseudo_id text, region text, school text, setting text, class_name text, grade int, joined_via text, enrolled_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not pilot_is_admin() then raise exception 'Only K-12 EdTech administrators can list pilot learners.'; end if;
  return query
    select e.learner_id, e.pseudo_id, r.name, s.name, s.setting, c.name, c.grade, e.joined_via, e.enrolled_at
      from enrolments e
      join classes c on c.id = e.class_id
      join schools s on s.id = c.school_id
      left join regions r on r.id = s.region_id
     where e.status = 'active'
     order by r.name, s.name, c.grade;
end;
$$;

-- ============ 10. Who may call what ============
-- Internal helpers are not callable through the API.
revoke execute on function public.pilot_new_class_code() from public, anon, authenticated;
revoke execute on function public.pilot_find_profile(text) from public, anon, authenticated;
revoke execute on function public.pilot_enrol(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.pilot_is_admin() from public, anon;
revoke execute on function public.pilot_champion_region() from public, anon;
revoke execute on function public.pilot_teaches(uuid) from public, anon;
-- The screens call these; each one checks the caller's role itself.
do $$
declare f text;
begin
  foreach f in array array[
    'pilot_setup_region(smallint, jsonb)', 'pilot_assign_teacher(uuid, text)', 'pilot_remove_teacher(uuid, uuid)',
    'pilot_set_champion(smallint, text)', 'pilot_join_class(text)', 'pilot_add_learner(uuid, text)',
    'pilot_remove_learner(uuid, uuid)', 'pilot_region_detail(smallint)', 'pilot_overview()',
    'pilot_region_schools(smallint)', 'pilot_my_classes()', 'pilot_whoami()', 'pilot_learner_records()']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
grant execute on function public.pilot_enrol(uuid, uuid, text) to service_role;
grant execute on function public.pilot_find_profile(text) to service_role;

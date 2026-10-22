-- Local stand-in for the live K12Plus Supabase database (22 October 2026).
-- Only for tests: mirrors the live tables, constraints, functions and policies
-- that the pilot migrations depend on.

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, phone text, created_at timestamptz default now());
create function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::json->>'sub', '')::uuid $$;
create function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::json->>'role', current_user::text) $$;
grant execute on all functions in schema auth to anon, authenticated, service_role;

create table public.schools (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  region text not null,
  plan text not null default 'free' check (plan in ('free','school')),
  plan_expires_at timestamptz,
  created_at timestamptz default now(),
  country text
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  role text not null default 'learner',
  grade int,
  region text,
  school_id uuid references public.schools(id),
  plan text not null default 'free' check (plan in ('free','individual')),
  plan_expires_at timestamptz,
  phone text,
  created_at timestamptz default now(),
  country text,
  class_letter text check (class_letter is null or (class_letter >= 'A' and class_letter <= 'L')),
  learner_uid text unique,
  linked_children text[],
  phone_e164 text generated always as (
    case
      when phone is null or regexp_replace(phone, '\D', '', 'g') = '' then null
      when regexp_replace(phone, '\D', '', 'g') like '00%' then substr(regexp_replace(phone, '\D', '', 'g'), 3)
      when regexp_replace(phone, '\D', '', 'g') like '0%' then
        (case when country = 'South Africa' then '27' else '264' end) || substr(regexp_replace(phone, '\D', '', 'g'), 2)
      else regexp_replace(phone, '\D', '', 'g')
    end) stored,
  verified_educator boolean not null default false,
  constraint profiles_role_check check (role in ('learner','educator','parent','school_admin','principal','hod','ministry')),
  constraint profiles_grade_check check (grade is null or grade between 8 and 12)
);

create table public.quiz_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  subject text, score int, total int, created_at timestamptz default now()
);

create or replace function public.current_role_of() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select role from profiles where id = auth.uid()), 'anon');
$$;
create or replace function public.current_school_of() returns uuid
language sql stable security definer set search_path = public as $$
  select school_id from profiles where id = auth.uid();
$$;

create or replace function public.guard_profile_privileges()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.role not in ('learner', 'educator', 'parent') then
      raise exception 'ROLE_NOT_ALLOWED: % accounts are created by K12Plus staff', new.role;
    end if;
    new.plan := 'free';
    new.plan_expires_at := null;
    new.verified_educator := false;
    return new;
  end if;
  if new.role is distinct from old.role
     or new.plan is distinct from old.plan
     or new.plan_expires_at is distinct from old.plan_expires_at
     or new.school_id is distinct from old.school_id
     or new.learner_uid is distinct from old.learner_uid
     or new.verified_educator is distinct from old.verified_educator then
    raise exception 'PROTECTED_FIELD: role, plan, school, learner ID and verification can only be changed by K12Plus staff';
  end if;
  return new;
end;
$$;
create trigger trg_guard_profile_privileges before insert or update on public.profiles
  for each row execute function public.guard_profile_privileges();

alter table public.schools enable row level security;
alter table public.profiles enable row level security;
alter table public.quiz_attempts enable row level security;
create policy schools_anon_read on public.schools for select to anon using (true);
create policy schools_read on public.schools for select to authenticated using (true);
create policy schools_ministry_write on public.schools for all to authenticated
  using (current_role_of() = 'ministry') with check (current_role_of() = 'ministry');
create policy profiles_own on public.profiles for select to authenticated using (id = auth.uid());
create policy profiles_insert_own on public.profiles for insert to authenticated with check (id = auth.uid());
create policy profiles_update_own on public.profiles for update to authenticated using (id = auth.uid());
create policy profiles_school_read on public.profiles for select to authenticated
  using (current_role_of() in ('educator','school_admin') and school_id = current_school_of());
create policy profiles_ministry_read on public.profiles for select to authenticated using (current_role_of() = 'ministry');
create policy qa_own on public.quiz_attempts for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

grant all on all tables in schema public to anon, authenticated, service_role;

-- Supabase Storage (only the buckets table is needed by the migrations)
create schema if not exists storage;
create table if not exists storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);

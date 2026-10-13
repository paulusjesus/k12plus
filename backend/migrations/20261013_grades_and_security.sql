-- K12Plus: 13 October 2026
-- 1. Allow Grades 8 to 12 (Namibia now covers Grade 8-12)
-- 2. Stop self-promotion: users cannot give themselves a privileged role or a paid plan
-- 3. Payments created by users always start as pending
-- 4. Lock down SECURITY DEFINER functions and views flagged by the Supabase advisor

-- 1. Grades
alter table public.profiles drop constraint if exists profiles_grade_check;
alter table public.profiles add constraint profiles_grade_check
  check (grade is null or grade between 8 and 12);

-- 2. Protect role, plan and school on profiles.
-- Self sign-up may only create learner, educator or parent accounts on the free plan.
-- Afterwards only the service role (backend, dashboard) may change role, plan, plan expiry or school.
create or replace function public.guard_profile_privileges()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- service role, postgres and dashboard SQL bypass the guard
  if coalesce(auth.role(), '') not in ('authenticated', 'anon') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.role not in ('learner', 'educator', 'parent') then
      raise exception 'ROLE_NOT_ALLOWED: % accounts are created by K12Plus staff', new.role;
    end if;
    new.plan := 'free';
    new.plan_expires_at := null;
    return new;
  end if;

  -- UPDATE
  if new.role is distinct from old.role
     or new.plan is distinct from old.plan
     or new.plan_expires_at is distinct from old.plan_expires_at
     or new.school_id is distinct from old.school_id
     or new.learner_uid is distinct from old.learner_uid then
    raise exception 'PROTECTED_FIELD: role, plan, school and learner ID can only be changed by K12Plus staff';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_profile_privileges on public.profiles;
create trigger trg_guard_profile_privileges
  before insert or update on public.profiles
  for each row execute function public.guard_profile_privileges();

-- 3. Payments: users may only record pending payments for themselves
drop policy if exists pay_insert on public.payments;
create policy pay_insert on public.payments
  for insert to authenticated
  with check (payer_profile_id = auth.uid() and status = 'pending'
              and confirmed_by is null and confirmed_at is null);

-- 4a. Functions: nobody calls these through the API; triggers and RLS still work
revoke execute on function public.append_trust_record(text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.trg_quiz_trust() from public, anon, authenticated;
revoke execute on function public.enforce_lesson_plan_limit() from public, anon, authenticated;
revoke execute on function public.guard_profile_privileges() from public, anon, authenticated;
-- used inside RLS policies for signed-in users, so keep for authenticated only
revoke execute on function public.current_role_of() from public, anon;
revoke execute on function public.current_school_of() from public, anon;
grant execute on function public.current_role_of() to authenticated;
grant execute on function public.current_school_of() to authenticated;

alter function public.generate_learner_uid(text) set search_path = public;

-- 4b. Views respect the caller's row level security
alter view public.school_stats set (security_invoker = true);
alter view public.topic_heatmap set (security_invoker = true);
revoke select on public.school_stats, public.topic_heatmap from anon;

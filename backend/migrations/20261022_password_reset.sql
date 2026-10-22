-- K12Plus: 22 October 2026
-- Password reset for learners without email (Edge Function learner-reset).

-- One-time reset codes. Only a SHA-256 hash of each code is stored.
-- Row level security is on with no policies: only the service role
-- (the Edge Function) can read or write this table.
create table if not exists public.reset_codes (
  id bigint generated always as identity primary key,
  learner_id uuid not null references public.profiles(id) on delete cascade,
  issued_by uuid not null references public.profiles(id) on delete cascade,
  code_hash text not null,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
alter table public.reset_codes enable row level security;
create index if not exists reset_codes_learner_idx on public.reset_codes (learner_id, created_at desc);
create index if not exists reset_codes_issuer_idx on public.reset_codes (issued_by, created_at desc);

-- Teachers sign themselves up, so only educators verified by K12Plus staff may
-- issue reset codes for learners at their school. Set it in the Supabase table
-- editor (profiles.verified_educator = true).
alter table public.profiles add column if not exists verified_educator boolean not null default false;

-- Users must not be able to verify themselves: protect the new column too.
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

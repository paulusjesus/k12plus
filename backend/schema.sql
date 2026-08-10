-- AIM (AI Math Tutor) - Supabase schema
-- Paste this entire file into Supabase Dashboard -> SQL Editor -> Run
-- Version 1.0 - August 2026

-- ============ SCHOOLS ============
create table if not exists schools (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  region text not null,
  plan text not null default 'free' check (plan in ('free','school')),
  plan_expires_at timestamptz,
  created_at timestamptz default now()
);

-- ============ PROFILES (extends auth.users) ============
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  role text not null default 'learner' check (role in ('learner','educator','school_admin','ministry')),
  grade int check (grade in (10,11,12)),
  region text,
  school_id uuid references schools(id),
  plan text not null default 'free' check (plan in ('free','individual')),
  plan_expires_at timestamptz,
  phone text,
  created_at timestamptz default now()
);

-- ============ LEARNING ACTIVITY ============
create table if not exists activities (
  id bigint generated always as identity primary key,
  user_id uuid not null references profiles(id) on delete cascade,
  kind text not null check (kind in ('chat','practice','game','ussd','lesson_view')),
  syllabus text,           -- '6131' | '8227'
  topic text,
  duration_seconds int default 0,
  correct int default 0,
  attempted int default 0,
  offline boolean default false,  -- true if recorded offline and synced later
  created_at timestamptz default now()
);

create table if not exists progress (
  user_id uuid not null references profiles(id) on delete cascade,
  syllabus text not null,
  topic text not null,
  mastery numeric not null default 0 check (mastery >= 0 and mastery <= 100),
  attempts int not null default 0,
  correct int not null default 0,
  baseline_mastery numeric,       -- first measured mastery, for improvement tracking
  updated_at timestamptz default now(),
  primary key (user_id, syllabus, topic)
);

create table if not exists chat_messages (
  id bigint generated always as identity primary key,
  user_id uuid not null references profiles(id) on delete cascade,
  session_id text not null,
  role text not null check (role in ('user','assistant')),
  content text not null,
  topic text,
  queued_offline boolean default false,
  created_at timestamptz default now()
);

-- ============ EDUCATOR TOOLS ============
create table if not exists lesson_plans (
  id bigint generated always as identity primary key,
  educator_id uuid not null references profiles(id) on delete cascade,
  kind text not null default 'lesson_plan' check (kind in ('lesson_plan','scheme_of_work')),
  grade int not null,
  syllabus text not null,
  topic text not null,
  title text not null,
  content jsonb not null,
  created_at timestamptz default now()
);

-- ============ PAYMENTS (evidence for XPRIZE) ============
create table if not exists payments (
  id bigint generated always as identity primary key,
  payer_profile_id uuid references profiles(id),
  school_id uuid references schools(id),
  tier text not null check (tier in ('individual','school')),
  amount_nad numeric not null,          -- N$13 individual, N$299 school
  method text not null check (method in ('paytoday','dpo','bank_transfer','cash','mobile_money')),
  reference text,                        -- bank ref / receipt number
  status text not null default 'pending' check (status in ('pending','confirmed','refunded')),
  related_party boolean default false,   -- must be disclosed separately per XPRIZE rules
  confirmed_by uuid references profiles(id),
  created_at timestamptz default now(),
  confirmed_at timestamptz
);

-- ============ AI AGENT EXECUTION LOGS (XPRIZE evidence) ============
create table if not exists agent_logs (
  id bigint generated always as identity primary key,
  agent text not null check (agent in ('tutor','content_generator','lesson_planner','ministry_brief','support_onboarding','triage')),
  action text not null,
  input_summary text,
  output_summary text,
  tokens_in int,
  tokens_out int,
  model text default 'gemini-2.5-flash',
  success boolean default true,
  created_at timestamptz default now()
);

-- ============ MINISTRY BRIEFS (AI-generated weekly) ============
create table if not exists ministry_briefs (
  id bigint generated always as identity primary key,
  region text,                 -- null = national
  week_start date not null,
  content jsonb not null,      -- { headline, highlights[], risks[], recommendations[] }
  created_at timestamptz default now()
);

-- ============ HELPER: current role ============
create or replace function current_role_of() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select role from profiles where id = auth.uid()), 'anon');
$$;

create or replace function current_school_of() returns uuid
language sql stable security definer set search_path = public as $$
  select school_id from profiles where id = auth.uid();
$$;

-- ============ ROW LEVEL SECURITY ============
alter table schools enable row level security;
alter table profiles enable row level security;
alter table activities enable row level security;
alter table progress enable row level security;
alter table chat_messages enable row level security;
alter table lesson_plans enable row level security;
alter table payments enable row level security;
alter table agent_logs enable row level security;
alter table ministry_briefs enable row level security;

-- Schools: readable by all authenticated (needed for signup dropdown), managed by ministry
create policy schools_read on schools for select to authenticated using (true);
create policy schools_anon_read on schools for select to anon using (true);
create policy schools_ministry_write on schools for all to authenticated
  using (current_role_of() = 'ministry') with check (current_role_of() = 'ministry');

-- Profiles: own row; educators/school_admin see same-school; ministry sees all
create policy profiles_own on profiles for select to authenticated using (id = auth.uid());
create policy profiles_insert_own on profiles for insert to authenticated with check (id = auth.uid());
create policy profiles_update_own on profiles for update to authenticated using (id = auth.uid());
create policy profiles_school_read on profiles for select to authenticated
  using (current_role_of() in ('educator','school_admin') and school_id = current_school_of());
create policy profiles_ministry_read on profiles for select to authenticated
  using (current_role_of() = 'ministry');

-- Activities / progress / chat: own rows; school staff read same-school; ministry reads all
create policy act_own on activities for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy act_school on activities for select to authenticated
  using (current_role_of() in ('educator','school_admin')
         and user_id in (select id from profiles where school_id = current_school_of()));
create policy act_ministry on activities for select to authenticated using (current_role_of() = 'ministry');

create policy prog_own on progress for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy prog_school on progress for select to authenticated
  using (current_role_of() in ('educator','school_admin')
         and user_id in (select id from profiles where school_id = current_school_of()));
create policy prog_ministry on progress for select to authenticated using (current_role_of() = 'ministry');

create policy chat_own on chat_messages for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Lesson plans: educator owns; ministry reads all
create policy lp_own on lesson_plans for all to authenticated
  using (educator_id = auth.uid()) with check (educator_id = auth.uid());
create policy lp_ministry on lesson_plans for select to authenticated using (current_role_of() = 'ministry');

-- Payments: payer sees own; school_admin sees school; ministry sees all and confirms
create policy pay_own on payments for select to authenticated using (payer_profile_id = auth.uid());
create policy pay_insert on payments for insert to authenticated with check (payer_profile_id = auth.uid());
create policy pay_school on payments for select to authenticated
  using (current_role_of() = 'school_admin' and school_id = current_school_of());
create policy pay_ministry on payments for all to authenticated
  using (current_role_of() = 'ministry') with check (current_role_of() = 'ministry');

-- Agent logs: written by service role (proxy); ministry reads
create policy logs_ministry_read on agent_logs for select to authenticated using (current_role_of() = 'ministry');

-- Ministry briefs: ministry + school_admin read
create policy briefs_read on ministry_briefs for select to authenticated
  using (current_role_of() in ('ministry','school_admin'));

-- ============ FREE TIER ENFORCEMENT ============
-- Free educators: 10 lesson plans total. Individual (N$13) or school plan: unlimited.
create or replace function enforce_lesson_plan_limit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  n int; p text; sp text;
begin
  select plan into p from profiles where id = new.educator_id;
  select s.plan into sp from profiles pr left join schools s on s.id = pr.school_id where pr.id = new.educator_id;
  if coalesce(p,'free') = 'free' and coalesce(sp,'free') = 'free' then
    select count(*) into n from lesson_plans where educator_id = new.educator_id;
    if n >= 10 then
      raise exception 'FREE_LIMIT_REACHED: upgrade to Individual (N$13) or School (N$299) for unlimited lesson plans';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_lesson_plan_limit on lesson_plans;
create trigger trg_lesson_plan_limit before insert on lesson_plans
  for each row execute function enforce_lesson_plan_limit();

-- ============ SEED: Namibian regions' schools placeholder + demo ministry account note ============
insert into schools (name, region) values
  ('Windhoek High School', 'Khomas'),
  ('Jan Mohr Secondary School', 'Khomas'),
  ('Oshakati Secondary School', 'Oshana'),
  ('Rundu Secondary School', 'Kavango East'),
  ('Other / My school is not listed', 'Other')
on conflict do nothing;

-- ============ AGGREGATE VIEWS for dashboards ============
create or replace view school_stats as
select s.id as school_id, s.name, s.region, s.plan,
  count(distinct p.id) filter (where p.role = 'learner') as learners,
  count(distinct p.id) filter (where p.role = 'educator') as educators,
  count(distinct a.user_id) filter (where a.created_at > now() - interval '7 days') as active_7d,
  coalesce(avg(pr.mastery), 0)::numeric(5,1) as avg_mastery,
  coalesce(avg(pr.mastery - coalesce(pr.baseline_mastery, pr.mastery)), 0)::numeric(5,1) as avg_improvement
from schools s
left join profiles p on p.school_id = s.id
left join activities a on a.user_id = p.id
left join progress pr on pr.user_id = p.id
group by s.id, s.name, s.region, s.plan;

create or replace view topic_heatmap as
select p.region, pr.syllabus, pr.topic,
  count(distinct pr.user_id) as learners,
  avg(pr.mastery)::numeric(5,1) as avg_mastery
from progress pr join profiles p on p.id = pr.user_id
group by p.region, pr.syllabus, pr.topic;

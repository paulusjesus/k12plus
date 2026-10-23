-- K12Plus pilot, item 11: USSD on basic phones (*141*12#)
-- 2 November 2026
--
-- Additive only: a new table for USSD sessions and new pilot_ussd_* functions. No
-- existing data is changed or removed.
--
-- The `ussd` Edge Function answers the mobile network's USSD gateway. It finds the
-- learner by the phone number the network gives it, runs the menus, and keeps the
-- state of each session here between screens.
--
-- Collect as little as possible: the phone number itself is never stored, only a
-- keyed fingerprint (HMAC) made by the function, used to limit questions to the
-- agent per number and to count sessions for the cost report. Sessions are deleted
-- after 30 days. For pilot learners (enrolled, with school and parent or guardian
-- consent) each session and each practice answer is added to the learning record,
-- once only; for anyone else nothing is recorded. Sessions run from the
-- administrator's simulator are marked as simulated and record nothing.

create table if not exists public.ussd_sessions (
  session_id text primary key check (length(session_id) between 1 and 100),
  phone_hash text not null check (length(phone_hash) between 16 and 128),
  learner_id uuid references public.profiles(id) on delete set null,
  simulated boolean not null default false,
  state jsonb not null default '{}'::jsonb,
  steps int not null default 0,
  screens int not null default 0,
  ai_questions int not null default 0,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ussd_sessions_phone_idx on public.ussd_sessions (phone_hash, started_at desc);
create index if not exists ussd_sessions_started_idx on public.ussd_sessions (started_at);
alter table public.ussd_sessions enable row level security;

-- Opens a session (or returns the one already open), with the number of questions
-- this phone has asked the agent today. Old sessions are deleted on the way.
create or replace function public.pilot_ussd_session(p_session text, p_phone_hash text, p_simulated boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s ussd_sessions;
  asked int;
begin
  delete from ussd_sessions where started_at < now() - interval '30 days';
  insert into ussd_sessions (session_id, phone_hash, simulated) values (p_session, p_phone_hash, coalesce(p_simulated, false))
  on conflict (session_id) do nothing;
  select * into s from ussd_sessions where session_id = p_session;
  if s.phone_hash <> p_phone_hash then raise exception 'This session belongs to another phone.'; end if;
  -- questions asked from the administrator's simulator do not count against the learner
  select coalesce(sum(ai_questions), 0) into asked from ussd_sessions
   where phone_hash = p_phone_hash and not simulated and started_at >= date_trunc('day', now() at time zone 'Africa/Windhoek') at time zone 'Africa/Windhoek';
  return jsonb_build_object('state', s.state, 'steps', s.steps, 'learner_id', s.learner_id, 'simulated', s.simulated,
                            'asked_today', asked, 'started_at', s.started_at);
end;
$$;

create or replace function public.pilot_ussd_save(p_session text, p_state jsonb, p_steps int, p_learner uuid, p_ai int)
returns void
language sql security definer set search_path = public as $$
  update ussd_sessions
     set state = coalesce(p_state, '{}'::jsonb), steps = greatest(steps, coalesce(p_steps, 0)), learner_id = coalesce(p_learner, learner_id),
         screens = screens + 1, ai_questions = ai_questions + greatest(coalesce(p_ai, 0), 0), updated_at = now()
   where session_id = p_session;
$$;

-- The learners registered on a phone number (siblings may share a phone), with what
-- the menus need: first name, grade, whether they are in a class, take part in the
-- pilot, or are in the middle of a test (then the agent takes a break).
create or replace function public.pilot_ussd_who(p_phone text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare d text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
begin
  if d like '00%' then d := substr(d, 3); end if;
  if d like '0%' then d := '264' || substr(d, 2); end if;
  if length(d) < 9 then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', p.id,
             'first_name', left(split_part(trim(coalesce(p.username, '')), ' ', 1), 20),
             'grade', p.grade,
             'in_class', exists (select 1 from enrolments e where e.learner_id = p.id and e.status = 'active'),
             'taking_part', pilot_active(p.id),
             'locked', pilot_test_in_progress(p.id)) order by p.username, p.id)
      from (select * from profiles where phone_e164 = d and role = 'learner' order by username, id limit 5) p), '[]'::jsonb);
end;
$$;

-- A registered learner who is not yet in a class joins one with the class code.
create or replace function public.pilot_ussd_join(p_learner uuid, p_code text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  select id into cid from classes where class_code = upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')) and pilot;
  if cid is null then return jsonb_build_object('ok', false, 'error', 'That class code was not found. Check it with your teacher.'); end if;
  begin
    return pilot_enrol(cid, p_learner, 'ussd');
  exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
  end;
end;
$$;

-- Records for the learning record: one 'ussd' record per session (for the cost
-- report) and one 'practice' or 'lesson' record per answer or lesson. Pilot learners
-- only; each record has its own reference, so a repeated screen stores nothing twice.
create or replace function public.pilot_ussd_record(p_learner uuid, p_events jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  cls uuid;
  e jsonb;
  n int := 0;
begin
  if p_learner is null or not pilot_active(p_learner) then return jsonb_build_object('stored', 0, 'taking_part', false); end if;
  if jsonb_typeof(p_events) <> 'array' then return jsonb_build_object('stored', 0); end if;
  select pp.class_id into cls from pilot_participants pp where pp.learner_id = p_learner limit 1;
  for e in select * from jsonb_array_elements(p_events) limit 20 loop
    if coalesce(e->>'kind', '') not in ('ussd', 'practice', 'lesson', 'question') then continue; end if;
    if length(coalesce(e->>'client_ref', '')) not between 8 and 64 then continue; end if;
    insert into learning_events (learner_id, class_id, kind, subject, topic, correct, attempted, duration_seconds, offline, client_ref, occurred_at)
    values (p_learner, cls, e->>'kind', left(nullif(trim(coalesce(e->>'subject', '')), ''), 60), left(nullif(trim(coalesce(e->>'topic', '')), ''), 120),
            least(greatest((e->>'correct')::int, 0), 100), least(greatest((e->>'attempted')::int, 0), 100), null, false,
            e->>'client_ref', now())
    on conflict (learner_id, client_ref) do nothing;
    if found then n := n + 1; end if;
  end loop;
  return jsonb_build_object('stored', n, 'taking_part', true);
end;
$$;

-- "My results": practice in the last 30 days (on the app and by USSD), with the
-- strongest and weakest topic. Only pilot learners have results stored.
create or replace function public.pilot_ussd_results(p_learner uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  if p_learner is null or not pilot_active(p_learner) then return jsonb_build_object('taking_part', false); end if;
  with t as (
    select topic, sum(coalesce(correct, 0))::int right_n, sum(coalesce(attempted, 0))::int tried
      from learning_events
     where learner_id = p_learner and kind in ('practice', 'quiz', 'game') and occurred_at >= now() - interval '30 days'
     group by topic)
  select jsonb_build_object('taking_part', true,
           'right', coalesce(sum(right_n), 0), 'tried', coalesce(sum(tried), 0),
           'best', (select topic from t where topic is not null and tried >= 3 order by right_n::numeric / tried desc, tried desc limit 1),
           'weakest', (select topic from t where topic is not null and tried >= 3 order by right_n::numeric / tried, tried desc limit 1))
    into r from t;
  return r;
end;
$$;

-- For the administrator's simulator: usage in the last 30 days, without numbers or names.
create or replace function public.pilot_ussd_stats()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not pilot_is_admin() then raise exception 'Only K-12 EdTech administrators can see USSD figures.'; end if;
  return (select jsonb_build_object(
            'sessions', count(*) filter (where not simulated),
            'phones', count(distinct phone_hash) filter (where not simulated),
            'registered', count(*) filter (where not simulated and learner_id is not null),
            'screens', coalesce(sum(screens) filter (where not simulated), 0),
            'ai_questions', coalesce(sum(ai_questions) filter (where not simulated), 0),
            'simulated', count(*) filter (where simulated))
            from ussd_sessions where started_at >= now() - interval '30 days');
end;
$$;

do $$
declare f text;
begin
  foreach f in array array['pilot_ussd_session(text, text, boolean)', 'pilot_ussd_save(text, jsonb, int, uuid, int)', 'pilot_ussd_who(text)',
                           'pilot_ussd_join(uuid, text)', 'pilot_ussd_record(uuid, jsonb)', 'pilot_ussd_results(uuid)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
revoke execute on function public.pilot_ussd_stats() from public, anon;
grant execute on function public.pilot_ussd_stats() to authenticated;

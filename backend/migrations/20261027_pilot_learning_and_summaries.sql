-- K12Plus pilot, item 4: Monday summary for teachers (with the learning record)
-- 27 October 2026
--
-- Additive only: new tables learning_events and teacher_summaries, new pilot_*
-- functions, and a weekly scheduled job. No existing data is changed.
--
-- Learning record: the app records questions asked, quiz, game and practice
-- results (by subject and topic) and minutes of activity, but ONLY for learners
-- who take part in the pilot (enrolled, with school and parent or guardian
-- consent). For anyone else nothing is stored. Records made offline are synced
-- later; each record has a client reference so it is stored once only.
--
-- Monday summary: every Monday at 06:00 Namibian time a scheduled job builds a
-- summary for each pilot class from last week's records (Monday to Sunday):
-- who was not active, the weakest topics, and how much the class used K12Plus.
-- The figures come straight from the records with a fixed template. The summary
-- appears on the teacher's Pilot page, and its delivery is logged through the
-- message gate (item 7). Learner names are not written into the log; the
-- teacher's page looks them up when it is opened.

-- ============ 1. Learning record ============
create table if not exists public.learning_events (
  id bigint generated always as identity primary key,
  learner_id uuid not null references public.profiles(id) on delete cascade,
  class_id uuid references public.classes(id) on delete set null,
  kind text not null check (kind in ('question', 'quiz', 'game', 'practice', 'lesson', 'active', 'ussd')),
  subject text,
  topic text,
  correct int check (correct between 0 and 100),
  attempted int check (attempted between 0 and 100),
  duration_seconds int check (duration_seconds between 0 and 3600),
  offline boolean not null default false,
  client_ref text not null,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  unique (learner_id, client_ref)
);
create index if not exists learning_events_learner_idx on public.learning_events (learner_id, occurred_at desc);
create index if not exists learning_events_class_idx on public.learning_events (class_id, occurred_at desc);
alter table public.learning_events enable row level security;

-- The app sends a batch of records. Nothing is stored unless the learner takes part.
create or replace function public.pilot_record_events(p_events jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  cls uuid;
  e jsonb;
  n int := 0;
  at_ts timestamptz;
begin
  if me is null then raise exception 'Please log in first.'; end if;
  if not pilot_active(me) then return jsonb_build_object('stored', 0, 'taking_part', false); end if;
  if jsonb_typeof(p_events) <> 'array' then raise exception 'Expected a list of records.'; end if;
  select pp.class_id into cls from pilot_participants pp where pp.learner_id = me limit 1;
  for e in select * from jsonb_array_elements(p_events) limit 100 loop
    begin
      at_ts := (e->>'occurred_at')::timestamptz;
    exception when others then
      continue;
    end;
    -- ignore records from the future or more than 30 days old
    if at_ts is null or at_ts > now() + interval '10 minutes' or at_ts < now() - interval '30 days' then continue; end if;
    if coalesce(e->>'kind', '') not in ('question', 'quiz', 'game', 'practice', 'lesson', 'active') then continue; end if;
    if length(coalesce(e->>'client_ref', '')) not between 8 and 64 then continue; end if;
    insert into learning_events (learner_id, class_id, kind, subject, topic, correct, attempted, duration_seconds, offline, client_ref, occurred_at)
    values (me, cls, e->>'kind', left(nullif(trim(coalesce(e->>'subject', '')), ''), 60), left(nullif(trim(coalesce(e->>'topic', '')), ''), 120),
            least(greatest((e->>'correct')::int, 0), 100), least(greatest((e->>'attempted')::int, 0), 100),
            least(greatest((e->>'duration_seconds')::int, 0), 3600), coalesce((e->>'offline')::boolean, false),
            e->>'client_ref', at_ts)
    on conflict (learner_id, client_ref) do nothing;
    if found then n := n + 1; end if;
  end loop;
  return jsonb_build_object('stored', n, 'taking_part', true);
end;
$$;

-- ============ 2. Monday summaries ============
create table if not exists public.teacher_summaries (
  id bigint generated always as identity primary key,
  class_id uuid not null references public.classes(id) on delete cascade,
  week_start date not null,
  data jsonb not null,
  created_at timestamptz not null default now(),
  unique (class_id, week_start)
);
alter table public.teacher_summaries enable row level security;

-- Builds last week's summary for every pilot class that has a teacher.
-- Safe to run more than once: a class gets one summary per week.
-- p_now is only for tests; the scheduled job never passes it.
create or replace function public.pilot_build_monday_summaries(p_now timestamptz default now())
returns int
language plpgsql security definer set search_path = public as $$
declare
  tz text := coalesce((select time_zone from messaging_rules where id = 1), 'Africa/Windhoek');
  this_monday date := date_trunc('week', p_now at time zone tz)::date;
  w_start timestamptz := ((this_monday - 7)::timestamp) at time zone tz;
  w_end timestamptz := (this_monday::timestamp) at time zone tz;
  c record;
  d jsonb;
  built int := 0;
  sid bigint;
  t record;
  body text;
begin
  for c in select cl.id, cl.name from classes cl
            where cl.pilot and exists (select 1 from class_teachers ct where ct.class_id = cl.id) loop
    with part as (
      select pp.learner_id, e.enrolled_at from pilot_participants pp
        join enrolments e on e.learner_id = pp.learner_id and e.class_id = pp.class_id and e.status = 'active'
       where pp.class_id = c.id
    ), ev as (
      select le.* from learning_events le join part on part.learner_id = le.learner_id
       where le.occurred_at >= w_start and le.occurred_at < w_end
    ), topics as (
      select topic, sum(correct)::int as correct, sum(attempted)::int as attempted
        from ev where kind in ('quiz', 'game', 'practice') and topic is not null and attempted > 0
       group by topic having sum(attempted) >= 5
    )
    select jsonb_build_object(
      'week_start', this_monday - 7, 'week_end', this_monday - 1,
      'taking_part', (select count(*) from part),
      'active', (select count(distinct learner_id) from ev),
      'not_active', coalesce((select jsonb_agg(part.learner_id) from part
                               where part.enrolled_at < w_end
                                 and not exists (select 1 from ev where ev.learner_id = part.learner_id)), '[]'::jsonb),
      'topics', coalesce((select jsonb_agg(jsonb_build_object('topic', topic, 'correct', correct, 'attempted', attempted)
                                             order by correct::numeric / attempted, attempted desc)
                            from (select * from topics where correct::numeric / attempted < 0.6
                                   order by correct::numeric / attempted, attempted desc limit 3) x), '[]'::jsonb),
      'questions', (select count(*) from ev where kind = 'question'),
      'practice', coalesce((select sum(attempted) from ev where kind in ('quiz', 'game', 'practice')), 0),
      'minutes', coalesce((select round(sum(duration_seconds) / 60.0) from ev where kind = 'active'), 0)
    ) into d;

    insert into teacher_summaries (class_id, week_start, data) values (c.id, this_monday - 7, d)
    on conflict (class_id, week_start) do nothing
    returning id into sid;
    if sid is null then continue; end if;
    built := built + 1;

    body := 'Monday summary for ' || c.name || ', week of ' || to_char(this_monday - 7, 'FMDD Mon YYYY') || ': '
         || case when (d->>'taking_part')::int = 0
                 then 'no learner in this class takes part in the pilot yet. Learners take part once their parent or guardian and the school have given consent. Open the Pilot page to record consent.'
                 else ''
            end;
    if (d->>'taking_part')::int > 0 then
      body := body
         || (d->>'active') || ' of ' || (d->>'taking_part') || ' learners were active, '
         || jsonb_array_length(d->'not_active') || ' not active, '
         || (d->>'questions') || case when (d->>'questions') = '1' then ' question asked, ' else ' questions asked, ' end
         || (d->>'practice') || case when (d->>'practice') = '1' then ' practice answer, ' else ' practice answers, ' end
         || (d->>'minutes') || case when (d->>'minutes') = '1' then ' minute. ' else ' minutes. ' end
         || case when jsonb_array_length(d->'topics') = 0 then 'No topic stood out as weak.'
                 else 'Topics to revisit: ' || (select string_agg(x->>'topic', ', ') from jsonb_array_elements(d->'topics') x) || '.' end
         || ' Open the Pilot page for names and details.';
    end if;
    for t in select teacher_id from class_teachers where class_id = c.id loop
      perform pilot_log_message(jsonb_build_object(
        'recipient_kind', 'teacher', 'teacher_id', t.teacher_id, 'channel', 'in_app', 'purpose', 'monday_summary',
        'body', body, 'content_ok', true, 'content_reason', 'fixed template from recorded figures'), p_now);
    end loop;
  end loop;
  return built;
end;
$$;
revoke execute on function public.pilot_build_monday_summaries(timestamptz) from public, anon, authenticated;
grant execute on function public.pilot_build_monday_summaries(timestamptz) to service_role;

-- Teacher: the latest summaries for each of my classes, with names of learners
-- who were not active (only learners who still take part are named).
create or replace function public.pilot_my_summaries()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Please log in first.'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('class_id', c.id, 'class', c.name, 'summaries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'week_start', ts.week_start, 'week_end', (ts.data->>'week_end')::date,
        'taking_part', (ts.data->>'taking_part')::int, 'active', (ts.data->>'active')::int,
        'questions', (ts.data->>'questions')::int, 'practice', (ts.data->>'practice')::int, 'minutes', (ts.data->>'minutes')::int,
        'topics', ts.data->'topics',
        'not_active', coalesce((select jsonb_agg(p.username order by p.username)
                                  from jsonb_array_elements_text(ts.data->'not_active') na
                                  join pilot_participants pp on pp.learner_id = na::uuid
                                  join profiles p on p.id = pp.learner_id), '[]'::jsonb)
      ) order by ts.week_start desc)
        from (select * from teacher_summaries where class_id = c.id order by week_start desc limit 4) ts), '[]'::jsonb)
    ) order by c.grade)
      from class_teachers ct join classes c on c.id = ct.class_id
     where ct.teacher_id = auth.uid()), '[]'::jsonb);
end;
$$;

-- Administrator: how many classes got their summary in each of the last weeks
create or replace function public.pilot_summary_status()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not pilot_is_admin() then raise exception 'Only K-12 EdTech administrators can see this.'; end if;
  return jsonb_build_object(
    'classes_with_teacher', (select count(*) from classes cl where cl.pilot and exists (select 1 from class_teachers ct where ct.class_id = cl.id)),
    'weeks', coalesce((select jsonb_agg(jsonb_build_object('week_start', week_start, 'classes', n, 'built_at', built_at) order by week_start desc)
                         from (select week_start, count(*) n, max(created_at) built_at from teacher_summaries
                                group by week_start order by week_start desc limit 6) w), '[]'::jsonb)
  );
end;
$$;

-- ============ 3. Withdrawal removes the learning record too ============
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
  delete from learner_messages where learner_id = lid;
  delete from message_log where learner_id = lid;
  delete from learning_events where learner_id = lid;
  update teacher_summaries
     set data = jsonb_set(data, '{not_active}', coalesce((select jsonb_agg(x) from jsonb_array_elements(data->'not_active') x
                                                           where x <> to_jsonb(lid::text)), '[]'::jsonb))
   where data->'not_active' ? lid::text;
  -- (later pilot items add their tables here)
  update data_removals set status = 'done', done_at = now(), done_by = auth.uid() where id = p_removal;
  return jsonb_build_object('ok', true);
end;
$$;

-- ============ 4. Who may call what ============
do $$
declare f text;
begin
  foreach f in array array['pilot_record_events(jsonb)', 'pilot_my_summaries()', 'pilot_summary_status()']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- ============ 5. The weekly job: Mondays 06:00 Namibian time (04:00 UTC) ============
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.unschedule(jobid) from cron.job where jobname = 'k12plus-monday-summaries';
    perform cron.schedule('k12plus-monday-summaries', '0 4 * * 1', 'select public.pilot_build_monday_summaries()');
  end if;
end $$;

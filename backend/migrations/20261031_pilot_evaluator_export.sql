-- K12Plus pilot, item 10: data export for the independent evaluator
-- 31 October 2026
--
-- Additive only: one new table (school_codes) and new pilot_* functions.
-- No existing data is changed.
--
-- The export holds only learners who take part in the pilot (enrolled, with school
-- and parent or guardian consent). Every learner appears under their pilot ID.
-- There are no names, phone numbers, email addresses, K12Plus IDs, account IDs,
-- class join codes, free text (no questions, answers or comments) or birth dates.
-- Schools appear as codes (S + 5 characters); the key that links codes to schools
-- stays with K-12 EdTech. Dates are given as days or weeks.
--
-- Small groups: where a school has fewer than 5 learners taking part in a grade,
-- the region, setting, school and class codes of those learners are left out (each
-- region has only one rural and one urban school, so region and setting would point
-- to the school), and in the school
-- tables any figure describing fewer than 5 learners is left blank, so no learner
-- can be picked out.
--
-- The data dictionary (pilot_export_dictionary) describes every field of every file.

create table if not exists public.school_codes (
  school_id uuid primary key references public.schools(id) on delete cascade,
  code text not null unique,
  created_at timestamptz not null default now()
);
alter table public.school_codes enable row level security;

-- ============ 1. The data dictionary ============
create or replace function public.pilot_export_dictionary()
returns table (file text, field text, type text, description text)
language sql immutable as $$
  values
  ('learners.csv', 'pilot_id', 'text', 'Pseudonymous learner ID (P followed by 12 characters). The same learner has the same ID in every file and every export. K-12 EdTech alone can link it to a person.'),
  ('learners.csv', 'grade', 'integer', 'Grade of the learner''s pilot class: 11 or 12.'),
  ('learners.csv', 'syllabus', 'text', 'Mathematics syllabus followed: 6131 (NSSCO, Grades 10 and 11) or 8227 (NSSCAS, Grade 12).'),
  ('learners.csv', 'region', 'text', 'One of Namibia''s 14 regions. Blank for learners in a small group (see small_group), because each region has only one rural and one urban pilot school.'),
  ('learners.csv', 'setting', 'text', 'rural or urban, as agreed for the school when the pilot was set up. Blank for learners in a small group (see small_group).'),
  ('learners.csv', 'school_code', 'text', 'Code of the learner''s school (S followed by 5 characters). Blank when fewer than 5 learners take part in that grade at that school (see small_group).'),
  ('learners.csv', 'class_code', 'text', 'School code plus grade, for example S7K2QP-G11. Each pilot school has one Grade 11 and one Grade 12 mathematics class. Blank when school_code is blank.'),
  ('learners.csv', 'small_group', 'integer', '1 when region, setting, school_code and class_code are left out because fewer than 5 learners take part in that grade at that school, otherwise 0. These learners can still be used in analyses that do not need the school.'),
  ('learners.csv', 'enrolled_week', 'date', 'Monday (Namibian time) of the week the learner joined the pilot class.'),
  ('test_scores.csv', 'pilot_id', 'text', 'Pseudonymous learner ID, as in learners.csv.'),
  ('test_scores.csv', 'test_code', 'text', 'Code of the test, for example PILOT27-G11-A. Codes ending in A are the start of the year (baseline) tests and codes ending in B the end of the year (endline) tests.'),
  ('test_scores.csv', 'purpose', 'text', 'baseline (start of the year, Version A) or endline (end of the year, Version B). Both versions test the same topics in the same order.'),
  ('test_scores.csv', 'grade', 'integer', 'Grade the test is for: 11 or 12.'),
  ('test_scores.csv', 'mode', 'text', 'phone (the learner sat the test in the app) or paper (the learner wrote it on paper and the teacher typed the answers in). Both are marked the same way.'),
  ('test_scores.csv', 'submitted_date', 'date', 'Day the test was submitted (Namibian time). For paper tests, the day the teacher entered the answers.'),
  ('test_scores.csv', 'score', 'integer', 'Marks scored. Each question is worth 1 mark.'),
  ('test_scores.csv', 'max_score', 'integer', 'Marks available: 38 for Grade 11, 30 for Grade 12.'),
  ('test_scores.csv', 'percent', 'number', 'score divided by max_score, times 100, to one decimal place.'),
  ('test_items.csv', 'pilot_id', 'text', 'Pseudonymous learner ID, as in learners.csv.'),
  ('test_items.csv', 'test_code', 'text', 'Code of the test, as in test_scores.csv.'),
  ('test_items.csv', 'item', 'integer', 'Question number in the test, from 1. Question n in Version A and question n in Version B test the same topic.'),
  ('test_items.csv', 'topic', 'text', 'Syllabus topic of the question.'),
  ('test_items.csv', 'sub_topic', 'text', 'Syllabus sub-topic of the question (Grade 11 only; blank for Grade 12).'),
  ('test_items.csv', 'item_type', 'text', 'choice (multiple choice, 4 options) or short (a short typed answer, marked automatically).'),
  ('test_items.csv', 'answered', 'integer', '1 when the learner gave an answer, 0 when the question was left blank.'),
  ('test_items.csv', 'correct', 'integer', '1 when the answer was marked right, otherwise 0. A blank answer is 0.'),
  ('usage_weekly.csv', 'pilot_id', 'text', 'Pseudonymous learner ID, as in learners.csv.'),
  ('usage_weekly.csv', 'week_start', 'date', 'Monday of the week (Namibian time). There is a row for every week from the learner''s enrolled_week (or the start of the export period) to the end of the period, including weeks with no activity.'),
  ('usage_weekly.csv', 'active', 'integer', '1 when the learner did anything in K12Plus that week (asked the agent, practised, played, took a quiz, opened a lesson or used USSD), otherwise 0.'),
  ('usage_weekly.csv', 'sessions', 'integer', 'Number of separate sessions. A new session starts after 30 minutes without any activity.'),
  ('usage_weekly.csv', 'minutes', 'integer', 'Minutes of active use in the app: counted only while the app was open and the learner had touched, typed or scrolled in the last minute.'),
  ('usage_weekly.csv', 'questions', 'integer', 'Questions asked to the AI Math Agent.'),
  ('usage_weekly.csv', 'practice_answers', 'integer', 'Answers given in practice, games and quizzes.'),
  ('usage_weekly.csv', 'topics_practised', 'integer', 'Number of different syllabus topics the learner asked about or practised.'),
  ('usage_weekly.csv', 'ussd_sessions', 'integer', 'Sessions on a basic phone through USSD.'),
  ('usage_weekly.csv', 'data_mb', 'number', 'Megabytes (millions of bytes) of data K12Plus used on the learner''s phone, measured in the app. Covers K12Plus pages, files and answers; not other use of the phone.'),
  ('usage_weekly.csv', 'texts_received', 'integer', 'Text messages (SMS) from the agent delivered to the learner.'),
  ('schools.csv', 'school_code', 'text', 'Code of the school, as in learners.csv.'),
  ('schools.csv', 'region', 'text', 'Region of the school (one of Namibia''s 14 regions).'),
  ('schools.csv', 'setting', 'text', 'rural or urban, as agreed for the school when the pilot was set up.'),
  ('schools.csv', 'learners_grade11', 'integer', 'Learners taking part in Grade 11. Blank when between 1 and 4.'),
  ('schools.csv', 'learners_grade12', 'integer', 'Learners taking part in Grade 12. Blank when between 1 and 4.'),
  ('costs_monthly.csv', 'month', 'date', 'First day of the month.'),
  ('costs_monthly.csv', 'school_code', 'text', 'Code of the school, as in learners.csv; ALL for the whole pilot.'),
  ('costs_monthly.csv', 'learners', 'integer', 'Learners taking part at the school. Blank when between 1 and 4 (the cost figures for that school are then blank too).'),
  ('costs_monthly.csv', 'active_learners', 'integer', 'Learners with any activity in the month. Blank when the school row is suppressed.'),
  ('costs_monthly.csv', 'data_mb', 'number', 'Megabytes of data used on learners'' phones in the month (see usage_weekly.csv).'),
  ('costs_monthly.csv', 'texts', 'integer', 'Text messages delivered (for ALL, including texts to teachers).'),
  ('costs_monthly.csv', 'ussd_sessions', 'integer', 'USSD sessions in the month.'),
  ('costs_monthly.csv', 'cost_usd', 'number', 'Cost in US dollars: data at the price per GB, texts at the price per message (or the provider''s actual price), USSD sessions at the price per session, plus costs typed in by K-12 EdTech, such as data bundles. Prices are listed in README.txt.'),
  ('costs_monthly.csv', 'cost_per_learner_usd', 'number', 'cost_usd divided by learners. The pilot budget is US$2.50 per learner per month.')
$$;

-- ============ 2. The export ============
create or replace function public.pilot_evaluator_export(p_from date default null, p_to date default null)
returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  tz text := coalesce((select time_zone from messaging_rules where id = 1), 'Africa/Windhoek');
  d_from date;
  d_to date := coalesce(p_to, (now() at time zone tz)::date);
  t0 timestamptz;
  t1 timestamptz;
  cs cost_settings;
  m date;
  rep jsonb;
  cost_rows jsonb := '[]'::jsonb;
  out jsonb;
begin
  if not pilot_is_admin() then raise exception 'Only K-12 EdTech administrators can export pilot data.'; end if;
  select * into cs from cost_settings where id = 1;
  d_from := coalesce(p_from, (select min((e.enrolled_at at time zone tz)::date) from enrolments e), d_to);
  if d_to < d_from then raise exception 'Choose a start date on or before the end date.'; end if;
  t0 := (d_from::timestamp) at time zone tz;
  t1 := ((d_to + 1)::timestamp) at time zone tz;

  -- a code for every pilot school (kept for later exports)
  insert into school_codes (school_id, code)
  select s.id, 'S' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 5)) from schools s
   where s.in_pilot and not exists (select 1 from school_codes c where c.school_id = s.id)
  on conflict do nothing;

  drop table if exists pg_temp.ex_l;
  create temp table ex_l (learner_id uuid, pseudo_id text, grade int, region text, setting text, school_id uuid,
                          school_code text, small boolean, enrolled_week date) on commit drop;
  insert into ex_l
  select pp.learner_id, pp.pseudo_id, pp.grade, r.name, pp.setting, pp.school_id, sc.code,
         count(*) over (partition by pp.school_id, pp.grade) < 5,
         date_trunc('week', pp.enrolled_at at time zone tz)::date
    from pilot_participants pp
    left join regions r on r.id = pp.region_id
    left join school_codes sc on sc.school_id = pp.school_id;

  -- learners
  out := jsonb_build_object('learners.csv', jsonb_build_object(
    'columns', jsonb_build_array('pilot_id', 'grade', 'syllabus', 'region', 'setting', 'school_code', 'class_code', 'small_group', 'enrolled_week'),
    'rows', coalesce((select jsonb_agg(jsonb_build_array(pseudo_id, grade, case when grade = 12 then '8227' else '6131' end,
                                                          case when small then null else region end, case when small then null else setting end,
                                                          case when small then null else school_code end,
                                                          case when small then null else school_code || '-G' || grade end,
                                                          case when small then 1 else 0 end, enrolled_week) order by pseudo_id) from ex_l), '[]'::jsonb)));

  -- test scores and items (submitted tests in the period)
  out := out || jsonb_build_object('test_scores.csv', jsonb_build_object(
    'columns', jsonb_build_array('pilot_id', 'test_code', 'purpose', 'grade', 'mode', 'submitted_date', 'score', 'max_score', 'percent'),
    'rows', coalesce((select jsonb_agg(jsonb_build_array(l.pseudo_id, t.code, t.purpose, t.grade, a.mode, (a.submitted_at at time zone tz)::date,
                                                          a.score, a.max_score, round(100.0 * a.score / nullif(a.max_score, 0), 1)) order by t.code, l.pseudo_id)
                        from test_attempts a join ex_l l on l.learner_id = a.learner_id join tests t on t.id = a.test_id
                       where a.submitted_at >= t0 and a.submitted_at < t1), '[]'::jsonb)));
  out := out || jsonb_build_object('test_items.csv', jsonb_build_object(
    'columns', jsonb_build_array('pilot_id', 'test_code', 'item', 'topic', 'sub_topic', 'item_type', 'answered', 'correct'),
    'rows', coalesce((select jsonb_agg(jsonb_build_array(l.pseudo_id, t.code, i.position, i.topic, i.sub_topic, i.kind,
                                                          case when coalesce(r.answer, '') <> '' then 1 else 0 end,
                                                          case when r.correct then 1 else 0 end) order by t.code, l.pseudo_id, i.position)
                        from test_attempts a join ex_l l on l.learner_id = a.learner_id join tests t on t.id = a.test_id
                        join test_items i on i.test_id = a.test_id
                        left join test_responses r on r.attempt_id = a.id and r.item_id = i.id
                       where a.submitted_at >= t0 and a.submitted_at < t1), '[]'::jsonb)));

  -- weekly use, with a row for every week
  out := out || jsonb_build_object('usage_weekly.csv', jsonb_build_object(
    'columns', jsonb_build_array('pilot_id', 'week_start', 'active', 'sessions', 'minutes', 'questions', 'practice_answers', 'topics_practised', 'ussd_sessions', 'data_mb', 'texts_received'),
    'rows', coalesce((
      with ev as (
        select le.learner_id, le.kind, le.topic, le.attempted, le.duration_seconds, le.bytes,
               date_trunc('week', le.occurred_at at time zone tz)::date as wk,
               case when le.kind <> 'data' and (lag(le.occurred_at) over w is null or le.occurred_at - lag(le.occurred_at) over w > interval '30 minutes') then 1 else 0 end as new_session
          from learning_events le join ex_l using (learner_id)
         where le.occurred_at >= t0 and le.occurred_at < t1
        window w as (partition by le.learner_id, (le.kind = 'data') order by le.occurred_at)
      ), agg as (
        select learner_id, wk,
               count(*) filter (where kind <> 'data') n,
               sum(new_session)::int sessions,
               round(coalesce(sum(duration_seconds) filter (where kind = 'active'), 0) / 60.0)::int minutes,
               count(*) filter (where kind = 'question')::int questions,
               coalesce(sum(attempted) filter (where kind in ('quiz', 'game', 'practice')), 0)::int practice,
               count(distinct topic) filter (where kind in ('question', 'quiz', 'game', 'practice', 'lesson'))::int topics,
               count(*) filter (where kind = 'ussd')::int ussd,
               coalesce(sum(bytes) filter (where kind = 'data'), 0) bytes
          from ev group by learner_id, wk
      ), sms as (
        select ml.learner_id, date_trunc('week', ml.delivered_at at time zone tz)::date wk, count(*)::int n
          from message_log ml join ex_l using (learner_id)
         where ml.recipient_kind = 'learner' and ml.channel = 'sms' and ml.status = 'sent' and ml.delivered_at >= t0 and ml.delivered_at < t1
         group by 1, 2
      ), weeks as (
        select l.learner_id, l.pseudo_id, g::date wk
          from ex_l l, generate_series(greatest(l.enrolled_week, date_trunc('week', d_from)::date), date_trunc('week', d_to)::date, interval '7 days') g
      )
      select jsonb_agg(jsonb_build_array(w.pseudo_id, w.wk, case when coalesce(a.n, 0) > 0 then 1 else 0 end, coalesce(a.sessions, 0), coalesce(a.minutes, 0),
                                         coalesce(a.questions, 0), coalesce(a.practice, 0), coalesce(a.topics, 0), coalesce(a.ussd, 0),
                                         round(coalesce(a.bytes, 0) / 1e6, 2), coalesce(s.n, 0)) order by w.pseudo_id, w.wk)
        from weeks w left join agg a on a.learner_id = w.learner_id and a.wk = w.wk
        left join sms s on s.learner_id = w.learner_id and s.wk = w.wk), '[]'::jsonb)));

  -- schools (codes only), small counts left blank
  out := out || jsonb_build_object('schools.csv', jsonb_build_object(
    'columns', jsonb_build_array('school_code', 'region', 'setting', 'learners_grade11', 'learners_grade12'),
    'rows', coalesce((select jsonb_agg(jsonb_build_array(sc.code, r.name, s.setting,
                                                          case when g11 between 1 and 4 then null else g11 end,
                                                          case when g12 between 1 and 4 then null else g12 end) order by r.name, sc.code)
                        from schools s join school_codes sc on sc.school_id = s.id left join regions r on r.id = s.region_id,
                        lateral (select count(*) filter (where grade = 11)::int g11, count(*) filter (where grade = 12)::int g12 from ex_l where ex_l.school_id = s.id) c
                       where s.in_pilot), '[]'::jsonb)));

  -- monthly data and costs per school (from the usage report), small schools left blank
  m := date_trunc('month', d_from)::date;
  while m <= d_to loop
    rep := pilot_report_core(greatest(m, d_from), least((m + interval '1 month - 1 day')::date, d_to), null);
    cost_rows := cost_rows || coalesce((
      select jsonb_agg(jsonb_build_array(m, case when x->>'level' = 'total' then 'ALL' else sc.code end,
                                         case when (x->>'learners')::int between 1 and 4 then null else (x->>'learners')::int end,
                                         case when (x->>'learners')::int between 1 and 4 then null else (x->>'active')::int end,
                                         case when (x->>'learners')::int between 1 and 4 then null else (x->>'data_mb')::numeric end,
                                         case when (x->>'learners')::int between 1 and 4 then null else (x->>'sms')::int end,
                                         case when (x->>'learners')::int between 1 and 4 then null else (x->>'ussd')::int end,
                                         case when (x->>'learners')::int between 1 and 4 then null else (x->>'cost_total')::numeric end,
                                         case when (x->>'learners')::int between 1 and 4 then null else (x->>'cost_per_learner')::numeric end)
                       order by x->>'level' desc, sc.code)
        from jsonb_array_elements(rep->'rows') x left join school_codes sc on sc.school_id = (x->>'school_id')::uuid
       where x->>'level' in ('school', 'total')), '[]'::jsonb);
    m := (m + interval '1 month')::date;
  end loop;
  out := out || jsonb_build_object('costs_monthly.csv', jsonb_build_object(
    'columns', jsonb_build_array('month', 'school_code', 'learners', 'active_learners', 'data_mb', 'texts', 'ussd_sessions', 'cost_usd', 'cost_per_learner_usd'),
    'rows', cost_rows));

  return jsonb_build_object(
    'generated_at', now(), 'from', d_from, 'to', d_to,
    'learners', (select count(*) from ex_l),
    'rates', jsonb_build_object('data_usd_per_gb', cs.data_usd_per_gb, 'sms_usd', cs.sms_usd, 'ussd_session_usd', cs.ussd_session_usd,
                                'budget_per_learner_usd', cs.budget_per_learner_usd),
    'files', out,
    'dictionary', (select jsonb_agg(jsonb_build_array(d.file, d.field, d.type, d.description)) from pilot_export_dictionary() d));
end;
$$;

-- the key linking school codes to schools: for K-12 EdTech only, never sent with the export
create or replace function public.pilot_school_key()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not pilot_is_admin() then raise exception 'Only K-12 EdTech administrators can see the school code key.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('school_code', c.code, 'school', s.name, 'region', r.name, 'setting', s.setting) order by r.name, c.code)
                     from school_codes c join schools s on s.id = c.school_id left join regions r on r.id = s.region_id), '[]'::jsonb);
end;
$$;

do $$
declare f text;
begin
  foreach f in array array['pilot_evaluator_export(date, date)', 'pilot_school_key()']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke execute on function public.pilot_export_dictionary() from public, anon;
grant execute on function public.pilot_export_dictionary() to authenticated;

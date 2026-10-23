-- K12Plus pilot, item 3: baseline and endline tests
-- 28 October 2026
--
-- Additive only: new tables tests, test_items, test_windows, test_attempts and
-- test_responses, and new pilot_* functions. No existing data is changed.
--
-- The questions and answers are NOT in this file or anywhere in the code: they
-- are loaded into the database separately, because the code is public. Learners
-- never receive the answers: marking happens in the database.
--
-- * A test is one version (A for the baseline, B for the endline) for one grade.
--   It starts as a draft and cannot be opened until an administrator approves it.
-- * An administrator opens a window for each school (or all pilot schools).
-- * A learner who takes part sits the test on a phone while the window is open.
--   Answers are saved as they go, so the test can be finished in a second sitting.
-- * While a learner's test is open and not submitted, the agent does not help them.
-- * A teacher can enter the answers from a paper version for learners without a
--   device; they are marked the same way.
-- * Scores are stored per question and per topic, linked to learner, class and school.

-- ============ 1. Tables ============
create table if not exists public.tests (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  grade int not null check (grade in (11, 12)),
  syllabus text not null,
  form text not null check (form in ('A', 'B')),
  purpose text not null check (purpose in ('baseline', 'endline')),
  title text not null,
  minutes int not null default 75 check (minutes between 10 and 240),
  status text not null default 'draft' check (status in ('draft', 'approved')),
  approved_by uuid references public.profiles(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.test_items (
  id bigint generated always as identity primary key,
  test_id uuid not null references public.tests(id) on delete cascade,
  position int not null,
  topic text not null,
  sub_topic text,
  question text not null,
  kind text not null check (kind in ('choice', 'short')),
  options jsonb,
  answer text not null,
  accepted jsonb not null default '[]'::jsonb,
  marks int not null default 1 check (marks between 1 and 10),
  unique (test_id, position),
  check (kind = 'short' or (jsonb_typeof(options) = 'array' and jsonb_array_length(options) between 2 and 6))
);

create table if not exists public.test_windows (
  id bigint generated always as identity primary key,
  test_id uuid not null references public.tests(id) on delete cascade,
  school_id uuid not null references public.schools(id),
  opens_at timestamptz not null,
  closes_at timestamptz not null,
  set_by uuid references public.profiles(id) on delete set null,
  set_at timestamptz not null default now(),
  unique (test_id, school_id),
  check (closes_at > opens_at)
);

create table if not exists public.test_attempts (
  id bigint generated always as identity primary key,
  test_id uuid not null references public.tests(id) on delete cascade,
  learner_id uuid not null references public.profiles(id) on delete cascade,
  class_id uuid references public.classes(id) on delete set null,
  mode text not null check (mode in ('phone', 'paper')),
  started_at timestamptz not null default now(),
  submitted_at timestamptz,
  entered_by uuid references public.profiles(id) on delete set null,
  score int,
  max_score int,
  unique (test_id, learner_id)
);

create table if not exists public.test_responses (
  attempt_id bigint not null references public.test_attempts(id) on delete cascade,
  item_id bigint not null references public.test_items(id) on delete cascade,
  answer text,
  correct boolean not null default false,
  marks int not null default 0,
  answered_at timestamptz not null default now(),
  primary key (attempt_id, item_id)
);

alter table public.tests enable row level security;
alter table public.test_items enable row level security;
alter table public.test_windows enable row level security;
alter table public.test_attempts enable row level security;
alter table public.test_responses enable row level security;

-- ============ 2. Marking ============
-- Short answers are compared fairly: spaces, "x =" and common units are ignored
-- ("N$ 1 020", "1020" and "1,020" are the same), a decimal comma counts as a
-- point, and numbers are compared by value, so 2.5, 2.50 and 5/2 are all the
-- same. Rounded forms (such as 0.107 for 3/28) are listed on the question.
create or replace function public.pilot_norm_answer(p text) returns text
language plpgsql immutable as $$
declare
  s text := lower(coalesce(p, ''));
begin
  s := translate(s, '−–', '--');
  s := replace(replace(replace(s, ' ', ''), chr(160), ''), chr(9), '');
  s := regexp_replace(s, '^n\$', '');
  s := regexp_replace(s, '^[a-z]=', '');
  s := regexp_replace(s, '(n\$|°c|°|%|cm²|cm³|cm2|cm3|m/s²|m/s2|m/s|km/h|km|cm|mm|ml|kg|g|l|m|degrees|degree|seconds|s)$', '');
  if s ~ '^-?\d{1,3}(,\d{3})+(\.\d+)?$' then s := replace(s, ',', ''); else s := replace(s, ',', '.'); end if;
  return s;
end;
$$;

-- the value of a plain number or a fraction such as -3/4, or null
create or replace function public.pilot_answer_value(p text) returns numeric
language sql immutable as $$
  select case
    when p ~ '^-?\d+(\.\d+)?$' then p::numeric
    when p ~ '^-?\.\d+$' then replace(p, '.', '0.')::numeric
    when p ~ '^-?\d+(\.\d+)?/\d+(\.\d+)?$' and split_part(ltrim(p, '-'), '/', 2)::numeric <> 0
      then (case when p like '-%' then -1 else 1 end) * split_part(ltrim(p, '-'), '/', 1)::numeric / split_part(p, '/', 2)::numeric
  end;
$$;

create or replace function public.pilot_same_answer(p_given text, p_expected text) returns boolean
language sql immutable as $$
  select g <> '' and (g = e or (pilot_answer_value(g) is not null and abs(pilot_answer_value(g) - pilot_answer_value(e)) < 0.0000001))
    from (select pilot_norm_answer(p_given) g, pilot_norm_answer(p_expected) e) n;
$$;

create or replace function public.pilot_mark(p_item public.test_items, p_answer text) returns boolean
language sql immutable as $$
  select case
    when p_item.kind = 'choice' then upper(trim(coalesce(p_answer, ''))) = upper(p_item.answer)
    else pilot_same_answer(p_answer, p_item.answer)
      or exists (select 1 from jsonb_array_elements_text(p_item.accepted) a where pilot_same_answer(p_answer, a))
  end;
$$;

-- ============ 3. Helpers ============
-- the open window for a learner's school, if any
create or replace function public.pilot_window_for(p_test uuid, p_learner uuid) returns public.test_windows
language sql stable security definer set search_path = public as $$
  select w.* from test_windows w
    join pilot_participants pp on pp.school_id = w.school_id and pp.learner_id = p_learner
   where w.test_id = p_test
   limit 1;
$$;

-- Is the learner sitting a test right now? (used to stop the agent from helping)
create or replace function public.pilot_test_in_progress(p_learner uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from test_attempts a
      join test_windows w on w.test_id = a.test_id
      join pilot_participants pp on pp.learner_id = a.learner_id and pp.school_id = w.school_id
     where a.learner_id = p_learner and a.mode = 'phone' and a.submitted_at is null
       and now() >= w.opens_at and now() < w.closes_at);
$$;
revoke execute on function public.pilot_test_in_progress(uuid) from public, anon, authenticated;
grant execute on function public.pilot_test_in_progress(uuid) to service_role;

-- the signed-in learner's own check (the app and the agent ask this)
create or replace function public.pilot_my_test_lock() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and pilot_test_in_progress(auth.uid());
$$;

-- ============ 4. Learners ============
-- tests the learner can sit now (or has sat)
create or replace function public.pilot_my_tests()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  part record;
begin
  if me is null then raise exception 'Please log in first.'; end if;
  select * into part from pilot_participants where learner_id = me limit 1;
  if not found then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', t.id, 'title', t.title, 'purpose', t.purpose, 'minutes', t.minutes,
      'questions', (select count(*) from test_items i where i.test_id = t.id),
      'opens_at', w.opens_at, 'closes_at', w.closes_at,
      'open', now() >= w.opens_at and now() < w.closes_at,
      'status', case when a.submitted_at is not null then 'submitted'
                     when a.id is not null then 'in_progress' else 'not_started' end,
      'answered', (select count(*) from test_responses r where r.attempt_id = a.id and coalesce(r.answer, '') <> '')
    ) order by w.opens_at)
      from tests t
      join test_windows w on w.test_id = t.id and w.school_id = part.school_id
      left join test_attempts a on a.test_id = t.id and a.learner_id = me
     where t.status = 'approved' and t.grade = part.grade
       and (now() < w.closes_at or a.id is not null)), '[]'::jsonb);
end;
$$;

-- start (or continue) a test: returns the questions without answers, and saved answers
create or replace function public.pilot_start_test(p_test uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  t tests;
  w test_windows;
  a test_attempts;
  part record;
begin
  if me is null then raise exception 'Please log in first.'; end if;
  select * into part from pilot_participants where learner_id = me limit 1;
  if not found then raise exception 'Only learners taking part in the pilot can sit this test.'; end if;
  select * into t from tests where id = p_test;
  if not found or t.status <> 'approved' then raise exception 'This test is not available.'; end if;
  if t.grade <> part.grade then raise exception 'This test is for Grade % learners.', t.grade; end if;
  w := pilot_window_for(p_test, me);
  if w.id is null or now() < w.opens_at then raise exception 'This test is not open yet.'; end if;
  if now() >= w.closes_at then raise exception 'This test has closed.'; end if;
  select * into a from test_attempts where test_id = p_test and learner_id = me;
  if found and a.mode = 'paper' then raise exception 'Your teacher has entered your paper test, so it cannot be sat on the phone.'; end if;
  if found and a.submitted_at is not null then raise exception 'You have already submitted this test.'; end if;
  if not found then
    insert into test_attempts (test_id, learner_id, class_id, mode) values (p_test, me, part.class_id, 'phone') returning * into a;
  end if;
  return jsonb_build_object(
    'attempt_id', a.id, 'title', t.title, 'minutes', t.minutes, 'closes_at', w.closes_at, 'purpose', t.purpose,
    'items', (select jsonb_agg(jsonb_build_object('id', i.id, 'position', i.position, 'topic', i.topic,
                                                  'question', i.question, 'kind', i.kind, 'options', i.options) order by i.position)
                from test_items i where i.test_id = p_test),
    'saved', coalesce((select jsonb_object_agg(r.item_id::text, r.answer) from test_responses r where r.attempt_id = a.id), '{}'::jsonb));
end;
$$;

-- internal: store answers for an attempt and mark them
create or replace function public.pilot_store_answers(p_attempt bigint, p_answers jsonb)
returns int
language plpgsql security definer set search_path = public as $$
declare
  a test_attempts;
  k text;
  it test_items;
  ok boolean;
  n int := 0;
begin
  select * into a from test_attempts where id = p_attempt;
  if jsonb_typeof(coalesce(p_answers, '{}'::jsonb)) <> 'object' then raise exception 'Answers must be a list by question.'; end if;
  for k in select jsonb_object_keys(coalesce(p_answers, '{}'::jsonb)) loop
    select * into it from test_items where id = k::bigint and test_id = a.test_id;
    if not found then continue; end if;
    ok := pilot_mark(it, p_answers->>k);
    insert into test_responses (attempt_id, item_id, answer, correct, marks)
    values (p_attempt, it.id, left(p_answers->>k, 200), ok, case when ok then it.marks else 0 end)
    on conflict (attempt_id, item_id) do update
      set answer = excluded.answer, correct = excluded.correct, marks = excluded.marks, answered_at = now();
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke execute on function public.pilot_store_answers(bigint, jsonb) from public, anon, authenticated;

-- save answers while sitting the test (also used when a phone comes back online;
-- answers saved offline are accepted up to 2 hours after the window closes)
create or replace function public.pilot_save_answers(p_attempt bigint, p_answers jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  a test_attempts;
  w test_windows;
begin
  select * into a from test_attempts where id = p_attempt and learner_id = auth.uid();
  if not found then raise exception 'Test not found.'; end if;
  if a.submitted_at is not null then raise exception 'You have already submitted this test.'; end if;
  w := pilot_window_for(a.test_id, a.learner_id);
  if w.id is null or now() >= w.closes_at + interval '2 hours' then raise exception 'This test has closed.'; end if;
  return jsonb_build_object('saved', pilot_store_answers(p_attempt, p_answers));
end;
$$;

create or replace function public.pilot_submit_test(p_attempt bigint, p_answers jsonb default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  a test_attempts;
  w test_windows;
begin
  select * into a from test_attempts where id = p_attempt and learner_id = auth.uid();
  if not found then raise exception 'Test not found.'; end if;
  if a.submitted_at is not null then return jsonb_build_object('submitted', true); end if;
  w := pilot_window_for(a.test_id, a.learner_id);
  if w.id is null or now() >= w.closes_at + interval '2 hours' then raise exception 'This test has closed.'; end if;
  if p_answers is not null then perform pilot_store_answers(p_attempt, p_answers); end if;
  update test_attempts set submitted_at = now(),
         score = (select coalesce(sum(marks), 0) from test_responses where attempt_id = p_attempt),
         max_score = (select sum(marks) from test_items where test_id = a.test_id)
   where id = p_attempt;
  return jsonb_build_object('submitted', true);
end;
$$;

-- ============ 5. Teachers ============
-- tests for one class: window, and every learner's status and score
create or replace function public.pilot_class_tests(p_class uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  cls record;
begin
  if not (pilot_is_admin() or pilot_teaches(p_class)) then raise exception 'Only this class''s teachers can see its tests.'; end if;
  select c.*, s.id as sid into cls from classes c join schools s on s.id = c.school_id where c.id = p_class;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', t.id, 'title', t.title, 'purpose', t.purpose, 'questions', (select count(*) from test_items i where i.test_id = t.id),
      'opens_at', w.opens_at, 'closes_at', w.closes_at,
      'learners', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', pp.learner_id, 'name', p.username,
          'status', case when a.submitted_at is not null then 'submitted' when a.id is not null then 'in_progress' else 'not_started' end,
          'mode', a.mode, 'score', a.score, 'max', a.max_score,
          'answered', (select count(*) from test_responses r where r.attempt_id = a.id and coalesce(r.answer, '') <> '')
        ) order by p.username)
          from pilot_participants pp join profiles p on p.id = pp.learner_id
          left join test_attempts a on a.test_id = t.id and a.learner_id = pp.learner_id
         where pp.class_id = p_class), '[]'::jsonb),
      'topics', coalesce((
        select jsonb_agg(jsonb_build_object('topic', x.topic, 'correct', x.correct, 'answered', x.answered) order by x.topic)
          from (select i.topic, count(*) filter (where r.correct) as correct, count(*) as answered
                  from test_responses r join test_attempts a on a.id = r.attempt_id join test_items i on i.id = r.item_id
                  join pilot_participants pp on pp.learner_id = a.learner_id and pp.class_id = p_class
                 where a.test_id = t.id and a.submitted_at is not null group by i.topic) x), '[]'::jsonb)
    ) order by t.purpose desc, t.title)
      from tests t join test_windows w on w.test_id = t.id and w.school_id = cls.sid
     where t.status = 'approved' and t.grade = cls.grade), '[]'::jsonb);
end;
$$;

-- the paper version: questions without answers, for printing
create or replace function public.pilot_paper_version(p_test uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  t tests;
begin
  select * into t from tests where id = p_test;
  if not found then raise exception 'Test not found.'; end if;
  if not (pilot_is_admin() or (t.status = 'approved' and exists (
            select 1 from class_teachers ct join classes c on c.id = ct.class_id
              join test_windows w on w.school_id = c.school_id and w.test_id = t.id
             where ct.teacher_id = auth.uid() and c.grade = t.grade))) then
    raise exception 'Only teachers of a class sitting this test can print it.';
  end if;
  return jsonb_build_object('title', t.title, 'minutes', t.minutes,
    'items', (select jsonb_agg(jsonb_build_object('id', i.id, 'position', i.position, 'topic', i.topic, 'question', i.question,
                                                  'kind', i.kind, 'options', i.options) order by i.position)
                from test_items i where i.test_id = p_test));
end;
$$;

-- a teacher enters the answers a learner wrote on paper; they are marked the same way
create or replace function public.pilot_enter_paper(p_test uuid, p_learner uuid, p_answers jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  part record;
  t tests;
  w test_windows;
  a test_attempts;
begin
  select * into part from pilot_participants where learner_id = p_learner limit 1;
  if not found then raise exception 'This learner does not take part in the pilot.'; end if;
  if not (pilot_is_admin() or pilot_teaches(part.class_id)) then raise exception 'Only this learner''s teachers can enter paper answers.'; end if;
  select * into t from tests where id = p_test;
  if not found or t.status <> 'approved' or t.grade <> part.grade then raise exception 'This test is not for this learner.'; end if;
  w := pilot_window_for(p_test, p_learner);
  if w.id is null or now() < w.opens_at then raise exception 'The test window has not opened yet.'; end if;
  if now() >= w.closes_at + interval '14 days' then raise exception 'Paper answers can be entered until 14 days after the window closes.'; end if;
  select * into a from test_attempts where test_id = p_test and learner_id = p_learner;
  if found and a.mode = 'phone' then raise exception 'This learner has sat the test on a phone.'; end if;
  if not found then
    insert into test_attempts (test_id, learner_id, class_id, mode, entered_by) values (p_test, p_learner, part.class_id, 'paper', auth.uid()) returning * into a;
  end if;
  perform pilot_store_answers(a.id, p_answers);
  update test_attempts set submitted_at = coalesce(submitted_at, now()), entered_by = auth.uid(),
         score = (select coalesce(sum(marks), 0) from test_responses where attempt_id = a.id),
         max_score = (select sum(marks) from test_items where test_id = p_test)
   where id = a.id;
  return jsonb_build_object('ok', true, 'score', (select score from test_attempts where id = a.id),
                            'max', (select max_score from test_attempts where id = a.id));
end;
$$;

-- ============ 6. Administrators ============
create or replace function public.pilot_tests_admin()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not pilot_is_admin() then raise exception 'Only K-12 EdTech administrators can manage tests.'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', t.id, 'code', t.code, 'title', t.title, 'grade', t.grade, 'form', t.form, 'purpose', t.purpose, 'minutes', t.minutes,
      'status', t.status, 'approved_at', t.approved_at,
      'questions', (select count(*) from test_items i where i.test_id = t.id),
      'topics', (select count(distinct topic) from test_items i where i.test_id = t.id),
      'windows', (select count(*) from test_windows w where w.test_id = t.id),
      'open_now', (select count(*) from test_windows w where w.test_id = t.id and now() >= w.opens_at and now() < w.closes_at),
      'submitted', (select count(*) from test_attempts a where a.test_id = t.id and a.submitted_at is not null)
    ) order by t.grade, t.form)
      from tests t), '[]'::jsonb);
end;
$$;

-- full preview with answers, for review by K-12 EdTech, teachers and the evaluator
create or replace function public.pilot_test_preview(p_test uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not pilot_is_admin() then raise exception 'Only K-12 EdTech administrators can see the answers.'; end if;
  return (select jsonb_agg(jsonb_build_object('position', i.position, 'topic', i.topic, 'sub_topic', i.sub_topic,
                                              'question', i.question, 'kind', i.kind, 'options', i.options,
                                              'answer', i.answer, 'accepted', i.accepted, 'marks', i.marks) order by i.position)
            from test_items i where i.test_id = p_test);
end;
$$;

create or replace function public.pilot_approve_test(p_test uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not pilot_is_admin() then raise exception 'Only K-12 EdTech administrators can approve tests.'; end if;
  if not exists (select 1 from test_items where test_id = p_test) then raise exception 'This test has no questions yet.'; end if;
  update tests set status = 'approved', approved_by = auth.uid(), approved_at = now() where id = p_test and status = 'draft';
  return jsonb_build_object('ok', true);
end;
$$;

-- open a window for one school, or for every pilot school (p_school null)
create or replace function public.pilot_set_test_window(p_test uuid, p_school uuid, p_opens timestamptz, p_closes timestamptz)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t tests;
  n int;
begin
  if not pilot_is_admin() then raise exception 'Only K-12 EdTech administrators can open test windows.'; end if;
  select * into t from tests where id = p_test;
  if not found then raise exception 'Test not found.'; end if;
  if t.status <> 'approved' then raise exception 'Approve the test before opening a window.'; end if;
  if p_closes <= p_opens then raise exception 'The window must close after it opens.'; end if;
  insert into test_windows (test_id, school_id, opens_at, closes_at, set_by)
  select p_test, s.id, p_opens, p_closes, auth.uid() from schools s
   where s.in_pilot and (p_school is null or s.id = p_school)
  on conflict (test_id, school_id) do update set opens_at = excluded.opens_at, closes_at = excluded.closes_at, set_by = excluded.set_by, set_at = now();
  get diagnostics n = row_count;
  if n = 0 then raise exception 'No pilot school found.'; end if;
  return jsonb_build_object('ok', true, 'schools', n);
end;
$$;

-- every score in one place: pseudonymous ID, region, school, setting, class, how it was sat, score and topics
create or replace function public.pilot_test_scores(p_test uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not pilot_is_admin() then raise exception 'Only K-12 EdTech administrators can see all scores.'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'pseudo_id', pp.pseudo_id, 'region', r.name, 'school', s.name, 'setting', s.setting, 'class', c.name,
      'mode', a.mode, 'score', a.score, 'max', a.max_score, 'submitted_at', a.submitted_at,
      'topics', (select jsonb_object_agg(x.topic, x.correct || '/' || x.n)
                   from (select i.topic, count(*) filter (where r2.correct) correct, count(*) n
                           from test_items i left join test_responses r2 on r2.item_id = i.id and r2.attempt_id = a.id
                          where i.test_id = a.test_id group by i.topic) x)
    ) order by r.name, s.name, c.name, pp.pseudo_id)
      from test_attempts a
      join pilot_participants pp on pp.learner_id = a.learner_id
      join classes c on c.id = pp.class_id join schools s on s.id = c.school_id left join regions r on r.id = s.region_id
     where a.test_id = p_test and a.submitted_at is not null), '[]'::jsonb);
end;
$$;

-- ============ 7. Withdrawal removes test answers too ============
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
  delete from test_attempts where learner_id = lid;
  update teacher_summaries
     set data = jsonb_set(data, '{not_active}', coalesce((select jsonb_agg(x) from jsonb_array_elements(data->'not_active') x
                                                           where x <> to_jsonb(lid::text)), '[]'::jsonb))
   where data->'not_active' ? lid::text;
  -- (later pilot items add their tables here)
  update data_removals set status = 'done', done_at = now(), done_by = auth.uid() where id = p_removal;
  return jsonb_build_object('ok', true);
end;
$$;

-- ============ 8. Who may call what ============
do $$
declare f text;
begin
  foreach f in array array[
    'pilot_my_test_lock()', 'pilot_my_tests()', 'pilot_start_test(uuid)', 'pilot_save_answers(bigint, jsonb)',
    'pilot_submit_test(bigint, jsonb)', 'pilot_class_tests(uuid)', 'pilot_paper_version(uuid)',
    'pilot_enter_paper(uuid, uuid, jsonb)', 'pilot_tests_admin()', 'pilot_test_preview(uuid)',
    'pilot_approve_test(uuid)', 'pilot_set_test_window(uuid, uuid, timestamptz, timestamptz)', 'pilot_test_scores(uuid)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke execute on function public.pilot_window_for(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.pilot_mark(public.test_items, text) from public, anon, authenticated;

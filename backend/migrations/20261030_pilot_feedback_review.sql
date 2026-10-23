-- K12Plus pilot, item 9: teachers review a sample of the agent's feedback each month
-- 30 October 2026
--
-- Additive only: new tables agent_exchanges, review_batches and review_items, new
-- pilot_* functions and a monthly scheduled job. No existing data is changed.
--
-- * For learners taking part in the pilot (with consent), the agent function keeps
--   each question and the agent's reply (chat, photo questions and Real-Life Lab
--   stories). Nothing is kept for anyone else. The learner's name is never stored
--   with it, and photos are not kept.
-- * On the 1st of every month at 06:30 Namibian time, each pilot teacher gets 10
--   replies picked at random from last month's replies to the learners in their
--   classes (fewer if there were fewer).
-- * The teacher marks each one correct, incorrect or unsuitable, with an optional
--   comment. The time taken is recorded.
-- * K-12 EdTech sees all results in one place, and can download them.

-- ============ 1. The agent's replies to pilot learners ============
create table if not exists public.agent_exchanges (
  id bigint generated always as identity primary key,
  learner_id uuid not null references public.profiles(id) on delete cascade,
  class_id uuid references public.classes(id) on delete set null,
  kind text not null check (kind in ('chat', 'photo', 'real_life')),
  subject text,
  topic text,
  question text not null,
  reply text not null,
  model text,
  created_at timestamptz not null default now()
);
create index if not exists agent_exchanges_learner_idx on public.agent_exchanges (learner_id, created_at desc);
create index if not exists agent_exchanges_class_idx on public.agent_exchanges (class_id, created_at desc);
alter table public.agent_exchanges enable row level security;

-- what the agent needs to know about the signed-in learner: sitting a test? taking part?
create or replace function public.pilot_agent_context()
returns jsonb
language sql stable security definer set search_path = public as $$
  select case when auth.uid() is null then jsonb_build_object('locked', false, 'taking_part', false)
              else jsonb_build_object('locked', pilot_test_in_progress(auth.uid()),
                                      'taking_part', pilot_active(auth.uid()),
                                      'learner_id', auth.uid()) end;
$$;

-- called by the agent function only (service role); stores nothing without consent
create or replace function public.pilot_save_exchange(p jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  lid uuid;
  cls uuid;
  k text := coalesce(p->>'kind', 'chat');
begin
  begin
    lid := (p->>'learner_id')::uuid;
  exception when others then
    return jsonb_build_object('stored', false);
  end;
  if lid is null or not pilot_active(lid) then return jsonb_build_object('stored', false); end if;
  if k not in ('chat', 'photo', 'real_life') then k := 'chat'; end if;
  if length(trim(coalesce(p->>'question', ''))) = 0 or length(trim(coalesce(p->>'reply', ''))) = 0 then
    return jsonb_build_object('stored', false);
  end if;
  select pp.class_id into cls from pilot_participants pp where pp.learner_id = lid limit 1;
  insert into agent_exchanges (learner_id, class_id, kind, subject, topic, question, reply, model)
  values (lid, cls, k, left(nullif(trim(coalesce(p->>'subject', '')), ''), 60), left(nullif(trim(coalesce(p->>'topic', '')), ''), 120),
          left(p->>'question', 1000), left(p->>'reply', 4000), left(p->>'model', 60));
  return jsonb_build_object('stored', true);
end;
$$;
revoke execute on function public.pilot_save_exchange(jsonb) from public, anon, authenticated;
grant execute on function public.pilot_save_exchange(jsonb) to service_role;

-- ============ 2. Monthly samples ============
create table if not exists public.review_batches (
  id bigint generated always as identity primary key,
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  month date not null check (extract(day from month) = 1),  -- the month the replies come from
  created_at timestamptz not null default now(),
  opened_at timestamptz,
  completed_at timestamptz,
  unique (teacher_id, month)
);
alter table public.review_batches enable row level security;

create table if not exists public.review_items (
  id bigint generated always as identity primary key,
  batch_id bigint not null references public.review_batches(id) on delete cascade,
  exchange_id bigint not null references public.agent_exchanges(id) on delete cascade,
  position int not null,
  verdict text check (verdict in ('correct', 'incorrect', 'unsuitable')),
  comment text,
  answered_at timestamptz,
  seconds int,
  unique (batch_id, position),
  unique (batch_id, exchange_id)
);
alter table public.review_items enable row level security;

-- Picks up to p_size replies at random for every pilot teacher from p_month
-- (default: last month). Safe to run more than once: one sample per teacher a month.
create or replace function public.pilot_prepare_reviews(p_month date default null, p_size int default 10, p_now timestamptz default now())
returns int
language plpgsql volatile security definer set search_path = public as $$
declare
  tz text := coalesce((select time_zone from messaging_rules where id = 1), 'Africa/Windhoek');
  m0 date := coalesce(date_trunc('month', p_month)::date, (date_trunc('month', p_now at time zone tz) - interval '1 month')::date);
  t0 timestamptz := (m0::timestamp) at time zone tz;
  t1 timestamptz := ((m0 + interval '1 month')::timestamp) at time zone tz;
  t record;
  b bigint;
  made int := 0;
begin
  if p_size not between 1 and 20 then raise exception 'A sample has between 1 and 20 replies.'; end if;
  for t in select distinct ct.teacher_id from class_teachers ct join classes c on c.id = ct.class_id where c.pilot loop
    if exists (select 1 from review_batches where teacher_id = t.teacher_id and month = m0) then continue; end if;
    if not exists (select 1 from agent_exchanges x
                     join pilot_participants pp on pp.learner_id = x.learner_id
                     join class_teachers ct on ct.class_id = pp.class_id and ct.teacher_id = t.teacher_id
                    where x.created_at >= t0 and x.created_at < t1) then continue; end if;
    insert into review_batches (teacher_id, month, created_at) values (t.teacher_id, m0, p_now) returning id into b;
    insert into review_items (batch_id, exchange_id, position)
    select b, s.id, row_number() over (order by s.r)
      from (select distinct on (x.id) x.id, random() as r
              from agent_exchanges x
              join pilot_participants pp on pp.learner_id = x.learner_id
              join class_teachers ct on ct.class_id = pp.class_id and ct.teacher_id = t.teacher_id
             where x.created_at >= t0 and x.created_at < t1) s
     order by s.r limit p_size;
    made := made + 1;
  end loop;
  return made;
end;
$$;
revoke execute on function public.pilot_prepare_reviews(date, int, timestamptz) from public, anon, authenticated;
grant execute on function public.pilot_prepare_reviews(date, int, timestamptz) to service_role;

-- administrators can prepare a month's samples by hand (for example to try it out)
create or replace function public.pilot_prepare_reviews_now(p_month date)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not pilot_is_admin() then raise exception 'Only K-12 EdTech administrators can prepare reviews.'; end if;
  return jsonb_build_object('teachers', pilot_prepare_reviews(p_month));
end;
$$;

-- ============ 3. The teacher's review ============
-- the teacher's open sample (or the latest one), without learners' names
create or replace function public.pilot_my_review()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  b review_batches;
begin
  if auth.uid() is null then raise exception 'Please log in first.'; end if;
  select * into b from review_batches where teacher_id = auth.uid()
   order by (completed_at is null) desc, month desc limit 1;
  if not found then return null; end if;
  return jsonb_build_object(
    'id', b.id, 'month', b.month, 'opened_at', b.opened_at, 'completed_at', b.completed_at,
    'minutes', case when b.completed_at is not null then round(extract(epoch from b.completed_at - b.opened_at) / 60.0, 1) end,
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'id', i.id, 'position', i.position, 'kind', x.kind, 'subject', x.subject, 'topic', x.topic,
        'grade', c.grade, 'asked_at', x.created_at, 'question', x.question, 'reply', x.reply,
        'verdict', i.verdict, 'comment', i.comment) order by i.position)
      from review_items i join agent_exchanges x on x.id = i.exchange_id left join classes c on c.id = x.class_id
     where i.batch_id = b.id), '[]'::jsonb));
end;
$$;

create or replace function public.pilot_start_review(p_batch bigint)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  update review_batches set opened_at = coalesce(opened_at, now()) where id = p_batch and teacher_id = auth.uid();
  if not found then raise exception 'This review is not yours.'; end if;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.pilot_review_item(p_item bigint, p_verdict text, p_comment text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  it review_items;
  b review_batches;
  prev timestamptz;
  left_n int;
begin
  select i.* into it from review_items i join review_batches rb on rb.id = i.batch_id
   where i.id = p_item and rb.teacher_id = auth.uid();
  if not found then raise exception 'This review is not yours.'; end if;
  if p_verdict not in ('correct', 'incorrect', 'unsuitable') then raise exception 'Choose correct, incorrect or unsuitable.'; end if;
  update review_batches set opened_at = coalesce(opened_at, now()) where id = it.batch_id returning * into b;
  -- time on this reply: since the previous answer, or since the review was opened
  select coalesce(max(answered_at), b.opened_at) into prev from review_items where batch_id = it.batch_id and id <> it.id and answered_at is not null;
  update review_items
     set verdict = p_verdict, comment = left(nullif(trim(coalesce(p_comment, '')), ''), 500),
         seconds = coalesce(seconds, greatest(0, least(3600, extract(epoch from now() - prev)::int))),
         answered_at = coalesce(answered_at, now())
   where id = p_item;
  select count(*) into left_n from review_items where batch_id = it.batch_id and verdict is null;
  if left_n = 0 then update review_batches set completed_at = coalesce(completed_at, now()) where id = it.batch_id; end if;
  return jsonb_build_object('ok', true, 'left', left_n);
end;
$$;

-- ============ 4. Results for the product team ============
create or replace function public.pilot_review_results(p_month date)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  m0 date := date_trunc('month', p_month)::date;
begin
  if not pilot_is_admin() then raise exception 'Only K-12 EdTech administrators can see the review results.'; end if;
  return jsonb_build_object(
    'month', m0,
    'teachers', coalesce((select jsonb_agg(jsonb_build_object(
        'teacher', p.username,
        'school', (select s.name from class_teachers ct join classes c on c.id = ct.class_id join schools s on s.id = c.school_id
                    where ct.teacher_id = b.teacher_id and c.pilot limit 1),
        'items', (select count(*) from review_items i where i.batch_id = b.id),
        'done', (select count(*) from review_items i where i.batch_id = b.id and i.verdict is not null),
        'minutes', case when b.completed_at is not null then round(extract(epoch from b.completed_at - b.opened_at) / 60.0, 1) end,
        'completed_at', b.completed_at) order by p.username)
      from review_batches b join profiles p on p.id = b.teacher_id where b.month = m0), '[]'::jsonb),
    'counts', (select jsonb_build_object(
        'correct', count(*) filter (where i.verdict = 'correct'),
        'incorrect', count(*) filter (where i.verdict = 'incorrect'),
        'unsuitable', count(*) filter (where i.verdict = 'unsuitable'),
        'waiting', count(*) filter (where i.verdict is null))
      from review_items i join review_batches b on b.id = i.batch_id where b.month = m0),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'id', i.id, 'verdict', i.verdict, 'comment', i.comment, 'seconds', i.seconds,
        'kind', x.kind, 'subject', x.subject, 'topic', x.topic, 'grade', c.grade, 'model', x.model,
        'question', x.question, 'reply', x.reply, 'asked_at', x.created_at, 'teacher', p.username, 'school', s.name)
        order by case i.verdict when 'unsuitable' then 0 when 'incorrect' then 1 when 'correct' then 2 else 3 end, i.answered_at desc)
      from review_items i join review_batches b on b.id = i.batch_id join profiles p on p.id = b.teacher_id
      join agent_exchanges x on x.id = i.exchange_id left join classes c on c.id = x.class_id left join schools s on s.id = c.school_id
     where b.month = m0 and i.verdict is not null), '[]'::jsonb));
end;
$$;

-- ============ 5. Withdrawal removes the learner's questions and replies too ============
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
  delete from cost_alerts where learner_id = lid;
  delete from agent_exchanges where learner_id = lid; -- their review items go with them
  update teacher_summaries
     set data = jsonb_set(data, '{not_active}', coalesce((select jsonb_agg(x) from jsonb_array_elements(data->'not_active') x
                                                           where x <> to_jsonb(lid::text)), '[]'::jsonb))
   where data->'not_active' ? lid::text;
  -- (later pilot items add their tables here)
  update data_removals set status = 'done', done_at = now(), done_by = auth.uid() where id = p_removal;
  return jsonb_build_object('ok', true);
end;
$$;

-- ============ 6. Who may call what, and the monthly job ============
do $$
declare f text;
begin
  foreach f in array array['pilot_agent_context()', 'pilot_prepare_reviews_now(date)', 'pilot_my_review()',
                           'pilot_start_review(bigint)', 'pilot_review_item(bigint, text, text)', 'pilot_review_results(date)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.unschedule(jobid) from cron.job where jobname = 'k12plus-monthly-feedback-review';
    perform cron.schedule('k12plus-monthly-feedback-review', '30 4 1 * *', 'select public.pilot_prepare_reviews()');
  end if;
end $$;

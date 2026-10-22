-- K12Plus pilot, item 7: safety rules on every message, and the message log
-- 25 October 2026
--
-- Additive only: new tables messaging_rules, agent_pauses, message_log and
-- learner_messages, and new pilot_* functions. No existing data is changed.
--
-- Every message the agents send to a learner goes through pilot_log_message(),
-- which checks, in this order:
--   1. consent      the learner takes part in the pilot (item 2)
--   2. pause        no teacher has paused the agent for this learner
--   3. hours        it is inside the allowed hours (Namibian time)
--   4. weekly       the learner has not reached the weekly message limit
--   5. text limit   for text messages, the weekly text message limit
--   6. content      the content check (done by the agent-messenger Edge Function) passed
-- The message is logged whatever the result, with every check.

-- ============ 1. Rules (one row, changed only by administrators) ============
create table if not exists public.messaging_rules (
  id int primary key default 1 check (id = 1),
  time_zone text not null default 'Africa/Windhoek',
  weekday_start time not null default '15:00',
  weekday_end time not null default '19:30',
  weekend_start time not null default '09:00',
  weekend_end time not null default '18:00',
  weekly_limit int not null default 3 check (weekly_limit between 0 and 14),
  weekly_sms_limit int not null default 2 check (weekly_sms_limit between 0 and 14),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  check (weekday_start < weekday_end and weekend_start < weekend_end),
  check (weekly_sms_limit <= weekly_limit)
);
insert into public.messaging_rules (id) values (1) on conflict (id) do nothing;
alter table public.messaging_rules enable row level security;

-- ============ 2. Teacher pause (screens come in item 5) ============
create table if not exists public.agent_pauses (
  id bigint generated always as identity primary key,
  learner_id uuid not null references public.profiles(id) on delete cascade,
  paused_by uuid references public.profiles(id) on delete set null,
  paused_at timestamptz not null default now(),
  reason text,
  resumed_by uuid references public.profiles(id) on delete set null,
  resumed_at timestamptz
);
create unique index if not exists agent_pauses_open_idx on public.agent_pauses (learner_id) where resumed_at is null;
alter table public.agent_pauses enable row level security;

-- ============ 3. Message log and in-app inbox ============
create table if not exists public.message_log (
  id bigint generated always as identity primary key,
  recipient_kind text not null check (recipient_kind in ('learner', 'teacher')),
  learner_id uuid references public.profiles(id) on delete cascade,
  teacher_id uuid references public.profiles(id) on delete cascade,
  channel text not null check (channel in ('in_app', 'push', 'sms', 'email')),
  purpose text not null check (purpose in ('follow_up', 'monday_summary', 'consent_request', 'test')),
  body text not null,
  -- approved = passed every rule, waiting for the text message or email provider
  status text not null check (status in ('sent', 'approved', 'blocked', 'failed')),
  block_reason text,
  checks jsonb not null default '{}'::jsonb,
  provider_ref text,
  cost_usd numeric(8, 4),
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  check ((recipient_kind = 'learner' and learner_id is not null) or (recipient_kind = 'teacher' and teacher_id is not null))
);
create index if not exists message_log_learner_idx on public.message_log (learner_id, created_at desc);
create index if not exists message_log_status_idx on public.message_log (status, created_at desc);
alter table public.message_log enable row level security;

create table if not exists public.learner_messages (
  id bigint generated always as identity primary key,
  learner_id uuid not null references public.profiles(id) on delete cascade,
  message_log_id bigint references public.message_log(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists learner_messages_learner_idx on public.learner_messages (learner_id, created_at desc);
alter table public.learner_messages enable row level security;

-- ============ 4. The gate ============
create or replace function public.pilot_is_paused(p_learner uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from agent_pauses where learner_id = p_learner and resumed_at is null);
$$;
revoke execute on function public.pilot_is_paused(uuid) from public, anon, authenticated;
grant execute on function public.pilot_is_paused(uuid) to service_role;

-- p: {recipient_kind, learner_id | teacher_id, channel, purpose, body, content_ok, content_reason}
-- p_now is only for tests; the Edge Function never passes it.
create or replace function public.pilot_log_message(p jsonb, p_now timestamptz default now())
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  r messaging_rules;
  kind text := coalesce(p->>'recipient_kind', 'learner');
  lid uuid := (p->>'learner_id')::uuid;
  tid uuid := (p->>'teacher_id')::uuid;
  ch text := p->>'channel';
  local_ts timestamp;
  week_start timestamp;
  dow int;
  t time;
  n_week int := 0;
  n_sms int := 0;
  c_consent boolean := true;
  c_pause boolean := true;
  c_hours boolean := true;
  c_weekly boolean := true;
  c_sms boolean := true;
  c_content boolean := coalesce((p->>'content_ok')::boolean, false);
  reason text;
  st text;
  log_id bigint;
begin
  select * into r from messaging_rules where id = 1;
  if length(coalesce(p->>'body', '')) = 0 then raise exception 'Empty message.'; end if;

  if kind = 'learner' then
    -- one message decision at a time per learner, so the weekly limit cannot be overrun
    perform pg_advisory_xact_lock(hashtext('k12msg:' || lid::text));
    local_ts := p_now at time zone r.time_zone;
    dow := extract(isodow from local_ts);
    t := local_ts::time;
    week_start := date_trunc('week', local_ts);
    select count(*), count(*) filter (where channel = 'sms') into n_week, n_sms
      from message_log
     where learner_id = lid and recipient_kind = 'learner'
       and status in ('sent', 'approved')
       and (created_at at time zone r.time_zone) >= week_start;
    c_consent := pilot_active(lid);
    c_pause := not pilot_is_paused(lid);
    c_hours := case when dow <= 5 then t >= r.weekday_start and t <= r.weekday_end
                    else t >= r.weekend_start and t <= r.weekend_end end;
    c_weekly := n_week < r.weekly_limit;
    c_sms := ch <> 'sms' or n_sms < r.weekly_sms_limit;
  end if;

  reason := case
    when not c_consent then 'no_consent'
    when not c_pause then 'paused'
    when not c_hours then 'outside_hours'
    when not c_weekly then 'weekly_limit'
    when not c_sms then 'weekly_sms_limit'
    when not c_content then 'content'
  end;
  st := case when reason is not null then 'blocked'
             when ch in ('in_app', 'push') then 'sent'
             else 'approved' end;

  insert into message_log (recipient_kind, learner_id, teacher_id, channel, purpose, body, status, block_reason, checks, created_at, delivered_at)
  values (kind, lid, tid, ch, p->>'purpose', left(p->>'body', 2000), st, reason,
          jsonb_build_object('consent', c_consent, 'pause', c_pause, 'hours', c_hours, 'weekly', c_weekly,
                             'weekly_sms', c_sms, 'content', c_content, 'content_reason', p->>'content_reason',
                             'sent_this_week', n_week, 'local_time', to_char(local_ts, 'Dy HH24:MI')),
          p_now, case when st = 'sent' then p_now end)
  returning id into log_id;

  if st = 'sent' and kind = 'learner' then
    insert into learner_messages (learner_id, message_log_id, body, created_at) values (lid, log_id, left(p->>'body', 2000), p_now);
  end if;
  return jsonb_build_object('id', log_id, 'status', st, 'reason', reason);
end;
$$;
revoke execute on function public.pilot_log_message(jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.pilot_log_message(jsonb, timestamptz) to service_role;

-- after a text message or email provider answers
create or replace function public.pilot_mark_delivery(p_id bigint, p_ok boolean, p_provider_ref text, p_cost numeric)
returns void
language sql volatile security definer set search_path = public as $$
  update message_log
     set status = case when p_ok then 'sent' else 'failed' end,
         block_reason = case when p_ok then null else coalesce(block_reason, 'delivery_failed') end,
         provider_ref = p_provider_ref, cost_usd = p_cost,
         delivered_at = case when p_ok then now() end
   where id = p_id and status = 'approved';
$$;
revoke execute on function public.pilot_mark_delivery(bigint, boolean, text, numeric) from public, anon, authenticated;
grant execute on function public.pilot_mark_delivery(bigint, boolean, text, numeric) to service_role;

-- ============ 5. Administrators: rules and review ============
create or replace function public.pilot_messaging_rules()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not pilot_is_admin() then raise exception 'Only K-12 EdTech administrators can see the messaging rules.'; end if;
  return (select jsonb_build_object('weekday_start', to_char(weekday_start, 'HH24:MI'), 'weekday_end', to_char(weekday_end, 'HH24:MI'),
                                    'weekend_start', to_char(weekend_start, 'HH24:MI'), 'weekend_end', to_char(weekend_end, 'HH24:MI'),
                                    'weekly_limit', weekly_limit, 'weekly_sms_limit', weekly_sms_limit, 'time_zone', time_zone,
                                    'updated_at', updated_at)
            from messaging_rules where id = 1);
end;
$$;

create or replace function public.pilot_set_messaging_rules(p jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not pilot_is_admin() then raise exception 'Only K-12 EdTech administrators can change the messaging rules.'; end if;
  begin
    update messaging_rules set
      weekday_start = coalesce((p->>'weekday_start')::time, weekday_start),
      weekday_end = coalesce((p->>'weekday_end')::time, weekday_end),
      weekend_start = coalesce((p->>'weekend_start')::time, weekend_start),
      weekend_end = coalesce((p->>'weekend_end')::time, weekend_end),
      weekly_limit = coalesce((p->>'weekly_limit')::int, weekly_limit),
      weekly_sms_limit = coalesce((p->>'weekly_sms_limit')::int, weekly_sms_limit),
      updated_by = auth.uid(), updated_at = now()
    where id = 1;
  exception when check_violation or invalid_datetime_format or invalid_text_representation or datetime_field_overflow then
    raise exception 'Check the times and limits: each start must be before its end, limits must be between 0 and 14, and the text message limit cannot be higher than the weekly limit.';
  end;
  return pilot_messaging_rules();
end;
$$;

-- counts for the last p_days days
create or replace function public.pilot_message_stats(p_days int default 7)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not pilot_is_admin() then raise exception 'Only K-12 EdTech administrators can see the message log.'; end if;
  return jsonb_build_object(
    'days', p_days,
    'total', (select count(*) from message_log where created_at > now() - make_interval(days => p_days)),
    'by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from message_log
                    where created_at > now() - make_interval(days => p_days) group by status) x), '{}'::jsonb),
    'blocked_by', coalesce((select jsonb_object_agg(block_reason, n) from (select block_reason, count(*) n from message_log
                    where status = 'blocked' and created_at > now() - make_interval(days => p_days) group by block_reason) x), '{}'::jsonb)
  );
end;
$$;

-- a random sample of logged messages (or the latest, filtered by status), learners shown by pseudonymous ID
create or replace function public.pilot_message_sample(p_size int default 20, p_status text default null, p_random boolean default true)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not pilot_is_admin() then raise exception 'Only K-12 EdTech administrators can see the message log.'; end if;
  return coalesce((
    select jsonb_agg(j) from (
      select jsonb_build_object(
        'id', m.id, 'recipient', m.recipient_kind,
        'who', case when m.recipient_kind = 'learner'
                    then coalesce((select e.pseudo_id from enrolments e where e.learner_id = m.learner_id order by e.enrolled_at desc limit 1), 'not enrolled')
                    else 'teacher' end,
        'channel', m.channel, 'purpose', m.purpose, 'status', m.status, 'reason', m.block_reason,
        'body', m.body, 'checks', m.checks, 'created_at', m.created_at) as j
      from message_log m
      where p_status is null or m.status = p_status
      order by case when p_random then random() else 0 end, m.created_at desc
      limit greatest(1, least(coalesce(p_size, 20), 100))
    ) s), '[]'::jsonb);
end;
$$;

-- ============ 6. Learners: their in-app messages ============
create or replace function public.pilot_my_messages()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Please log in first.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'body', body, 'at', created_at, 'read', read_at is not null) order by created_at desc)
                     from (select * from learner_messages where learner_id = auth.uid() order by created_at desc limit 20) m), '[]'::jsonb);
end;
$$;

create or replace function public.pilot_mark_messages_read()
returns void
language sql volatile security definer set search_path = public as $$
  update learner_messages set read_at = now() where learner_id = auth.uid() and read_at is null;
$$;

-- ============ 7. Withdrawal also removes messages ============
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
    'pilot_messaging_rules()', 'pilot_set_messaging_rules(jsonb)', 'pilot_message_stats(int)',
    'pilot_message_sample(int, text, boolean)', 'pilot_my_messages()', 'pilot_mark_messages_read()']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

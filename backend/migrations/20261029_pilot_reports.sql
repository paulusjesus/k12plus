-- K12Plus pilot, item 8: usage and data-cost reports
-- 29 October 2026
--
-- Additive: no existing data is changed or removed.
--   * learning_events gets a new column, bytes, and a new kind of record, 'data'
--     (how much data the app used on the learner's phone). Existing rows are untouched.
--   * New tables: cost_settings (prices and the budget), cost_entries (costs typed in
--     by K-12 EdTech, such as data bundles bought for a school) and cost_alerts.
--   * New pilot_* functions and a daily scheduled check at 06:15 Namibian time.
--
-- Reports cover learners who take part in the pilot (enrolled, with school and
-- parent or guardian consent) and nobody else. They use pilot IDs, never names,
-- phone numbers or K12Plus IDs.
--
-- Figures for any period (a week, a month): learners taking part, active learners,
-- sessions (a new session starts after 30 minutes without activity), minutes of
-- use, questions asked, practice answers, topics practised, USSD sessions, data
-- used, text messages, and the cost of each, per learner, class, school, region
-- and setting (rural or urban), plus the whole pilot.
--
-- Cost per learner = (data used x price per GB + USSD sessions x price + text
-- messages sent + costs typed in for the school) / learners taking part.
-- The budget is US$2.50 per learner per month (changeable). The daily check
-- raises an alert when a school, a learner or the whole pilot is spending
-- ahead of the budget for the month so far.

-- ============ 1. The learning record also holds data use ============
alter table public.learning_events add column if not exists bytes bigint check (bytes between 0 and 100000000);
alter table public.learning_events drop constraint if exists learning_events_kind_check;
alter table public.learning_events add constraint learning_events_kind_check
  check (kind in ('question', 'quiz', 'game', 'practice', 'lesson', 'active', 'ussd', 'data'));

-- same as before, plus 'data' records (bytes used on the phone, at most 50 MB in one record)
create or replace function public.pilot_record_events(p_events jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  cls uuid;
  e jsonb;
  n int := 0;
  at_ts timestamptz;
  k text;
  b bigint;
begin
  if me is null then raise exception 'Please log in first.'; end if;
  if not pilot_active(me) then return jsonb_build_object('stored', 0, 'taking_part', false); end if;
  if jsonb_typeof(p_events) <> 'array' then raise exception 'Expected a list of records.'; end if;
  select pp.class_id into cls from pilot_participants pp where pp.learner_id = me limit 1;
  for e in select * from jsonb_array_elements(p_events) limit 100 loop
    begin
      at_ts := (e->>'occurred_at')::timestamptz;
      b := (e->>'bytes')::bigint;
    exception when others then
      continue;
    end;
    -- ignore records from the future or more than 30 days old
    if at_ts is null or at_ts > now() + interval '10 minutes' or at_ts < now() - interval '30 days' then continue; end if;
    k := coalesce(e->>'kind', '');
    if k not in ('question', 'quiz', 'game', 'practice', 'lesson', 'active', 'data') then continue; end if;
    if length(coalesce(e->>'client_ref', '')) not between 8 and 64 then continue; end if;
    if k = 'data' and (b is null or b < 1 or b > 50000000) then continue; end if;
    insert into learning_events (learner_id, class_id, kind, subject, topic, correct, attempted, duration_seconds, offline, client_ref, occurred_at, bytes)
    values (me, cls, k, left(nullif(trim(coalesce(e->>'subject', '')), ''), 60), left(nullif(trim(coalesce(e->>'topic', '')), ''), 120),
            least(greatest((e->>'correct')::int, 0), 100), least(greatest((e->>'attempted')::int, 0), 100),
            least(greatest((e->>'duration_seconds')::int, 0), 3600), coalesce((e->>'offline')::boolean, false),
            e->>'client_ref', at_ts, case when k = 'data' then b end)
    on conflict (learner_id, client_ref) do nothing;
    if found then n := n + 1; end if;
  end loop;
  return jsonb_build_object('stored', n, 'taking_part', true);
end;
$$;

-- ============ 2. Prices, budget and costs typed in ============
create table if not exists public.cost_settings (
  id int primary key default 1 check (id = 1),
  data_usd_per_gb numeric(8, 4) not null default 1.20 check (data_usd_per_gb >= 0),
  sms_usd numeric(8, 4) not null default 0.05 check (sms_usd >= 0),
  ussd_session_usd numeric(8, 4) not null default 0.03 check (ussd_session_usd >= 0),
  budget_per_learner_usd numeric(8, 2) not null default 2.50 check (budget_per_learner_usd > 0),
  -- early in a month a single download can look like overspending, so the alert
  -- treats the month as at least this many days old
  alert_floor_days int not null default 7 check (alert_floor_days between 1 and 28),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);
insert into public.cost_settings (id) values (1) on conflict (id) do nothing;
alter table public.cost_settings enable row level security;

create table if not exists public.cost_entries (
  id bigint generated always as identity primary key,
  school_id uuid references public.schools(id) on delete cascade, -- null: for the whole pilot
  month date not null check (extract(day from month) = 1),
  kind text not null check (kind in ('data_bundles', 'sms', 'ussd', 'other')),
  amount_usd numeric(10, 2) not null check (amount_usd >= 0 and amount_usd <= 100000),
  note text,
  entered_by uuid references public.profiles(id) on delete set null,
  entered_at timestamptz not null default now()
);
alter table public.cost_entries enable row level security;

create table if not exists public.cost_alerts (
  id bigint generated always as identity primary key,
  scope text not null check (scope in ('pilot', 'school', 'learner')),
  ref text not null,                      -- 'all', the school id, or the learner's pilot ID
  school_id uuid references public.schools(id) on delete cascade,
  learner_id uuid references public.profiles(id) on delete cascade,
  label text not null,                    -- school name or pilot ID, never a learner's name
  month date not null,
  spent_usd numeric(10, 2) not null,
  per_learner_usd numeric(10, 2) not null,
  allowed_usd numeric(10, 2) not null,    -- budget per learner for the month so far
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  dismissed_at timestamptz,
  dismissed_by uuid references public.profiles(id) on delete set null,
  unique (scope, ref, month)
);
alter table public.cost_alerts enable row level security;

-- ============ 3. The report ============
-- Internal: builds the report for p_from to p_to (Namibian dates, both included),
-- for one region or all. Leaves the per-learner figures in the temporary table
-- rep_l for the daily check. Callers check the role first.
create or replace function public.pilot_report_core(p_from date, p_to date, p_region smallint default null)
returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  tz text := coalesce((select time_zone from messaging_rules where id = 1), 'Africa/Windhoek');
  t0 timestamptz;
  t1 timestamptz;
  cs cost_settings;
  days int;
  mdays int;
  budget numeric;
  rows_j jsonb;
  learners_j jsonb;
  pilot_other numeric;
  teacher_sms record;
begin
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Choose a start date on or before the end date.'; end if;
  days := p_to - p_from + 1;
  if days > 93 then raise exception 'Choose a period of at most three months.'; end if;
  t0 := (p_from::timestamp) at time zone tz;
  t1 := ((p_to + 1)::timestamp) at time zone tz;
  select * into cs from cost_settings where id = 1;
  mdays := extract(day from (date_trunc('month', p_from) + interval '1 month - 1 day'))::int;
  budget := round(cs.budget_per_learner_usd * days / mdays, 2); -- a full calendar month gives exactly the budget

  drop table if exists pg_temp.rep_l;
  create temp table rep_l (
    learner_id uuid, pseudo_id text, class_id uuid, school_id uuid, region_id smallint, setting text,
    active boolean, sessions int, seconds int, questions int, practice int, ussd int, bytes bigint,
    sms int, sms_cost numeric, cost numeric
  ) on commit drop;
  drop table if exists pg_temp.rep_t;
  create temp table rep_t (learner_id uuid, topic text) on commit drop;

  with part as (
    select pp.learner_id, pp.pseudo_id, pp.class_id, pp.school_id, pp.region_id, pp.setting
      from pilot_participants pp where p_region is null or pp.region_id = p_region
  ), ev as (
    select le.* from learning_events le join part using (learner_id)
     where le.occurred_at >= t0 and le.occurred_at < t1
  ), act as (
    select learner_id, kind, attempted, duration_seconds,
           case when lag(occurred_at) over w is null or occurred_at - lag(occurred_at) over w > interval '30 minutes' then 1 else 0 end as new_session
      from ev where kind <> 'data'
    window w as (partition by learner_id order by occurred_at)
  ), a as (
    select learner_id, count(*) n, sum(new_session)::int sessions,
           coalesce(sum(duration_seconds) filter (where kind = 'active'), 0)::int seconds,
           count(*) filter (where kind = 'question')::int questions,
           coalesce(sum(attempted) filter (where kind in ('quiz', 'game', 'practice')), 0)::int practice,
           count(*) filter (where kind = 'ussd')::int ussd
      from act group by learner_id
  ), d as (
    select learner_id, coalesce(sum(bytes), 0)::bigint bytes from ev where kind = 'data' group by learner_id
  ), s as (
    select ml.learner_id, count(*)::int n, sum(coalesce(ml.cost_usd, cs.sms_usd)) cost
      from message_log ml join part using (learner_id)
     where ml.recipient_kind = 'learner' and ml.channel = 'sms' and ml.status = 'sent'
       and ml.delivered_at >= t0 and ml.delivered_at < t1
     group by ml.learner_id
  )
  insert into rep_l
  select part.learner_id, part.pseudo_id, part.class_id, part.school_id, part.region_id, part.setting,
         coalesce(a.n, 0) > 0, coalesce(a.sessions, 0), coalesce(a.seconds, 0), coalesce(a.questions, 0), coalesce(a.practice, 0),
         coalesce(a.ussd, 0), coalesce(d.bytes, 0), coalesce(s.n, 0), coalesce(s.cost, 0),
         coalesce(d.bytes, 0) / 1e9 * cs.data_usd_per_gb + coalesce(a.ussd, 0) * cs.ussd_session_usd + coalesce(s.cost, 0)
    from part left join a using (learner_id) left join d using (learner_id) left join s using (learner_id);

  insert into rep_t
  select distinct le.learner_id, le.topic from learning_events le join rep_l using (learner_id)
   where le.occurred_at >= t0 and le.occurred_at < t1 and le.topic is not null
     and le.kind in ('question', 'quiz', 'game', 'practice', 'lesson');

  -- costs typed in for the months of the period: by school, and for the whole pilot
  pilot_other := coalesce((select sum(amount_usd) from cost_entries
                            where school_id is null and month between date_trunc('month', p_from)::date and p_to), 0);
  -- Monday summaries and other texts to teachers count for the whole pilot
  -- (both are left out of a report for one region)
  select count(*)::int n, coalesce(sum(coalesce(cost_usd, cs.sms_usd)), 0) cost into teacher_sms
    from message_log where recipient_kind = 'teacher' and channel = 'sms' and status = 'sent'
     and delivered_at >= t0 and delivered_at < t1;

  with c as (
    select cl.id class_id, cl.name class_name, sc.id school_id, sc.name school, r.name region, sc.setting
      from classes cl join schools sc on sc.id = cl.school_id left join regions r on r.id = sc.region_id
     where cl.pilot and sc.in_pilot and (p_region is null or sc.region_id = p_region)
  ), m as (
    select school_id, sum(amount_usd) amt from cost_entries
     where school_id is not null and month between date_trunc('month', p_from)::date and p_to group by school_id
  ), base as (
    select c.*, l.learner_id, l.active, l.sessions, l.seconds, l.questions, l.practice, l.ussd, l.bytes, l.sms, l.sms_cost, l.cost,
           -- the school's typed-in costs are counted once per school
           case when row_number() over (partition by c.school_id order by c.class_id, l.learner_id) = 1 then coalesce(m.amt, 0) else 0 end as other
      from c left join rep_l l on l.class_id = c.class_id left join m on m.school_id = c.school_id
  ), g as (
    select case when grouping(class_id) = 0 then 'class' when grouping(school_id) = 0 then 'school'
                when grouping(region) = 0 then 'region' when grouping(setting) = 0 then 'setting' else 'total' end as level,
           class_id, class_name, school_id, school, region, setting,
           count(learner_id)::int learners, count(*) filter (where active)::int active,
           coalesce(sum(sessions), 0)::int sessions, round(coalesce(sum(seconds), 0) / 60.0)::int minutes,
           coalesce(sum(questions), 0)::int questions, coalesce(sum(practice), 0)::int practice, coalesce(sum(ussd), 0)::int ussd,
           coalesce(sum(bytes), 0)::bigint bytes, coalesce(sum(sms), 0)::int sms,
           coalesce(sum(bytes), 0) / 1e9 * cs.data_usd_per_gb as cost_data,
           coalesce(sum(sms_cost), 0) as cost_sms,
           coalesce(sum(ussd), 0) * cs.ussd_session_usd as cost_ussd,
           coalesce(sum(other), 0) as cost_other
      from base
     group by grouping sets ((class_id, class_name, school_id, school, region, setting), (school_id, school, region, setting), (region), (setting), ())
  ), gt as (
    select g.*,
           (select count(distinct t.topic) from rep_t t join rep_l l using (learner_id)
             where (g.level <> 'class' or l.class_id = g.class_id)
               and (g.level not in ('class', 'school') or l.school_id = g.school_id)
               and (g.level <> 'region' or l.region_id = (select id from regions where name = g.region))
               and (g.level <> 'setting' or l.setting = g.setting))::int as topics,
           g.cost_other + case when g.level = 'total' and p_region is null then pilot_other else 0 end as other_all,
           g.sms + case when g.level = 'total' and p_region is null then teacher_sms.n else 0 end as sms_all,
           g.cost_sms + case when g.level = 'total' and p_region is null then teacher_sms.cost else 0 end as cost_sms_all
      from g
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'level', level, 'class_id', class_id, 'class', class_name, 'school_id', school_id, 'school', school,
           'region', region, 'setting', setting,
           'learners', learners, 'active', active, 'sessions', sessions, 'minutes', minutes,
           'questions', questions, 'practice', practice, 'topics', topics, 'ussd', ussd,
           'data_mb', round(bytes / 1e6, 1), 'sms', sms_all,
           'cost_data', round(cost_data, 2), 'cost_sms', round(cost_sms_all, 2), 'cost_ussd', round(cost_ussd, 2),
           'cost_other', round(other_all, 2),
           'cost_total', round(cost_data + cost_sms_all + cost_ussd + other_all, 2),
           'cost_per_learner', case when learners > 0 then round((cost_data + cost_sms_all + cost_ussd + other_all) / learners, 2) end,
           'ahead', learners > 0 and (cost_data + cost_sms_all + cost_ussd + other_all) / learners > budget
         ) order by case level when 'total' then 0 when 'setting' then 1 when 'region' then 2 when 'school' then 3 else 4 end,
                    region, school, class_name, setting), '[]'::jsonb)
    into rows_j from gt;

  select coalesce(jsonb_agg(jsonb_build_object(
           'pseudo_id', l.pseudo_id, 'region', r.name, 'school', sc.name, 'setting', l.setting, 'class', cl.name,
           'active', l.active, 'sessions', l.sessions, 'minutes', round(l.seconds / 60.0)::int, 'questions', l.questions,
           'practice', l.practice, 'topics', (select count(*) from rep_t t where t.learner_id = l.learner_id), 'ussd', l.ussd,
           'data_mb', round(l.bytes / 1e6, 1), 'sms', l.sms, 'cost', round(l.cost, 2), 'ahead', l.cost > budget
         ) order by r.name, sc.name, cl.name, l.pseudo_id), '[]'::jsonb)
    into learners_j
    from rep_l l join classes cl on cl.id = l.class_id join schools sc on sc.id = l.school_id left join regions r on r.id = l.region_id;

  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'days', days, 'region_id', p_region,
    'budget_per_learner', budget, 'budget_per_learner_month', cs.budget_per_learner_usd,
    'rates', jsonb_build_object('data_usd_per_gb', cs.data_usd_per_gb, 'sms_usd', cs.sms_usd, 'ussd_session_usd', cs.ussd_session_usd),
    'generated_at', now(), 'rows', rows_j, 'learners', learners_j);
end;
$$;
revoke execute on function public.pilot_report_core(date, date, smallint) from public, anon, authenticated;

-- administrators see every pilot school; a regional champion sees their region
create or replace function public.pilot_usage_report(p_from date, p_to date)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  reg smallint;
begin
  if pilot_is_admin() then
    reg := null;
  else
    reg := pilot_champion_region();
    if reg is null then raise exception 'Only K-12 EdTech administrators and regional champions can see pilot reports.'; end if;
  end if;
  return pilot_report_core(p_from, p_to, reg);
end;
$$;

-- ============ 4. Spending alerts ============
-- Run every day by the scheduler (p_now only for tests). Compares the month so far
-- with the budget for the month so far, for the whole pilot, each school and each learner.
create or replace function public.pilot_check_spending(p_now timestamptz default now())
returns int
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  tz text := coalesce((select time_zone from messaging_rules where id = 1), 'Africa/Windhoek');
  today date := (p_now at time zone tz)::date;
  m0 date := date_trunc('month', today)::date;
  mdays int := extract(day from (date_trunc('month', today) + interval '1 month - 1 day'))::int;
  cs cost_settings;
  allowed numeric;
  rep jsonb;
  r jsonb;
  l record;
  n int := 0;
begin
  select * into cs from cost_settings where id = 1;
  allowed := round(cs.budget_per_learner_usd * least(greatest(today - m0 + 1, cs.alert_floor_days)::numeric / mdays, 1), 2);
  rep := pilot_report_core(m0, today, null);
  for r in select value from jsonb_array_elements(rep->'rows') where value->>'level' in ('school', 'total') loop
    if (r->>'learners')::int > 0 and (r->>'cost_per_learner')::numeric > allowed then
      insert into cost_alerts (scope, ref, school_id, label, month, spent_usd, per_learner_usd, allowed_usd, created_at, updated_at)
      values (case when r->>'level' = 'total' then 'pilot' else 'school' end,
              coalesce(r->>'school_id', 'all'), (r->>'school_id')::uuid,
              coalesce(r->>'school', 'The whole pilot'), m0, (r->>'cost_total')::numeric, (r->>'cost_per_learner')::numeric, allowed, p_now, p_now)
      on conflict (scope, ref, month) do update
        set spent_usd = excluded.spent_usd, per_learner_usd = excluded.per_learner_usd, allowed_usd = excluded.allowed_usd, updated_at = p_now;
      n := n + 1;
    end if;
  end loop;
  for l in select * from rep_l where cost > allowed loop
    insert into cost_alerts (scope, ref, school_id, learner_id, label, month, spent_usd, per_learner_usd, allowed_usd, created_at, updated_at)
    values ('learner', l.pseudo_id, l.school_id, l.learner_id, l.pseudo_id, m0, l.cost, l.cost, allowed, p_now, p_now)
    on conflict (scope, ref, month) do update
      set spent_usd = excluded.spent_usd, per_learner_usd = excluded.per_learner_usd, allowed_usd = excluded.allowed_usd, updated_at = p_now;
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke execute on function public.pilot_check_spending(timestamptz) from public, anon, authenticated;
grant execute on function public.pilot_check_spending(timestamptz) to service_role;

create or replace function public.pilot_spending_alerts()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not pilot_is_admin() then raise exception 'Only K-12 EdTech administrators can see spending alerts.'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id, 'scope', a.scope, 'label', a.label, 'school', s.name, 'month', a.month,
      'spent_usd', a.spent_usd, 'per_learner_usd', a.per_learner_usd, 'allowed_usd', a.allowed_usd,
      'created_at', a.created_at, 'updated_at', a.updated_at)
      order by case a.scope when 'pilot' then 0 when 'school' then 1 else 2 end, a.per_learner_usd desc)
      from cost_alerts a left join schools s on s.id = a.school_id
     where a.dismissed_at is null and a.month >= (date_trunc('month', now()) - interval '1 month')::date), '[]'::jsonb);
end;
$$;

create or replace function public.pilot_dismiss_alert(p_id bigint)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not pilot_is_admin() then raise exception 'Only K-12 EdTech administrators can dismiss alerts.'; end if;
  update cost_alerts set dismissed_at = now(), dismissed_by = auth.uid() where id = p_id and dismissed_at is null;
  return jsonb_build_object('ok', true);
end;
$$;

-- ============ 5. Prices and typed-in costs (administrators) ============
create or replace function public.pilot_cost_settings()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not pilot_is_admin() then raise exception 'Only K-12 EdTech administrators can see the prices.'; end if;
  return (select jsonb_build_object('data_usd_per_gb', data_usd_per_gb, 'sms_usd', sms_usd, 'ussd_session_usd', ussd_session_usd,
                                    'budget_per_learner_usd', budget_per_learner_usd, 'alert_floor_days', alert_floor_days, 'updated_at', updated_at)
            from cost_settings where id = 1);
end;
$$;

create or replace function public.pilot_set_cost_settings(p jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not pilot_is_admin() then raise exception 'Only K-12 EdTech administrators can change the prices.'; end if;
  begin
    update cost_settings set
      data_usd_per_gb = coalesce((p->>'data_usd_per_gb')::numeric, data_usd_per_gb),
      sms_usd = coalesce((p->>'sms_usd')::numeric, sms_usd),
      ussd_session_usd = coalesce((p->>'ussd_session_usd')::numeric, ussd_session_usd),
      budget_per_learner_usd = coalesce((p->>'budget_per_learner_usd')::numeric, budget_per_learner_usd),
      updated_by = auth.uid(), updated_at = now()
     where id = 1;
  exception when invalid_text_representation or check_violation or numeric_value_out_of_range then
    raise exception 'Please check the prices: use numbers such as 1.20, and a budget above 0.';
  end;
  return pilot_cost_settings();
end;
$$;

create or replace function public.pilot_add_cost_entry(p jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  sid uuid;
  mon date;
  amt numeric;
begin
  if not pilot_is_admin() then raise exception 'Only K-12 EdTech administrators can add costs.'; end if;
  begin
    sid := nullif(p->>'school_id', '')::uuid;
    mon := date_trunc('month', (p->>'month')::date)::date;
    amt := (p->>'amount_usd')::numeric;
  exception when others then
    raise exception 'Please choose a month and type the amount in US dollars, such as 40.00.';
  end;
  if mon is null or amt is null or amt < 0 then raise exception 'Please choose a month and type the amount in US dollars, such as 40.00.'; end if;
  if sid is not null and not exists (select 1 from schools where id = sid and in_pilot) then raise exception 'That school is not in the pilot.'; end if;
  insert into cost_entries (school_id, month, kind, amount_usd, note, entered_by)
  values (sid, mon, coalesce(nullif(p->>'kind', ''), 'data_bundles'), amt, left(nullif(trim(coalesce(p->>'note', '')), ''), 200), auth.uid());
  return jsonb_build_object('ok', true);
exception when check_violation then
  raise exception 'Please check the type of cost and the amount.';
end;
$$;

create or replace function public.pilot_cost_entries(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not pilot_is_admin() then raise exception 'Only K-12 EdTech administrators can see typed-in costs.'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', e.id, 'school', coalesce(s.name, 'The whole pilot'), 'month', e.month, 'kind', e.kind,
                                        'amount_usd', e.amount_usd, 'note', e.note, 'entered_at', e.entered_at) order by e.month, s.name)
      from cost_entries e left join schools s on s.id = e.school_id
     where e.month between date_trunc('month', p_from)::date and p_to), '[]'::jsonb);
end;
$$;

create or replace function public.pilot_remove_cost_entry(p_id bigint)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not pilot_is_admin() then raise exception 'Only K-12 EdTech administrators can remove costs.'; end if;
  delete from cost_entries where id = p_id;
  return jsonb_build_object('ok', true);
end;
$$;

-- ============ 6. Withdrawal removes spending alerts about the learner too ============
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
  update teacher_summaries
     set data = jsonb_set(data, '{not_active}', coalesce((select jsonb_agg(x) from jsonb_array_elements(data->'not_active') x
                                                           where x <> to_jsonb(lid::text)), '[]'::jsonb))
   where data->'not_active' ? lid::text;
  -- (later pilot items add their tables here)
  update data_removals set status = 'done', done_at = now(), done_by = auth.uid() where id = p_removal;
  return jsonb_build_object('ok', true);
end;
$$;

-- ============ 7. Who may call what, and the daily check ============
do $$
declare f text;
begin
  foreach f in array array['pilot_usage_report(date, date)', 'pilot_spending_alerts()', 'pilot_dismiss_alert(bigint)',
                           'pilot_cost_settings()', 'pilot_set_cost_settings(jsonb)', 'pilot_add_cost_entry(jsonb)',
                           'pilot_cost_entries(date, date)', 'pilot_remove_cost_entry(bigint)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.unschedule(jobid) from cron.job where jobname = 'k12plus-daily-spending-check';
    perform cron.schedule('k12plus-daily-spending-check', '15 4 * * *', 'select public.pilot_check_spending()');
  end if;
end $$;

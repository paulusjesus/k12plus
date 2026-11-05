-- K12Plus Monitor, part 2 (6 November 2026): periods, registrations, accounts, school logos
--
-- What changes
--   * The monitor_* functions from 5 November are replaced so that figures can be read
--     by day, week, month, quarter or year. They held no data, so nothing is lost.
--   * Registration numbers per class, school, region and country. These count every
--     account (numbers only, never names), as agreed on 5 November. Learning figures
--     still count only learners with consent. Officials do not see groups of fewer
--     than five accounts.
--   * Accounts: people with rights for a class, a school, a region or the whole country
--     can add, edit, reset and switch off accounts in that area, and give rights to
--     others. Learner accounts are handled by class and school managers only
--     (and by K-12 EdTech administrators, who support everyone). Every change is logged.
--   * Schools get an optional logo, stored in a public bucket.
--
-- Additive only for data: one new column (schools.logo_url, empty), two new tables
-- (account_rights, account_audit) and a storage bucket. No existing row is changed.

-- ============ 1. School logos ============
alter table public.schools add column if not exists logo_url text;
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('school-logos', 'school-logos', true, 307200, array['image/png', 'image/jpeg', 'image/webp'])
    on conflict (id) do nothing;
  end if;
end $$;

-- ============ 2. Rights and the change log ============
create table if not exists public.account_rights (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  scope text not null check (scope in ('class', 'school', 'region', 'country')),
  class_id uuid references public.classes(id) on delete cascade,
  school_id uuid references public.schools(id) on delete cascade,
  region_id smallint references public.regions(id),
  can_grant boolean not null default false,
  granted_by uuid references public.profiles(id) on delete set null,
  granted_at timestamptz not null default now(),
  check ((scope = 'class') = (class_id is not null)),
  check ((scope = 'school') = (school_id is not null)),
  check ((scope = 'region') = (region_id is not null))
);
create unique index if not exists account_rights_one_idx
  on public.account_rights (user_id, scope, coalesce(class_id::text, school_id::text, region_id::text, 'all'));
alter table public.account_rights enable row level security;

create table if not exists public.account_audit (
  id bigint generated always as identity primary key,
  actor uuid references public.profiles(id) on delete set null,
  action text not null,
  target uuid,
  target_name text,
  school_id uuid,
  region_id smallint,
  details jsonb not null default '{}'::jsonb,
  status text not null default 'done' check (status in ('requested', 'done', 'failed')),
  at timestamptz not null default now()
);
create index if not exists account_audit_school_idx on public.account_audit (school_id, at desc);
create index if not exists account_audit_region_idx on public.account_audit (region_id, at desc);
alter table public.account_audit enable row level security;

-- ============ 3. Who holds which rights ============
-- Rights come from four places: administrators hold the whole country; principals,
-- heads of department and school administrators hold their school; teachers hold
-- the pilot classes they teach; anyone can be given rights by someone who may.
create or replace function public.account_scopes(p_user uuid)
returns table (scope text, class_id uuid, school_id uuid, region_id smallint, can_grant boolean, source text, right_id bigint)
language sql stable security definer set search_path = public as $$
  select 'country', null::uuid, null::uuid, null::smallint, true, 'administrator', null::bigint
    from profiles where id = p_user and role = 'admin'
  union all
  select 'school', null, p.school_id, null, true, 'school leader', null
    from profiles p where p.id = p_user and p.role in ('principal', 'hod', 'school_admin') and p.school_id is not null
  union all
  select 'class', ct.class_id, null, null, false, 'teacher', null
    from class_teachers ct join classes c on c.id = ct.class_id where ct.teacher_id = p_user and c.pilot
  union all
  select r.scope, r.class_id, r.school_id, r.region_id, r.can_grant, 'given', r.id
    from account_rights r where r.user_id = p_user;
$$;

create or replace function public.account_rank(p_scope text)
returns int language sql immutable as $$
  select case p_scope when 'class' then 1 when 'school' then 2 when 'region' then 3 when 'country' then 4 else 0 end;
$$;

-- Where a person sits: their active pilot class, their school and its region.
create or replace function public.account_place(p_user uuid)
returns table (class_id uuid, school_id uuid, region_id smallint)
language sql stable security definer set search_path = public as $$
  select e.class_id, coalesce(p.school_id, c.school_id), s.region_id
    from profiles p
    left join enrolments e on e.learner_id = p.id and e.status = 'active'
    left join classes c on c.id = e.class_id
    left join schools s on s.id = coalesce(p.school_id, c.school_id)
   where p.id = p_user;
$$;

-- The highest rank the actor holds over a place, and the highest rank they may give rights at.
-- Administrators count as 5, above everyone.
create or replace function public.account_cover(p_actor uuid, p_class uuid, p_school uuid, p_region smallint, p_learner_rules boolean default false)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'rank', coalesce(max(case when x.source = 'administrator' then 5 else account_rank(x.scope) end), 0),
    'grant_rank', coalesce(max(case when x.source = 'administrator' then 5 when x.can_grant then account_rank(x.scope) end), 0))
    from account_scopes(p_actor) x
   where (x.source = 'administrator'
          or (x.scope = 'class' and x.class_id = p_class)
          or (x.scope = 'school' and x.school_id = p_school)
          or (not p_learner_rules and x.scope = 'region' and x.region_id = p_region)
          or (not p_learner_rules and x.scope = 'country'));
$$;

-- How senior a person is: administrators 5, national officials 4, regional officials 3,
-- otherwise their highest right (0 for none).
create or replace function public.account_seniority(p_user uuid)
returns int
language sql stable security definer set search_path = public as $$
  select greatest(
    coalesce((select 5 from profiles where id = p_user and role = 'admin'), 0),
    coalesce((select case when region_id is null then 4 else 3 end from monitor_officials where user_id = p_user), 0),
    coalesce((select 4 from profiles where id = p_user and role = 'ministry'), 0),
    coalesce((select max(account_rank(scope)) from account_scopes(p_user)), 0));
$$;

-- The rank with which the actor may manage the target, or 0 if they may not.
-- Learners and parents are managed at class and school level only (and by administrators).
-- Nobody manages themselves here, and nobody manages someone as senior as they are.
create or replace function public.account_can_manage(p_actor uuid, p_target uuid)
returns int
language plpgsql stable security definer set search_path = public as $$
declare
  t profiles;
  pl record;
  cover int;
begin
  if p_actor is null or p_target is null or p_actor = p_target then return 0; end if;
  select * into t from profiles where id = p_target;
  if not found then return 0; end if;
  select * into pl from account_place(p_target);
  cover := (account_cover(p_actor, pl.class_id, pl.school_id, pl.region_id, t.role in ('learner', 'parent'))->>'rank')::int;
  if cover > account_seniority(p_target) then return cover; end if;
  return 0;
end;
$$;

-- ============ 4. Periods ============
-- day: the last 30 days; week: 12 weeks; month: 12 months; quarter: 8 quarters; year: 5 years.
create or replace function public.monitor_window(p_grain text)
returns table (grain text, step interval, first_day date, last_start date)
language sql stable as $$
  with g as (select case when p_grain in ('day', 'week', 'month', 'quarter', 'year') then p_grain else 'week' end g),
       t as (select (now() at time zone 'Africa/Windhoek')::date d)
  select g.g,
         case g.g when 'day' then interval '1 day' when 'week' then interval '7 days' when 'month' then interval '1 month'
                  when 'quarter' then interval '3 months' else interval '1 year' end,
         case g.g when 'day' then t.d - 29
                  when 'week' then date_trunc('week', t.d)::date - 77
                  when 'month' then (date_trunc('month', t.d) - interval '11 months')::date
                  when 'quarter' then (date_trunc('quarter', t.d) - interval '21 months')::date
                  else (date_trunc('year', t.d) - interval '4 years')::date end,
         date_trunc(case g.g when 'day' then 'day' else g.g end, t.d)::date
    from g, t;
$$;

-- ============ 5. Learning figures (learners with consent only) ============
drop function if exists public.monitor_learner(uuid, int);
drop function if exists public.monitor_class(uuid, int);
drop function if exists public.monitor_school(uuid, int);
drop function if exists public.monitor_region(smallint, int);
drop function if exists public.monitor_country(int);
drop function if exists public.monitor_stats(uuid[], int, boolean);

create or replace function public.monitor_stats(p_ids uuid[], p_grain text, p_detail boolean default true)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  tz constant text := 'Africa/Windhoek';
  w record;
  t0 timestamptz;
  n int := coalesce(cardinality(p_ids), 0);
  base jsonb;
  series jsonb;
  topics jsonb;
  tests jsonb;
begin
  select * into w from monitor_window(p_grain);
  t0 := w.first_day::timestamp at time zone tz;
  with ev as (
    select le.* from learning_events le
     where le.learner_id = any (p_ids) and le.occurred_at >= t0 and le.kind <> 'data'
  )
  select jsonb_build_object(
    'learners', n,
    'active_week', (select count(distinct learner_id) from learning_events
                     where learner_id = any (p_ids) and kind <> 'data' and occurred_at >= now() - interval '7 days'),
    'active_period', (select count(distinct learner_id) from ev),
    'minutes', (select round(coalesce(sum(duration_seconds), 0) / 60.0) from ev where kind = 'active'),
    'questions', (select count(*) from ev where kind in ('question', 'ussd')),
    'lessons', (select count(*) from ev where kind = 'lesson'),
    'attempted', (select coalesce(sum(attempted), 0) from ev where kind in ('quiz', 'game', 'practice')),
    'correct', (select coalesce(sum(correct), 0) from ev where kind in ('quiz', 'game', 'practice')),
    'topics_practised', (select count(distinct topic) from ev where topic is not null and kind in ('quiz', 'game', 'practice', 'lesson', 'question')),
    'last_active', (select max(occurred_at) from learning_events where learner_id = any (p_ids) and kind <> 'data'))
  into base;
  base := base || jsonb_build_object('accuracy',
    case when (base->>'attempted')::int > 0 then round(100.0 * (base->>'correct')::int / (base->>'attempted')::int) end);

  select coalesce(jsonb_object_agg(purpose, jsonb_build_object('sat', sat, 'average', avg_pct)), '{}'::jsonb)
    into tests
    from (select t.purpose, count(*)::int sat, round(avg(100.0 * a.score / nullif(a.max_score, 0)))::int avg_pct
            from test_attempts a join tests t on t.id = a.test_id
           where a.learner_id = any (p_ids) and a.submitted_at is not null
           group by t.purpose) x;
  base := base || jsonb_build_object('tests', tests, 'grain', w.grain, 'from', w.first_day);

  if p_detail then
    select jsonb_agg(jsonb_build_object(
             'start', b.d::date, 'active', coalesce(x.active, 0), 'minutes', coalesce(x.minutes, 0),
             'questions', coalesce(x.questions, 0), 'attempted', coalesce(x.att, 0),
             'accuracy', case when coalesce(x.att, 0) > 0 then round(100.0 * x.cor / x.att) end) order by b.d)
      into series
      from generate_series(w.first_day, w.last_start, w.step) b(d)
      left join (
        select date_trunc(w.grain, occurred_at at time zone tz)::date bucket,
               count(distinct learner_id)::int active,
               round(coalesce(sum(duration_seconds) filter (where kind = 'active'), 0) / 60.0)::int minutes,
               count(*) filter (where kind in ('question', 'ussd'))::int questions,
               coalesce(sum(attempted) filter (where kind in ('quiz', 'game', 'practice')), 0)::int att,
               coalesce(sum(correct) filter (where kind in ('quiz', 'game', 'practice')), 0)::int cor
          from learning_events
         where learner_id = any (p_ids) and occurred_at >= t0 and kind <> 'data'
         group by 1) x on x.bucket = b.d::date;

    select coalesce(jsonb_agg(jsonb_build_object(
             'subject', subject, 'topic', topic, 'learners', learners, 'attempted', att, 'correct', cor,
             'accuracy', round(100.0 * cor / att)) order by round(100.0 * cor / att), att desc), '[]'::jsonb)
      into topics
      from (select coalesce(subject, 'Mathematics') subject, topic, count(distinct learner_id)::int learners,
                   sum(attempted)::int att, sum(correct)::int cor
              from learning_events
             where learner_id = any (p_ids) and occurred_at >= t0 and topic is not null
               and kind in ('quiz', 'game', 'practice') and attempted > 0
             group by 1, 2) y;
    base := base || jsonb_build_object('series', series, 'topics', topics);
  end if;
  return base;
end;
$$;

-- ============ 6. Registrations (every account, numbers only) ============
-- Accounts that belong to a school, a region or Namibia. K-12 EdTech staff are left out.
create or replace function public.monitor_reg_ids(p_school uuid, p_region smallint, p_country boolean default false)
returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(p.id), '{}')
    from profiles p left join schools s on s.id = p.school_id
   where p.role not in ('admin')
     and (p_school is null or p.school_id = p_school)
     and (p_region is null or s.region_id = p_region)
     and (not p_country or s.region_id is not null or (p.school_id is null and coalesce(p.country, 'Namibia') = 'Namibia'));
$$;

create or replace function public.monitor_reg(p_ids uuid[], p_grain text, p_detail boolean default true)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  w record;
  t0 timestamptz;
  out jsonb;
begin
  select * into w from monitor_window(p_grain);
  t0 := w.first_day::timestamp at time zone 'Africa/Windhoek';
  select jsonb_build_object(
    'total', count(*),
    'learners', count(*) filter (where role = 'learner'),
    'teachers', count(*) filter (where role = 'educator'),
    'leaders', count(*) filter (where role in ('principal', 'hod', 'school_admin')),
    'parents', count(*) filter (where role = 'parent'),
    'officials', count(*) filter (where role = 'ministry'),
    'new_period', count(*) filter (where created_at >= t0),
    'by_grade', jsonb_build_object(
      '8', count(*) filter (where role = 'learner' and grade = 8), '9', count(*) filter (where role = 'learner' and grade = 9),
      '10', count(*) filter (where role = 'learner' and grade = 10), '11', count(*) filter (where role = 'learner' and grade = 11),
      '12', count(*) filter (where role = 'learner' and grade = 12), 'none', count(*) filter (where role = 'learner' and grade is null)))
    into out
    from profiles where id = any (p_ids);
  if p_detail then
    out := out || jsonb_build_object('series', (
      select jsonb_agg(jsonb_build_object('start', y.d, 'new', y.n, 'learners_new', y.l, 'total', y.running) order by y.d)
        from (select b.d::date d, coalesce(x.n, 0) n, coalesce(x.l, 0) l,
                     before.n + sum(coalesce(x.n, 0)) over (order by b.d) running
                from generate_series(w.first_day, w.last_start, w.step) b(d)
                cross join (select count(*)::int n from profiles where id = any (p_ids) and created_at < t0) before
                left join (select date_trunc(w.grain, created_at at time zone 'Africa/Windhoek')::date bucket,
                                  count(*)::int n, count(*) filter (where role = 'learner')::int l
                             from profiles where id = any (p_ids) and created_at >= t0 group by 1) x on x.bucket = b.d::date) y));
  end if;
  return out;
end;
$$;

-- Officials do not see a group of 1 to 4 accounts.
create or replace function public.monitor_reg_mask(p jsonb, p_named boolean)
returns jsonb language sql immutable as $$
  select case when p_named or coalesce((p->>'total')::int, 0) = 0 or (p->>'total')::int >= 5 then p
              else jsonb_build_object('too_few', true) end;
$$;

-- Learners registered per class (grade and class letter) at one school.
create or replace function public.monitor_reg_classes(p_school uuid, p_named boolean)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(case when p_named or n >= 5 then jsonb_build_object('grade', grade, 'letter', class_letter, 'learners', n)
                                 else jsonb_build_object('grade', grade, 'letter', class_letter, 'too_few', true) end
                            order by grade nulls last, class_letter nulls last), '[]'::jsonb)
    from (select grade, class_letter, count(*)::int n from profiles
           where school_id = p_school and role = 'learner' group by 1, 2) x;
$$;

-- ============ 7. Who may see what ============
create or replace function public.monitor_me()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  p profiles;
  o monitor_officials;
begin
  select * into p from profiles where id = auth.uid();
  if not found then return null; end if;
  select * into o from monitor_officials where user_id = p.id;
  return jsonb_build_object(
    'id', p.id, 'name', p.username, 'role', p.role, 'admin', p.role = 'admin',
    'classes', coalesce((select jsonb_agg(distinct class_id) from account_scopes(p.id) where scope = 'class'), '[]'::jsonb),
    'schools', coalesce((select jsonb_agg(distinct school_id) from account_scopes(p.id) where scope = 'school'), '[]'::jsonb),
    'regions', coalesce((select jsonb_agg(distinct r) from (
                  select p.champion_region_id r union select o.region_id union
                  select region_id from account_scopes(p.id) where scope = 'region') x where r is not null), '[]'::jsonb),
    'national', p.role = 'admin' or (o.user_id is not null and o.region_id is null)
                or (p.role = 'ministry' and o.user_id is null)
                or exists (select 1 from account_scopes(p.id) where scope = 'country'));
end;
$$;

create or replace function public.monitor_sees(p_me jsonb, p_class uuid, p_school uuid, p_region smallint)
returns text
language sql immutable as $$
  select case
    when p_class is not null and p_me->'classes' @> to_jsonb(p_class::text) then 'named'
    when p_school is not null and p_me->'schools' @> to_jsonb(p_school::text) then 'named'
    when coalesce((p_me->>'national')::boolean, false) then 'numbers'
    when p_region is not null and p_me->'regions' @> to_jsonb(p_region) then 'numbers'
    else null end;
$$;

create or replace function public.monitor_whoami()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me jsonb := monitor_me();
  v jsonb := '[]'::jsonb;
begin
  if me is null then return jsonb_build_object('signed_in', false); end if;
  if me->>'role' = 'learner' then
    v := v || jsonb_build_array(jsonb_build_object('kind', 'learner', 'name', 'My progress',
                                 'taking_part', pilot_active((me->>'id')::uuid)));
  end if;
  v := v || coalesce((select jsonb_agg(jsonb_build_object('kind', 'class', 'id', c.id, 'name', c.name, 'school', s.name) order by s.name, c.name)
                        from classes c join schools s on s.id = c.school_id
                       where c.pilot and me->'classes' @> to_jsonb(c.id::text)), '[]'::jsonb);
  v := v || coalesce((select jsonb_agg(jsonb_build_object('kind', 'school', 'id', s.id, 'name', s.name, 'logo', s.logo_url) order by s.name)
                        from schools s where me->'schools' @> to_jsonb(s.id::text)), '[]'::jsonb);
  v := v || coalesce((select jsonb_agg(jsonb_build_object('kind', 'region', 'id', r.id, 'name', r.name) order by r.name)
                        from regions r where me->'regions' @> to_jsonb(r.id)), '[]'::jsonb);
  if (me->>'national')::boolean then
    v := v || jsonb_build_array(jsonb_build_object('kind', 'country', 'name', 'Namibia'));
  end if;
  return jsonb_build_object(
    'signed_in', true, 'id', me->>'id', 'name', me->>'name', 'admin', (me->>'admin')::boolean,
    'title', (select title from monitor_officials where user_id = (me->>'id')::uuid), 'views', v,
    'manage', coalesce((select jsonb_agg(jsonb_build_object(
                 'scope', x.scope, 'id', coalesce(x.class_id::text, x.school_id::text, x.region_id::text),
                 'name', case x.scope when 'class' then c.name || ', ' || cs.name when 'school' then s.name
                                      when 'region' then r.name || ' Region' else 'Namibia' end,
                 'can_grant', x.can_grant or x.source = 'administrator', 'source', x.source)
                 order by account_rank(x.scope) desc, coalesce(c.name, s.name, r.name))
               from account_scopes((me->>'id')::uuid) x
               left join classes c on c.id = x.class_id left join schools cs on cs.id = c.school_id
               left join schools s on s.id = x.school_id left join regions r on r.id = x.region_id), '[]'::jsonb));
end;
$$;

-- ============ 8. The views ============
create or replace function public.monitor_learner(p_learner uuid default null, p_grain text default 'week')
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me jsonb := monitor_me();
  lid uuid;
  pp record;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  lid := coalesce(p_learner, (me->>'id')::uuid);
  select x.*, c.name class_name, s.name school_name, s.logo_url into pp
    from pilot_participants x join classes c on c.id = x.class_id join schools s on s.id = x.school_id
   where x.learner_id = lid;
  if lid <> (me->>'id')::uuid and (pp.learner_id is null or coalesce(monitor_sees(me, pp.class_id, pp.school_id, null), '') <> 'named') then
    raise exception 'You can only open learners in your own classes or school.';
  end if;
  if pp.learner_id is null then
    return jsonb_build_object('taking_part', false, 'name', me->>'name');
  end if;
  return monitor_stats(array[lid], p_grain, true) || jsonb_build_object(
    'taking_part', true, 'name', (select username from profiles where id = lid),
    'class', pp.class_name, 'school', pp.school_name, 'logo', pp.logo_url, 'grade', pp.grade,
    'class_id', case when lid <> (me->>'id')::uuid then pp.class_id end,
    'test_results', coalesce((select jsonb_agg(jsonb_build_object('purpose', t.purpose, 'title', t.title, 'score', a.score, 'max', a.max_score,
                                    'percent', round(100.0 * a.score / nullif(a.max_score, 0)), 'on', (a.submitted_at at time zone 'Africa/Windhoek')::date)
                                    order by a.submitted_at)
                                from test_attempts a join tests t on t.id = a.test_id
                               where a.learner_id = lid and a.submitted_at is not null), '[]'::jsonb));
end;
$$;

create or replace function public.monitor_class(p_class uuid, p_grain text default 'week')
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me jsonb := monitor_me();
  c record;
  sees text;
  named boolean;
  rows_j jsonb := null;
  joined int;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  select cl.id, cl.name, cl.grade, cl.school_id, s.name school, s.logo_url, s.region_id, r.name region into c
    from classes cl join schools s on s.id = cl.school_id left join regions r on r.id = s.region_id
   where cl.id = p_class and cl.pilot;
  if c.id is null then raise exception 'Class not found.'; end if;
  sees := monitor_sees(me, c.id, c.school_id, c.region_id);
  if sees is null then raise exception 'You do not have access to this class.'; end if;
  named := sees = 'named';
  if named then
    select coalesce(jsonb_agg(jsonb_build_object('id', x.learner_id, 'name', p.username) || monitor_stats(array[x.learner_id], p_grain, false)
                    order by lower(p.username)), '[]'::jsonb)
      into rows_j
      from pilot_participants x join profiles p on p.id = x.learner_id
     where x.class_id = c.id;
  end if;
  select count(*) into joined from enrolments where class_id = c.id and status = 'active';
  return monitor_mask(monitor_stats(monitor_ids(c.id, null, null), p_grain, true), named)
    || jsonb_build_object('id', c.id, 'name', c.name, 'grade', c.grade, 'school', c.school, 'school_id', c.school_id, 'logo', c.logo_url,
                          'region', c.region, 'region_id', c.region_id, 'named', named, 'learner_rows', rows_j,
                          'registrations', case when named or joined = 0 or joined >= 5
                                                then jsonb_build_object('joined', joined, 'with_consent', (select count(*) from pilot_participants where class_id = c.id))
                                                else jsonb_build_object('too_few', true) end);
end;
$$;

create or replace function public.monitor_school(p_school uuid, p_grain text default 'week')
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me jsonb := monitor_me();
  s record;
  sees text;
  named boolean;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  select sc.id, sc.name, sc.setting, sc.region_id, sc.logo_url, r.name region into s
    from schools sc left join regions r on r.id = sc.region_id where sc.id = p_school;
  if s.id is null then raise exception 'School not found.'; end if;
  sees := monitor_sees(me, null, s.id, s.region_id);
  if sees is null then raise exception 'You do not have access to this school.'; end if;
  named := sees = 'named';
  return monitor_mask(monitor_stats(monitor_ids(null, s.id, null), p_grain, true), named)
    || jsonb_build_object('id', s.id, 'name', s.name, 'setting', s.setting, 'region', s.region, 'region_id', s.region_id,
         'logo', s.logo_url, 'named', named,
         'registrations', monitor_reg_mask(monitor_reg(monitor_reg_ids(s.id, null), p_grain, true), named),
         'reg_classes', monitor_reg_classes(s.id, named),
         'children', coalesce((select jsonb_agg(jsonb_build_object('kind', 'class', 'id', cl.id, 'name', cl.name, 'grade', cl.grade)
                                        || monitor_mask(monitor_stats(monitor_ids(cl.id, null, null), p_grain, false), named)
                                        order by cl.grade, cl.name)
                                 from classes cl where cl.school_id = s.id and cl.pilot), '[]'::jsonb));
end;
$$;

create or replace function public.monitor_region(p_region smallint, p_grain text default 'week')
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me jsonb := monitor_me();
  rname text;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  select name into rname from regions where id = p_region;
  if rname is null then raise exception 'Region not found.'; end if;
  if monitor_sees(me, null, null, p_region) is null then raise exception 'You do not have access to this region.'; end if;
  return monitor_mask(monitor_stats(monitor_ids(null, null, p_region), p_grain, true), false)
    || jsonb_build_object('id', p_region, 'name', rname,
         'registrations', monitor_reg_mask(monitor_reg(monitor_reg_ids(null, p_region), p_grain, true), false),
         'settings', jsonb_build_object(
            'rural', monitor_mask(monitor_stats(monitor_ids(null, null, p_region, 'rural'), p_grain, false), false),
            'urban', monitor_mask(monitor_stats(monitor_ids(null, null, p_region, 'urban'), p_grain, false), false)),
         'children', coalesce((select jsonb_agg(jsonb_build_object('kind', 'school', 'id', sc.id, 'name', sc.name, 'setting', sc.setting, 'in_pilot', sc.in_pilot,
                                                   'registered', monitor_reg_mask(monitor_reg(monitor_reg_ids(sc.id, null), p_grain, false), false))
                                        || monitor_mask(monitor_stats(monitor_ids(null, sc.id, null), p_grain, false), false)
                                        order by sc.name)
                                 from schools sc
                                where sc.region_id = p_region
                                  and (sc.in_pilot or exists (select 1 from profiles p where p.school_id = sc.id and p.role <> 'admin'))), '[]'::jsonb));
end;
$$;

create or replace function public.monitor_country(p_grain text default 'week')
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me jsonb := monitor_me();
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  if not coalesce((me->>'national')::boolean, false) then raise exception 'Only national officials can see the whole country.'; end if;
  return monitor_mask(monitor_stats(monitor_ids(null, null, null), p_grain, true), false)
    || jsonb_build_object('name', 'Namibia',
         'registrations', monitor_reg_mask(monitor_reg(monitor_reg_ids(null, null, true), p_grain, true), false),
         'no_school', (select count(*) from profiles where school_id is null and role = 'learner' and coalesce(country, 'Namibia') = 'Namibia'),
         'settings', jsonb_build_object(
            'rural', monitor_mask(monitor_stats(monitor_ids(null, null, null, 'rural'), p_grain, false), false),
            'urban', monitor_mask(monitor_stats(monitor_ids(null, null, null, 'urban'), p_grain, false), false)),
         'children', (select jsonb_agg(jsonb_build_object('kind', 'region', 'id', r.id, 'name', r.name,
                                         'schools', (select count(*) from schools sc where sc.region_id = r.id and sc.in_pilot),
                                         'registered', monitor_reg_mask(monitor_reg(monitor_reg_ids(null, r.id), p_grain, false), false))
                                        || monitor_mask(monitor_stats(monitor_ids(null, null, r.id), p_grain, false), false)
                                        order by r.name)
                        from regions r where r.country = 'NA'));
end;
$$;

-- ============ 9. Accounts: list, edit, rights, history ============
-- p_scope 'class' | 'school' | 'region' | 'country'; p_id the class, school or region (null for country).
create or replace function public.account_scope_check(p_scope text, p_id text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  cls uuid; sch uuid; reg smallint;
  cv jsonb;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  if p_scope = 'class' then
    cls := p_id::uuid;
    select c.school_id, s.region_id into sch, reg from classes c join schools s on s.id = c.school_id where c.id = cls;
  elsif p_scope = 'school' then
    sch := p_id::uuid;
    select region_id into reg from schools where id = sch;
  elsif p_scope = 'region' then
    reg := p_id::smallint;
  elsif p_scope <> 'country' then
    raise exception 'Unknown area.';
  end if;
  -- the actor must hold this exact area (or a larger one that contains it)
  select jsonb_build_object('rank', coalesce(max(case when x.source = 'administrator' then 5 else account_rank(x.scope) end), 0),
                            'grant_rank', coalesce(max(case when x.source = 'administrator' then 5 when x.can_grant then account_rank(x.scope) end), 0))
    into cv
    from account_scopes(me) x
   where account_rank(x.scope) >= account_rank(p_scope)
     and (x.source = 'administrator' or x.scope = 'country'
          or (x.scope = 'region' and x.region_id = reg)
          or (x.scope = 'school' and x.school_id = sch)
          or (x.scope = 'class' and x.class_id = cls));
  if (cv->>'rank')::int = 0 then raise exception 'You do not manage accounts here.'; end if;
  return cv || jsonb_build_object('class_id', cls, 'school_id', sch, 'region_id', reg, 'scope', p_scope);
end;
$$;

create or replace function public.account_list(p_scope text, p_id text default null, p_search text default null, p_role text default null, p_page int default 0)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  sc jsonb := account_scope_check(p_scope, p_id);
  q text := '%' || lower(trim(coalesce(p_search, ''))) || '%';
  learners_here boolean;
  rows_j jsonb;
  total int;
begin
  -- learners are listed only for class and school managers (and administrators)
  learners_here := (sc->>'rank')::int = 5
    or (p_scope in ('class', 'school')
        and (account_cover(me, (sc->>'class_id')::uuid, (sc->>'school_id')::uuid, null, true)->>'rank')::int >= 1);
  with pool as (
    select p.*, pl.class_id pl_class, pl.school_id pl_school, pl.region_id pl_region
      from profiles p cross join lateral account_place(p.id) pl
     where p.id <> me and p.role <> 'admin'
       and case p_scope
             when 'class' then pl.class_id = (sc->>'class_id')::uuid
             when 'school' then pl.school_id = (sc->>'school_id')::uuid
             when 'region' then pl.region_id = (sc->>'region_id')::smallint
                                or exists (select 1 from monitor_officials o where o.user_id = p.id and o.region_id = (sc->>'region_id')::smallint)
                                or exists (select 1 from account_rights r where r.user_id = p.id and r.region_id = (sc->>'region_id')::smallint)
             else true end
       and (learners_here or p.role not in ('learner', 'parent'))
       and (p_role is null or p_role = '' or p.role = p_role
            or (p_role = 'leader' and p.role in ('principal', 'hod', 'school_admin')))
       and (q = '%%' or lower(p.username) like q or lower(coalesce(p.learner_uid, '')) like q
            or coalesce(p.phone_e164, '') like '%' || regexp_replace(coalesce(p_search, ''), '\D', '', 'g') || '%' and length(regexp_replace(coalesce(p_search, ''), '\D', '', 'g')) >= 4)
  ), counted as (select count(*)::int n from pool)
  select (select n from counted),
         coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id, 'name', x.username, 'role', x.role, 'grade', x.grade, 'class_letter', x.class_letter,
           'school', s.name, 'school_id', x.pl_school, 'class', c.name, 'k12_id', x.learner_uid, 'phone', x.phone,
           'email', case when u.email like '%@learners.k12edu.io' or u.email like '%@staff.k12edu.io' then null else u.email end,
           'joined', x.created_at, 'last_sign_in', u.last_sign_in_at,
           'disabled', coalesce(u.banned_until > now(), false),
           'temporary_password', coalesce((u.raw_app_meta_data->>'must_change_password')::boolean, false),
           'rights', coalesce((select jsonb_agg(jsonb_build_object('id', z.right_id, 'scope', z.scope, 'source', z.source, 'can_grant', z.can_grant,
                                     'name', case z.scope when 'class' then zc.name when 'school' then zs.name when 'region' then zr.name || ' Region' else 'Namibia' end))
                               from account_scopes(x.id) z left join classes zc on zc.id = z.class_id left join schools zs on zs.id = z.school_id
                               left join regions zr on zr.id = z.region_id), '[]'::jsonb),
           'can_manage', account_can_manage(me, x.id) > 0) order by lower(x.username)), '[]'::jsonb)
    into total, rows_j
    from (select * from pool order by lower(username) limit 50 offset greatest(coalesce(p_page, 0), 0) * 50) x
    left join auth.users u on u.id = x.id
    left join schools s on s.id = x.pl_school
    left join classes c on c.id = x.pl_class;
  return jsonb_build_object('total', coalesce(total, 0), 'page', coalesce(p_page, 0), 'rows', rows_j,
                            'learners_shown', learners_here, 'rank', sc->'rank', 'grant_rank', sc->'grant_rank',
                            'counts', (select jsonb_build_object('learners', count(*) filter (where p.role = 'learner'),
                                                                 'staff', count(*) filter (where p.role not in ('learner', 'parent')))
                                         from profiles p cross join lateral account_place(p.id) pl
                                        where p.role <> 'admin' and case p_scope
                                              when 'class' then pl.class_id = (sc->>'class_id')::uuid
                                              when 'school' then pl.school_id = (sc->>'school_id')::uuid
                                              when 'region' then pl.region_id = (sc->>'region_id')::smallint
                                              else true end));
end;
$$;

create or replace function public.account_log(p_action text, p_target uuid, p_details jsonb, p_status text default 'done')
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  pl record;
  id_ bigint;
begin
  select * into pl from account_place(p_target);
  insert into account_audit (actor, action, target, target_name, school_id, region_id, details, status)
  values (auth.uid(), p_action, p_target, (select username from profiles where id = p_target),
          coalesce(pl.school_id, (p_details->>'school_id')::uuid),
          coalesce(pl.region_id, (select region_id from schools where id = (p_details->>'school_id')::uuid), (p_details->>'region_id')::smallint),
          coalesce(p_details, '{}'::jsonb), p_status)
  returning id into id_;
  return id_;
end;
$$;

create or replace function public.account_update(p_user uuid, p jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  rank_ int := account_can_manage(me, p_user);
  t profiles;
  new_school uuid;
  changes jsonb := '{}'::jsonb;
begin
  if rank_ = 0 then raise exception 'You cannot change this account.'; end if;
  select * into t from profiles where id = p_user;
  perform set_config('k12.trusted_write', 'on', true);
  if p ? 'name' and trim(p->>'name') is distinct from t.username then
    if length(trim(coalesce(p->>'name', ''))) not between 2 and 80 then raise exception 'Names need 2 to 80 characters.'; end if;
    update profiles set username = trim(p->>'name') where id = p_user;
    changes := changes || jsonb_build_object('name', jsonb_build_array(t.username, trim(p->>'name')));
  end if;
  if p ? 'grade' and (p->>'grade')::int is distinct from t.grade then
    if p->>'grade' is not null and (p->>'grade')::int not between 8 and 12 then raise exception 'Grades run from 8 to 12.'; end if;
    update profiles set grade = (p->>'grade')::int where id = p_user;
    changes := changes || jsonb_build_object('grade', jsonb_build_array(t.grade, p->'grade'));
  end if;
  if p ? 'class_letter' and upper(p->>'class_letter') is distinct from t.class_letter then
    if p->>'class_letter' is not null and upper(p->>'class_letter') !~ '^[A-L]$' then raise exception 'Class letters run from A to L.'; end if;
    update profiles set class_letter = upper(p->>'class_letter') where id = p_user;
    changes := changes || jsonb_build_object('class_letter', jsonb_build_array(t.class_letter, upper(p->>'class_letter')));
  end if;
  if p ? 'phone' and nullif(trim(coalesce(p->>'phone', '')), '') is distinct from t.phone then
    if p->>'phone' is not null and length(regexp_replace(p->>'phone', '\D', '', 'g')) not between 7 and 15 then
      raise exception 'That mobile number does not look right.';
    end if;
    update profiles set phone = nullif(trim(p->>'phone'), '') where id = p_user;
    changes := changes || jsonb_build_object('phone', 'changed');
  end if;
  if p ? 'school_id' then
    new_school := (p->>'school_id')::uuid;
    if new_school is distinct from t.school_id then
      if (account_cover(me, null, new_school, (select region_id from schools where id = new_school), t.role in ('learner', 'parent'))->>'rank')::int < 2 then
        raise exception 'You can only move accounts to a school you manage.';
      end if;
      update profiles set school_id = new_school where id = p_user;
      changes := changes || jsonb_build_object('school', jsonb_build_array((select name from schools where id = t.school_id), (select name from schools where id = new_school)));
    end if;
  end if;
  if p ? 'role' and p->>'role' is distinct from t.role then
    if t.role in ('learner', 'parent') or p->>'role' not in ('educator', 'hod', 'principal', 'school_admin') then
      raise exception 'Only staff roles can be changed here: teacher, head of department, principal or school administrator.';
    end if;
    if p->>'role' <> 'educator' and rank_ <= 2 then
      raise exception 'Only regional or national managers can make someone a school leader.';
    end if;
    update profiles set role = p->>'role' where id = p_user;
    changes := changes || jsonb_build_object('role', jsonb_build_array(t.role, p->>'role'));
  end if;
  if changes <> '{}'::jsonb then perform account_log('edit', p_user, changes); end if;
  return jsonb_build_object('ok', true, 'changed', (select coalesce(jsonb_agg(k), '[]'::jsonb) from jsonb_object_keys(changes) k));
end;
$$;

create or replace function public.account_grant(p_identifier text, p_scope text, p_id text default null, p_can_grant boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  sc jsonb := account_scope_check(p_scope, p_id);
  uid uuid;
  t profiles;
  pl record;
begin
  if (sc->>'grant_rank')::int < account_rank(p_scope) then raise exception 'You cannot give rights here.'; end if;
  if p_can_grant and (sc->>'grant_rank')::int <= account_rank(p_scope) then
    raise exception 'You can give rights for this area, but only someone above it can let others give rights too.';
  end if;
  uid := pilot_find_profile(p_identifier);
  if uid is null then raise exception 'No account found for %. They must sign up at k12plus.app first.', p_identifier; end if;
  if uid = me then raise exception 'You cannot change your own rights.'; end if;
  select * into t from profiles where id = uid;
  if t.role in ('learner', 'parent') then raise exception '% is a % account. Only staff can be given rights.', t.username, t.role; end if;
  select * into pl from account_place(uid);
  if p_scope in ('class', 'school') and pl.school_id is distinct from (sc->>'school_id')::uuid then
    raise exception '% does not belong to this school. Move their account to the school first.', t.username;
  end if;
  if p_scope = 'region' and pl.region_id is not null and pl.region_id <> (sc->>'region_id')::smallint then
    raise exception '% works at a school in another region.', t.username;
  end if;
  if account_seniority(uid) >= (sc->>'grant_rank')::int then
    raise exception '% already holds rights as senior as yours.', t.username;
  end if;
  insert into account_rights (user_id, scope, class_id, school_id, region_id, can_grant, granted_by)
  values (uid, p_scope, (sc->>'class_id')::uuid, case when p_scope = 'school' then (sc->>'school_id')::uuid end,
          case when p_scope = 'region' then (sc->>'region_id')::smallint end, p_can_grant, me)
  on conflict (user_id, scope, coalesce(class_id::text, school_id::text, region_id::text, 'all'))
  do update set can_grant = excluded.can_grant, granted_by = excluded.granted_by, granted_at = now();
  perform account_log('grant', uid, jsonb_build_object('scope', p_scope, 'area', p_id, 'can_grant', p_can_grant,
                                                       'school_id', sc->>'school_id', 'region_id', sc->>'region_id'));
  return jsonb_build_object('ok', true, 'name', t.username);
end;
$$;

create or replace function public.account_revoke(p_right bigint)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  r account_rights;
  sc jsonb;
begin
  select * into r from account_rights where id = p_right;
  if not found then raise exception 'That right no longer exists.'; end if;
  if r.user_id = me then raise exception 'You cannot change your own rights.'; end if;
  sc := account_scope_check(r.scope, coalesce(r.class_id::text, r.school_id::text, r.region_id::text));
  if (sc->>'grant_rank')::int < account_rank(r.scope) or (r.can_grant and (sc->>'grant_rank')::int <= account_rank(r.scope)) then
    raise exception 'You cannot remove this right.';
  end if;
  delete from account_rights where id = p_right;
  perform account_log('revoke', r.user_id, jsonb_build_object('scope', r.scope, 'school_id', r.school_id, 'region_id', r.region_id));
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.account_history(p_scope text, p_id text default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  sc jsonb := account_scope_check(p_scope, p_id);
  learners_ok boolean;
begin
  -- learner and parent names only for those who look after learners here
  learners_ok := (sc->>'rank')::int = 5
    or (p_scope in ('class', 'school')
        and (account_cover(me, (sc->>'class_id')::uuid, (sc->>'school_id')::uuid, null, true)->>'rank')::int >= 1);
  return coalesce((select jsonb_agg(jsonb_build_object(
             'at', a.at, 'action', a.action, 'by', pa.username, 'status', a.status,
             'target', case when pt.role in ('learner', 'parent') and not learners_ok then 'a ' || pt.role else a.target_name end,
             'fields', case when a.action = 'edit' then (select jsonb_agg(k) from jsonb_object_keys(a.details) k) end,
             'scope', a.details->>'scope') order by a.at desc)
                     from (select * from account_audit a
                            where a.status <> 'requested'
                              and case p_scope when 'country' then true
                                               when 'region' then a.region_id = (sc->>'region_id')::smallint
                                               when 'school' then a.school_id = (sc->>'school_id')::uuid
                                               else a.school_id = (sc->>'school_id')::uuid and exists (
                                                      select 1 from enrolments e where e.learner_id = a.target and e.class_id = (sc->>'class_id')::uuid) end
                            order by a.at desc limit 100) a
                     left join profiles pa on pa.id = a.actor
                     left join profiles pt on pt.id = a.target), '[]'::jsonb);
end;
$$;

-- Schools in an area, for the "add user" and "move to school" choices.
create or replace function public.account_schools(p_scope text, p_id text default null, p_search text default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  sc jsonb := account_scope_check(p_scope, p_id);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'region', r.name,
                                     'classes', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.grade), '[]'::jsonb)
                                                   from classes c where c.school_id = s.id and c.pilot)) order by s.name)
                     from (select * from schools s
                            where case p_scope when 'country' then true
                                               when 'region' then s.region_id = (sc->>'region_id')::smallint
                                               else s.id = (sc->>'school_id')::uuid end
                              and (p_search is null or s.name ilike '%' || p_search || '%')
                            order by s.name limit 40) s
                     left join regions r on r.id = s.region_id), '[]'::jsonb);
end;
$$;

-- ============ 10. Steps the account-admin service takes ============
-- The service calls account_authorise as the signed-in manager (so every rule above
-- applies), does the sign-in work with Supabase Auth, then calls account_finish.
create or replace function public.account_authorise(p_action text, p_target uuid default null, p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  t profiles;
  cv jsonb;
  sch uuid := (p->>'school_id')::uuid;
  cls uuid := nullif(p->>'class_id', '')::uuid;
  reg smallint;
  role_ text := coalesce(p->>'role', 'learner');
  uid text;
  chars constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  i int;
  d jsonb;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  if p_action in ('reset_password', 'disable', 'enable') then
    if account_can_manage(me, p_target) = 0 then raise exception 'You cannot change this account.'; end if;
    return jsonb_build_object('ok', true, 'audit_id', account_log(p_action, p_target, '{}'::jsonb, 'requested'));
  end if;

  if p_action = 'logo' then
    cv := account_cover(me, null, sch, (select region_id from schools where id = sch));
    if sch is null or (cv->>'rank')::int < 2 then raise exception 'Only school managers can change the school logo.'; end if;
    return jsonb_build_object('ok', true, 'audit_id', account_log('logo', null, jsonb_build_object('school_id', sch), 'requested'));
  end if;

  if p_action = 'create' then
    if role_ not in ('learner', 'educator') then raise exception 'New accounts here are for learners or teachers.'; end if;
    select region_id into reg from schools where id = sch;
    if not found then raise exception 'Choose the school first.'; end if;
    if cls is not null and not exists (select 1 from classes where id = cls and school_id = sch and pilot) then
      raise exception 'That class is not at this school.';
    end if;
    if cls is not null and role_ <> 'learner' then raise exception 'Only learners join a class here.'; end if;
    if cls is not null and p->>'grade' is not null and (p->>'grade')::int <> (select grade from classes where id = cls) then
      raise exception 'That class is for Grade % learners.', (select grade from classes where id = cls);
    end if;
    cv := account_cover(me, cls, sch, reg, role_ = 'learner');
    if role_ = 'learner' and (cv->>'rank')::int < 1 then raise exception 'You cannot add learners here.'; end if;
    if role_ = 'learner' and cls is null and (cv->>'rank')::int < 2 then raise exception 'Choose the class to add the learner to.'; end if;
    if role_ = 'educator' and (cv->>'rank')::int < 2 then raise exception 'Only school managers and above can add teachers.'; end if;
    if length(trim(coalesce(p->>'name', ''))) not between 2 and 80 then raise exception 'Names need 2 to 80 characters.'; end if;
    if p->>'grade' is not null and (p->>'grade')::int not between 8 and 12 then raise exception 'Grades run from 8 to 12.'; end if;
    if p->>'class_letter' is not null and upper(p->>'class_letter') !~ '^[A-L]$' then raise exception 'Class letters run from A to L.'; end if;
    if nullif(p->>'phone', '') is not null and length(regexp_replace(p->>'phone', '\D', '', 'g')) not between 7 and 15 then
      raise exception 'That mobile number does not look right.';
    end if;
    if nullif(p->>'email', '') is not null and p->>'email' !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'That email address does not look right.'; end if;
    loop
      uid := 'K12-NA-';
      for i in 1..6 loop uid := uid || substr(chars, 1 + floor(random() * 36)::int, 1); end loop;
      exit when not exists (select 1 from profiles where learner_uid = uid);
    end loop;
    d := jsonb_build_object('role', role_, 'name', trim(p->>'name'), 'school_id', sch, 'class_id', cls, 'region_id', reg,
                            'grade', (p->>'grade')::int, 'class_letter', upper(nullif(p->>'class_letter', '')),
                            'phone', nullif(trim(coalesce(p->>'phone', '')), ''), 'learner_uid', uid,
                            'email', coalesce(nullif(lower(trim(coalesce(p->>'email', ''))), ''),
                                              lower(uid) || case when role_ = 'learner' then '@learners.k12edu.io' else '@staff.k12edu.io' end));
    return d || jsonb_build_object('ok', true, 'audit_id', account_log('create', null, d, 'requested'));
  end if;
  raise exception 'Unknown action.';
end;
$$;

-- Service only: record the outcome, and for a new account write its profile.
create or replace function public.account_finish(p_audit bigint, p_ok boolean, p_result jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  a account_audit;
  d jsonb;
  nid uuid := (p_result->>'user_id')::uuid;
begin
  select * into a from account_audit where id = p_audit and status = 'requested';
  if not found then raise exception 'Unknown request.'; end if;
  d := a.details;
  if p_ok and a.action = 'create' then
    perform set_config('k12.trusted_write', 'on', true);
    insert into profiles (id, username, role, grade, class_letter, school_id, phone, learner_uid, country)
    values (nid, d->>'name', d->>'role', (d->>'grade')::int, d->>'class_letter', (d->>'school_id')::uuid, d->>'phone', d->>'learner_uid', 'Namibia');
    if d->>'class_id' is not null then
      perform pilot_enrol((d->>'class_id')::uuid, nid, 'teacher');
    end if;
    update account_audit set target = nid, target_name = d->>'name', details = d - 'email' where id = p_audit;
  end if;
  if p_ok and a.action = 'logo' then
    update schools set logo_url = p_result->>'url' where id = (d->>'school_id')::uuid;
  end if;
  update account_audit set status = case when p_ok then 'done' else 'failed' end,
                           details = details || case when p_ok then '{}'::jsonb else jsonb_build_object('error', left(p_result->>'error', 200)) end
   where id = p_audit;
  return jsonb_build_object('ok', true);
end;
$$;

-- ============ 11. Who may call what ============
do $$
declare f text;
begin
  -- internal helpers: not callable through the API
  foreach f in array array[
    'account_scopes(uuid)', 'account_place(uuid)', 'account_cover(uuid, uuid, uuid, smallint, boolean)', 'account_seniority(uuid)',
    'account_can_manage(uuid, uuid)', 'account_scope_check(text, text)', 'account_log(text, uuid, jsonb, text)',
    'monitor_window(text)', 'monitor_stats(uuid[], text, boolean)', 'monitor_reg_ids(uuid, smallint, boolean)',
    'monitor_reg(uuid[], text, boolean)', 'monitor_reg_mask(jsonb, boolean)', 'monitor_reg_classes(uuid, boolean)',
    'monitor_me()', 'monitor_sees(jsonb, uuid, uuid, smallint)', 'account_finish(bigint, boolean, jsonb)']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
  execute 'grant execute on function public.account_finish(bigint, boolean, jsonb) to service_role';
  -- the screens call these; each checks the caller itself
  foreach f in array array[
    'monitor_whoami()', 'monitor_learner(uuid, text)', 'monitor_class(uuid, text)', 'monitor_school(uuid, text)',
    'monitor_region(smallint, text)', 'monitor_country(text)',
    'account_list(text, text, text, text, int)', 'account_update(uuid, jsonb)', 'account_grant(text, text, text, boolean)',
    'account_revoke(bigint)', 'account_history(text, text)', 'account_schools(text, text, text)',
    'account_authorise(text, uuid, jsonb)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

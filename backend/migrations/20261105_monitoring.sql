-- K12Plus monitoring (monitor.k12plus.app), 5 November 2026
--
-- Additive only: one new table (monitor_officials) and new monitor_* functions.
-- No existing data is changed or removed, and nothing new is recorded about learners:
-- every figure is read from the learning record and the pilot tests that already exist.
--
-- Who sees what
--   * a learner sees their own progress;
--   * a teacher sees each learner in the classes they teach, by name;
--   * a principal, head of department or school administrator sees their school,
--     its classes and each learner in it, by name;
--   * a regional champion and a regional education official see their region,
--     its schools and classes, with no learner names;
--   * a national official (Ministry of Education, Arts and Culture) and K-12 EdTech
--     administrators see the whole country, regions, schools and classes, with no
--     learner names.
-- Officials never see a learner's name, and a school or class with fewer than five
-- learners shows its number of learners only, so nobody can be picked out.
--
-- Consent comes first: only learners in pilot_participants (enrolled, with school and
-- parent or guardian consent) are counted anywhere. A learner whose consent is
-- withdrawn disappears from every view at once.

-- ============ 1. Officials ============
-- A person with an account (they sign up at k12plus.app first) is given access by a
-- K-12 EdTech administrator. region_id null means national.
create table if not exists public.monitor_officials (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  region_id smallint references public.regions(id),
  title text check (length(title) <= 120),
  added_by uuid references public.profiles(id) on delete set null,
  added_at timestamptz not null default now()
);
alter table public.monitor_officials enable row level security;

-- ============ 2. Internal helpers ============
-- What the caller may see. Returns null for someone who is not signed in.
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
    'id', p.id, 'name', p.username, 'role', p.role,
    'admin', p.role = 'admin',
    'leader_school', case when p.role in ('principal', 'hod', 'school_admin') then p.school_id end,
    'champion_region', p.champion_region_id,
    'official', o.user_id is not null,
    'official_region', o.region_id,
    'national', p.role = 'admin' or (o.user_id is not null and o.region_id is null)
                or (p.role = 'ministry' and o.user_id is null));
end;
$$;

-- Figures for a group of learners over the last p_weeks weeks (Monday to Sunday,
-- Namibian time, this week included). p_detail adds the weekly trend and topics.
create or replace function public.monitor_stats(p_ids uuid[], p_weeks int, p_detail boolean default true)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  tz constant text := 'Africa/Windhoek';
  today date := (now() at time zone tz)::date;
  wk_this date := today - (extract(isodow from today)::int - 1);
  wks int := least(greatest(coalesce(p_weeks, 12), 1), 52);
  wk0 date := wk_this - 7 * (wks - 1);
  t0 timestamptz := wk0::timestamp at time zone tz;
  n int := coalesce(cardinality(p_ids), 0);
  base jsonb;
  weekly jsonb;
  topics jsonb;
  tests jsonb;
begin
  with ev as (
    select le.* from learning_events le
     where le.learner_id = any (p_ids) and le.occurred_at >= t0 and le.kind <> 'data'
  ), lastseen as (
    select max(le.occurred_at) at_ts from learning_events le where le.learner_id = any (p_ids) and le.kind <> 'data'
  )
  select jsonb_build_object(
    'learners', n,
    'active_week', (select count(distinct learner_id) from ev where occurred_at >= now() - interval '7 days'),
    'active_period', (select count(distinct learner_id) from ev),
    'minutes', (select round(coalesce(sum(duration_seconds), 0) / 60.0) from ev where kind = 'active'),
    'questions', (select count(*) from ev where kind in ('question', 'ussd')),
    'lessons', (select count(*) from ev where kind = 'lesson'),
    'attempted', (select coalesce(sum(attempted), 0) from ev where kind in ('quiz', 'game', 'practice')),
    'correct', (select coalesce(sum(correct), 0) from ev where kind in ('quiz', 'game', 'practice')),
    'topics_practised', (select count(distinct topic) from ev where topic is not null and kind in ('quiz', 'game', 'practice', 'lesson', 'question')),
    'last_active', (select at_ts from lastseen))
  into base;
  base := base || jsonb_build_object('accuracy',
    case when (base->>'attempted')::int > 0 then round(100.0 * (base->>'correct')::int / (base->>'attempted')::int) end);

  -- baseline and endline tests: average score as a percentage
  select coalesce(jsonb_object_agg(purpose, jsonb_build_object('sat', sat, 'average', avg_pct)), '{}'::jsonb)
    into tests
    from (select t.purpose, count(*)::int sat,
                 round(avg(100.0 * a.score / nullif(a.max_score, 0)))::int avg_pct
            from test_attempts a join tests t on t.id = a.test_id
           where a.learner_id = any (p_ids) and a.submitted_at is not null
           group by t.purpose) x;
  base := base || jsonb_build_object('tests', tests);

  if p_detail then
    select jsonb_agg(jsonb_build_object(
             'week', w.d::date, 'active', coalesce(x.active, 0), 'minutes', coalesce(x.minutes, 0),
             'questions', coalesce(x.questions, 0), 'attempted', coalesce(x.att, 0),
             'accuracy', case when coalesce(x.att, 0) > 0 then round(100.0 * x.cor / x.att) end) order by w.d)
      into weekly
      from generate_series(wk0, wk_this, interval '7 days') w(d)
      left join (
        select (date_trunc('week', (occurred_at at time zone tz)))::date wk,
               count(distinct learner_id)::int active,
               round(coalesce(sum(duration_seconds) filter (where kind = 'active'), 0) / 60.0)::int minutes,
               count(*) filter (where kind in ('question', 'ussd'))::int questions,
               coalesce(sum(attempted) filter (where kind in ('quiz', 'game', 'practice')), 0)::int att,
               coalesce(sum(correct) filter (where kind in ('quiz', 'game', 'practice')), 0)::int cor
          from learning_events
         where learner_id = any (p_ids) and occurred_at >= t0 and kind <> 'data'
         group by 1) x on x.wk = w.d::date;

    select coalesce(jsonb_agg(jsonb_build_object(
             'subject', subject, 'topic', topic, 'learners', learners, 'attempted', att, 'correct', cor,
             'accuracy', round(100.0 * cor / att), 'last', last_at) order by round(100.0 * cor / att), att desc), '[]'::jsonb)
      into topics
      from (select coalesce(subject, 'Mathematics') subject, topic, count(distinct learner_id)::int learners,
                   sum(attempted)::int att, sum(correct)::int cor, max(occurred_at) last_at
              from learning_events
             where learner_id = any (p_ids) and occurred_at >= t0 and topic is not null
               and kind in ('quiz', 'game', 'practice') and attempted > 0
             group by 1, 2) y;
    base := base || jsonb_build_object('weeks', wks, 'from', wk0, 'weekly', weekly, 'topics', topics);
  end if;
  return base;
end;
$$;

-- Officials never see figures for fewer than five learners.
create or replace function public.monitor_mask(p jsonb, p_named boolean)
returns jsonb
language sql immutable as $$
  select case when p_named or coalesce((p->>'learners')::int, 0) >= 5 then p
              else jsonb_build_object('learners', p->'learners', 'too_few', true) end;
$$;

create or replace function public.monitor_ids(p_class uuid, p_school uuid, p_region smallint, p_setting text default null)
returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(learner_id), '{}') from pilot_participants
   where (p_class is null or class_id = p_class)
     and (p_school is null or school_id = p_school)
     and (p_region is null or region_id = p_region)
     and (p_setting is null or setting = p_setting);
$$;

-- ============ 3. What the caller can open ============
create or replace function public.monitor_whoami()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me jsonb := monitor_me();
  v jsonb := '[]'::jsonb;
  rid smallint;
begin
  if me is null then return jsonb_build_object('signed_in', false); end if;
  if me->>'role' = 'learner' then
    v := v || jsonb_build_array(jsonb_build_object('kind', 'learner', 'name', 'My progress',
                                 'taking_part', pilot_active((me->>'id')::uuid)));
  end if;
  v := v || coalesce((select jsonb_agg(jsonb_build_object('kind', 'class', 'id', c.id, 'name', c.name, 'school', s.name) order by s.name, c.name)
                        from class_teachers ct join classes c on c.id = ct.class_id join schools s on s.id = c.school_id
                       where ct.teacher_id = (me->>'id')::uuid and c.pilot), '[]'::jsonb);
  if me->>'leader_school' is not null then
    v := v || jsonb_build_array(jsonb_build_object('kind', 'school', 'id', me->>'leader_school',
                                 'name', (select name from schools where id = (me->>'leader_school')::uuid)));
  end if;
  foreach rid in array array_remove(array[(me->>'champion_region')::smallint, (me->>'official_region')::smallint], null) loop
    if not v @> jsonb_build_array(jsonb_build_object('kind', 'region', 'id', rid)) then
      v := v || jsonb_build_array(jsonb_build_object('kind', 'region', 'id', rid, 'name', (select name from regions where id = rid)));
    end if;
  end loop;
  if (me->>'national')::boolean then
    v := v || jsonb_build_array(jsonb_build_object('kind', 'country', 'name', 'Namibia'));
  end if;
  return jsonb_build_object('signed_in', true, 'name', me->>'name', 'admin', (me->>'admin')::boolean,
                            'title', (select title from monitor_officials where user_id = (me->>'id')::uuid), 'views', v);
end;
$$;

-- ============ 4. A learner ============
create or replace function public.monitor_learner(p_learner uuid default null, p_weeks int default 12)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me jsonb := monitor_me();
  lid uuid;
  pp record;
  st jsonb;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  lid := coalesce(p_learner, (me->>'id')::uuid);
  select x.*, c.name class_name, s.name school_name into pp
    from pilot_participants x join classes c on c.id = x.class_id join schools s on s.id = x.school_id
   where x.learner_id = lid;
  if lid <> (me->>'id')::uuid then
    if pp.learner_id is null
       or not (exists (select 1 from class_teachers where class_id = pp.class_id and teacher_id = (me->>'id')::uuid)
               or coalesce((me->>'leader_school')::uuid = pp.school_id, false)) then
      raise exception 'You can only open learners in your own classes or school.';
    end if;
  end if;
  if pp.learner_id is null then
    return jsonb_build_object('taking_part', false, 'name', me->>'name');
  end if;
  st := monitor_stats(array[lid], p_weeks, true);
  return st || jsonb_build_object(
    'taking_part', true, 'name', (select username from profiles where id = lid),
    'class', pp.class_name, 'school', pp.school_name, 'grade', pp.grade,
    'class_id', case when lid <> (me->>'id')::uuid then pp.class_id end,
    'test_results', coalesce((select jsonb_agg(jsonb_build_object('purpose', t.purpose, 'title', t.title, 'score', a.score, 'max', a.max_score,
                                    'percent', round(100.0 * a.score / nullif(a.max_score, 0)), 'on', (a.submitted_at at time zone 'Africa/Windhoek')::date)
                                    order by a.submitted_at)
                                from test_attempts a join tests t on t.id = a.test_id
                               where a.learner_id = lid and a.submitted_at is not null), '[]'::jsonb));
end;
$$;

-- ============ 5. A class ============
create or replace function public.monitor_class(p_class uuid, p_weeks int default 12)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me jsonb := monitor_me();
  c record;
  named boolean;
  agg boolean;
  ids uuid[];
  st jsonb;
  rows_j jsonb := null;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  select cl.id, cl.name, cl.grade, cl.school_id, s.name school, s.region_id, r.name region into c
    from classes cl join schools s on s.id = cl.school_id left join regions r on r.id = s.region_id
   where cl.id = p_class and cl.pilot;
  if c.id is null then raise exception 'Class not found.'; end if;
  named := exists (select 1 from class_teachers where class_id = c.id and teacher_id = (me->>'id')::uuid)
           or coalesce((me->>'leader_school')::uuid = c.school_id, false);
  agg := coalesce((me->>'national')::boolean, false) or coalesce((me->>'champion_region')::smallint = c.region_id, false)
         or coalesce((me->>'official_region')::smallint = c.region_id, false);
  if not (named or agg) then raise exception 'You do not have access to this class.'; end if;
  ids := monitor_ids(c.id, null, null);
  st := monitor_mask(monitor_stats(ids, p_weeks, true), named);
  if named then
    select coalesce(jsonb_agg(jsonb_build_object('id', x.learner_id, 'name', p.username) || monitor_stats(array[x.learner_id], p_weeks, false)
                    order by lower(p.username)), '[]'::jsonb)
      into rows_j
      from pilot_participants x join profiles p on p.id = x.learner_id
     where x.class_id = c.id;
  end if;
  return st || jsonb_build_object('id', c.id, 'name', c.name, 'grade', c.grade, 'school', c.school, 'school_id', c.school_id,
                                  'region', c.region, 'region_id', c.region_id, 'named', named, 'learner_rows', rows_j);
end;
$$;

-- ============ 6. A school ============
create or replace function public.monitor_school(p_school uuid, p_weeks int default 12)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me jsonb := monitor_me();
  s record;
  named boolean;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  select sc.id, sc.name, sc.setting, sc.region_id, r.name region into s
    from schools sc left join regions r on r.id = sc.region_id where sc.id = p_school;
  if s.id is null then raise exception 'School not found.'; end if;
  named := coalesce((me->>'leader_school')::uuid = s.id, false);
  if not (named or coalesce((me->>'national')::boolean, false) or coalesce((me->>'champion_region')::smallint = s.region_id, false)
          or coalesce((me->>'official_region')::smallint = s.region_id, false)) then
    raise exception 'You do not have access to this school.';
  end if;
  return monitor_mask(monitor_stats(monitor_ids(null, s.id, null), p_weeks, true), named)
    || jsonb_build_object('id', s.id, 'name', s.name, 'setting', s.setting, 'region', s.region, 'region_id', s.region_id, 'named', named,
         'children', coalesce((select jsonb_agg(jsonb_build_object('kind', 'class', 'id', cl.id, 'name', cl.name, 'grade', cl.grade)
                                        || monitor_mask(monitor_stats(monitor_ids(cl.id, null, null), p_weeks, false), named)
                                        order by cl.grade, cl.name)
                                 from classes cl where cl.school_id = s.id and cl.pilot), '[]'::jsonb));
end;
$$;

-- ============ 7. A region ============
create or replace function public.monitor_region(p_region smallint, p_weeks int default 12)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me jsonb := monitor_me();
  rname text;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  select name into rname from regions where id = p_region;
  if rname is null then raise exception 'Region not found.'; end if;
  if not (coalesce((me->>'national')::boolean, false) or coalesce((me->>'champion_region')::smallint = p_region, false)
          or coalesce((me->>'official_region')::smallint = p_region, false)) then
    raise exception 'You do not have access to this region.';
  end if;
  return monitor_mask(monitor_stats(monitor_ids(null, null, p_region), p_weeks, true), false)
    || jsonb_build_object('id', p_region, 'name', rname,
         'settings', jsonb_build_object(
            'rural', monitor_mask(monitor_stats(monitor_ids(null, null, p_region, 'rural'), p_weeks, false), false),
            'urban', monitor_mask(monitor_stats(monitor_ids(null, null, p_region, 'urban'), p_weeks, false), false)),
         'children', coalesce((select jsonb_agg(jsonb_build_object('kind', 'school', 'id', sc.id, 'name', sc.name, 'setting', sc.setting)
                                        || monitor_mask(monitor_stats(monitor_ids(null, sc.id, null), p_weeks, false), false)
                                        order by sc.name)
                                 from schools sc where sc.region_id = p_region and sc.in_pilot), '[]'::jsonb));
end;
$$;

-- ============ 8. The whole country ============
create or replace function public.monitor_country(p_weeks int default 12)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me jsonb := monitor_me();
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  if not coalesce((me->>'national')::boolean, false) then raise exception 'Only national officials can see the whole country.'; end if;
  return monitor_mask(monitor_stats(monitor_ids(null, null, null), p_weeks, true), false)
    || jsonb_build_object('name', 'Namibia',
         'settings', jsonb_build_object(
            'rural', monitor_mask(monitor_stats(monitor_ids(null, null, null, 'rural'), p_weeks, false), false),
            'urban', monitor_mask(monitor_stats(monitor_ids(null, null, null, 'urban'), p_weeks, false), false)),
         'children', (select jsonb_agg(jsonb_build_object('kind', 'region', 'id', r.id, 'name', r.name,
                                         'schools', (select count(*) from schools sc where sc.region_id = r.id and sc.in_pilot))
                                        || monitor_mask(monitor_stats(monitor_ids(null, null, r.id), p_weeks, false), false)
                                        order by r.name)
                        from regions r where r.country = 'NA'));
end;
$$;

-- ============ 9. Administrators: give and remove access for officials ============
create or replace function public.monitor_officials_list()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not pilot_is_admin() then raise exception 'Only K-12 EdTech administrators can manage officials.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('user_id', o.user_id, 'name', p.username, 'title', o.title,
                                     'region_id', o.region_id, 'region', coalesce(r.name, 'National'), 'added_at', o.added_at)
                                     order by r.name nulls first, p.username)
                     from monitor_officials o join profiles p on p.id = o.user_id left join regions r on r.id = o.region_id), '[]'::jsonb);
end;
$$;

create or replace function public.monitor_add_official(p_identifier text, p_region smallint default null, p_title text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid;
  t profiles;
begin
  if not pilot_is_admin() then raise exception 'Only K-12 EdTech administrators can manage officials.'; end if;
  if p_region is not null and not exists (select 1 from regions where id = p_region) then raise exception 'Unknown region.'; end if;
  uid := pilot_find_profile(p_identifier);
  if uid is null then raise exception 'No account found for %. The official must sign up at k12plus.app first.', p_identifier; end if;
  select * into t from profiles where id = uid;
  if t.role = 'learner' then raise exception '% is registered as a learner, so cannot be given official access.', t.username; end if;
  insert into monitor_officials (user_id, region_id, title, added_by)
  values (uid, p_region, nullif(left(trim(coalesce(p_title, '')), 120), ''), auth.uid())
  on conflict (user_id) do update set region_id = excluded.region_id, title = excluded.title,
                                      added_by = excluded.added_by, added_at = now();
  return jsonb_build_object('ok', true, 'name', t.username);
end;
$$;

create or replace function public.monitor_remove_official(p_user uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not pilot_is_admin() then raise exception 'Only K-12 EdTech administrators can manage officials.'; end if;
  delete from monitor_officials where user_id = p_user;
  return jsonb_build_object('ok', found);
end;
$$;

-- ============ 10. Who may call what ============
revoke execute on function public.monitor_me() from public, anon, authenticated;
revoke execute on function public.monitor_stats(uuid[], int, boolean) from public, anon, authenticated;
revoke execute on function public.monitor_mask(jsonb, boolean) from public, anon, authenticated;
revoke execute on function public.monitor_ids(uuid, uuid, smallint, text) from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'monitor_whoami()', 'monitor_learner(uuid, int)', 'monitor_class(uuid, int)', 'monitor_school(uuid, int)',
    'monitor_region(smallint, int)', 'monitor_country(int)', 'monitor_officials_list()',
    'monitor_add_official(text, smallint, text)', 'monitor_remove_official(uuid)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

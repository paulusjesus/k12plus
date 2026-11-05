-- K12Plus Monitor, part 3 (6 November 2026): funders, funds and learners who need attention
--
-- Funders
--   * A funder organisation can have people with K12Plus accounts. They open K12Plus Monitor
--     and see the whole pilot as national officials do: figures only, never a learner's name,
--     and no group of fewer than five learners.
--   * Each funder sees how its own grants are being used: the budget, every expense K-12 EdTech
--     records against it, and the pilot's running costs (data, texts and USSD sessions, worked
--     out from the same records as the monthly pilot report, plus costs typed in there).
--     K-12 EdTech administrators enter funders, grants, budget lines and expenses, and see all.
--
-- Learners who need attention
--   * For a group of learners (with consent), the ones who have not been active for a week,
--     whose practice accuracy is below 40%, who scored below 40% at the start of the year, or
--     who keep getting a topic wrong. Teachers and principals see them by name; everyone else
--     sees only how many there are.
--
-- Additive only: new tables and functions. No existing data is changed or removed.

-- ============ 1. Funders, grants, budget lines, expenses ============
create table if not exists public.funders (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(name) between 2 and 120),
  website text,
  logo_url text,
  created_at timestamptz not null default now()
);
create table if not exists public.funder_users (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  funder_id uuid not null references public.funders(id) on delete cascade,
  added_by uuid references public.profiles(id) on delete set null,
  added_at timestamptz not null default now()
);
create table if not exists public.grants (
  id uuid primary key default gen_random_uuid(),
  funder_id uuid not null references public.funders(id) on delete cascade,
  title text not null check (length(title) between 2 and 160),
  currency text not null default 'NAD' check (currency in ('NAD', 'USD', 'ZAR', 'EUR', 'GBP')),
  per_usd numeric(10, 4) not null default 1 check (per_usd > 0), -- units of this currency for one US dollar
  amount numeric(14, 2) not null check (amount > 0),
  starts_on date not null,
  ends_on date not null,
  running_costs boolean not null default false, -- the pilot's data, text and USSD costs are paid from this grant
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  check (ends_on >= starts_on)
);
create table if not exists public.budget_lines (
  id bigint generated always as identity primary key,
  grant_id uuid not null references public.grants(id) on delete cascade,
  category text not null check (length(category) between 2 and 80),
  planned numeric(14, 2) not null check (planned >= 0),
  note text,
  unique (grant_id, category)
);
create table if not exists public.expenses (
  id bigint generated always as identity primary key,
  grant_id uuid not null references public.grants(id) on delete cascade,
  budget_line_id bigint references public.budget_lines(id) on delete set null,
  spent_on date not null,
  amount numeric(14, 2) not null check (amount > 0),
  description text not null check (length(description) between 2 and 240),
  reference text check (length(reference) <= 80),
  entered_by uuid references public.profiles(id) on delete set null,
  entered_at timestamptz not null default now()
);
create index if not exists expenses_grant_idx on public.expenses (grant_id, spent_on);
alter table public.funders enable row level security;
alter table public.funder_users enable row level security;
alter table public.grants enable row level security;
alter table public.budget_lines enable row level security;
alter table public.expenses enable row level security;

-- ============ 2. Funders see the whole pilot in Monitor ============
-- (monitor_me from part 2, with funder people counted as national viewers)
create or replace function public.monitor_me()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  p profiles;
  o monitor_officials;
  f uuid;
begin
  select * into p from profiles where id = auth.uid();
  if not found then return null; end if;
  select * into o from monitor_officials where user_id = p.id;
  select funder_id into f from funder_users where user_id = p.id;
  return jsonb_build_object(
    'id', p.id, 'name', p.username, 'role', p.role, 'admin', p.role = 'admin', 'funder', f,
    'classes', coalesce((select jsonb_agg(distinct class_id) from account_scopes(p.id) where scope = 'class'), '[]'::jsonb),
    'schools', coalesce((select jsonb_agg(distinct school_id) from account_scopes(p.id) where scope = 'school'), '[]'::jsonb),
    'regions', coalesce((select jsonb_agg(distinct r) from (
                  select p.champion_region_id r union select o.region_id union
                  select region_id from account_scopes(p.id) where scope = 'region') x where r is not null), '[]'::jsonb),
    'national', p.role = 'admin' or f is not null or (o.user_id is not null and o.region_id is null)
                or (p.role = 'ministry' and o.user_id is null)
                or exists (select 1 from account_scopes(p.id) where scope = 'country'));
end;
$$;

-- whoami, as in part 2, plus the funder's name and logo
create or replace function public.monitor_whoami()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me jsonb := monitor_me();
  v jsonb := '[]'::jsonb;
  fu funders;
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
  select * into fu from funders where id = (me->>'funder')::uuid;
  return jsonb_build_object(
    'signed_in', true, 'id', me->>'id', 'name', me->>'name', 'admin', (me->>'admin')::boolean,
    'title', coalesce((select title from monitor_officials where user_id = (me->>'id')::uuid), fu.name), 'views', v,
    'funder', case when fu.id is not null then jsonb_build_object('id', fu.id, 'name', fu.name, 'logo', fu.logo_url) end,
    'funds', fu.id is not null or (me->>'admin')::boolean,
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

-- ============ 3. Running costs of the pilot, per month, in US dollars ============
create or replace function public.funds_running_costs(p_from date, p_to date)
returns table (month date, data_usd numeric, sms_usd numeric, ussd_usd numeric, typed_usd numeric)
language sql stable security definer set search_path = public as $$
  with cs as (select * from cost_settings where id = 1),
  m as (select generate_series(date_trunc('month', p_from), date_trunc('month', p_to), interval '1 month')::date as month)
  select m.month,
    round(coalesce((select sum(bytes) from learning_events le
                     where le.kind = 'data' and (le.occurred_at at time zone 'Africa/Windhoek')::date >= m.month
                       and (le.occurred_at at time zone 'Africa/Windhoek')::date < (m.month + interval '1 month')::date), 0) / 1e9 * (select data_usd_per_gb from cs), 2),
    round(coalesce((select sum(coalesce(ml.cost_usd, (select sms_usd from cs))) from message_log ml
                     where ml.channel = 'sms' and ml.status = 'sent'
                       and (ml.delivered_at at time zone 'Africa/Windhoek')::date >= m.month
                       and (ml.delivered_at at time zone 'Africa/Windhoek')::date < (m.month + interval '1 month')::date), 0), 2),
    round(coalesce((select count(*) from learning_events le
                     where le.kind = 'ussd' and (le.occurred_at at time zone 'Africa/Windhoek')::date >= m.month
                       and (le.occurred_at at time zone 'Africa/Windhoek')::date < (m.month + interval '1 month')::date), 0) * (select ussd_session_usd from cs), 2),
    round(coalesce((select sum(amount_usd) from cost_entries ce where ce.month = m.month), 0), 2)
  from m;
$$;

-- ============ 4. How each grant is being used ============
create or replace function public.funds_overview(p_grant uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me jsonb := monitor_me();
  is_admin boolean;
  my_funder uuid;
  out jsonb := '[]'::jsonb;
  g record;
  lines jsonb;
  monthly jsonb;
  spent numeric;
  running numeric;
  learners int := (select count(*) from pilot_participants);
  months_gone numeric;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  is_admin := coalesce((me->>'admin')::boolean, false);
  my_funder := (me->>'funder')::uuid;
  if not is_admin and my_funder is null then raise exception 'Only funders and K-12 EdTech can see how funds are used.'; end if;

  for g in select gr.*, f.name funder_name, f.logo_url funder_logo from grants gr join funders f on f.id = gr.funder_id
            where (is_admin or gr.funder_id = my_funder) and (p_grant is null or gr.id = p_grant)
            order by gr.starts_on desc
  loop
    -- running costs only count against the grant marked for them, converted to its currency
    select coalesce(jsonb_agg(jsonb_build_object('month', y.month, 'expenses', y.exp, 'running', y.run, 'total', y.exp + y.run, 'cumulative', y.cum) order by y.month), '[]'::jsonb)
      into monthly
      from (select x.*, sum(x.exp + x.run) over (order by x.month) cum
              from (select rc.month,
                           coalesce((select sum(amount) from expenses e where e.grant_id = g.id and date_trunc('month', e.spent_on)::date = rc.month), 0) exp,
                           case when g.running_costs then round((rc.data_usd + rc.sms_usd + rc.ussd_usd + rc.typed_usd) * g.per_usd, 2) else 0 end run
                      from funds_running_costs(g.starts_on, least(g.ends_on, (now() at time zone 'Africa/Windhoek')::date)) rc) x) y;
    running := coalesce((select sum((m->>'running')::numeric) from jsonb_array_elements(monthly) m), 0);
    spent := coalesce((select sum(amount) from expenses where grant_id = g.id), 0) + running;

    select coalesce(jsonb_agg(jsonb_build_object('id', bl.id, 'category', bl.category, 'planned', bl.planned, 'note', bl.note,
                                                  'spent', coalesce((select sum(amount) from expenses e where e.budget_line_id = bl.id), 0))
                              order by bl.planned desc), '[]'::jsonb)
      into lines from budget_lines bl where bl.grant_id = g.id;
    if running > 0 then
      lines := lines || jsonb_build_array(jsonb_build_object('id', null, 'category', 'Pilot running costs (data, texts, USSD)', 'planned', null, 'spent', running, 'automatic', true));
    end if;

    months_gone := greatest(1, (least((now() at time zone 'Africa/Windhoek')::date, g.ends_on) - g.starts_on) / 30.44);
    out := out || jsonb_build_array(jsonb_build_object(
      'id', g.id, 'title', g.title, 'funder', g.funder_name, 'funder_logo', g.funder_logo, 'currency', g.currency,
      'amount', g.amount, 'starts_on', g.starts_on, 'ends_on', g.ends_on, 'running_costs', g.running_costs, 'notes', g.notes,
      'spent', round(spent, 2), 'remaining', round(g.amount - spent, 2),
      'used_pct', round(100 * spent / g.amount),
      'time_pct', round(100 * greatest(0, least(1, ((now() at time zone 'Africa/Windhoek')::date - g.starts_on)::numeric / greatest(1, g.ends_on - g.starts_on)))),
      'per_month', round(spent / months_gone, 2),
      'learners', learners,
      'per_learner', case when learners > 0 then round(spent / learners, 2) end,
      'lines', lines, 'monthly', monthly,
      'expenses', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'on', e.spent_on, 'amount', e.amount, 'description', e.description,
                                                               'reference', e.reference, 'category', bl.category) order by e.spent_on desc, e.id desc)
                              from (select * from expenses where grant_id = g.id order by spent_on desc, id desc limit 200) e
                              left join budget_lines bl on bl.id = e.budget_line_id), '[]'::jsonb)));
  end loop;
  return jsonb_build_object('grants', out, 'admin', is_admin,
                            'funders', case when is_admin then (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name, 'logo', f.logo_url,
                                         'people', (select coalesce(jsonb_agg(jsonb_build_object('user_id', fu.user_id, 'name', p.username) order by p.username), '[]'::jsonb)
                                                      from funder_users fu join profiles p on p.id = fu.user_id where fu.funder_id = f.id)) order by f.name), '[]'::jsonb) from funders f) end);
end;
$$;

-- ============ 5. Administrators: funders, people, grants, budget lines, expenses ============
create or replace function public.funds_admin(p_action text, p jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  uid uuid;
  t profiles;
  id_ text;
begin
  if not pilot_is_admin() then raise exception 'Only K-12 EdTech administrators can change funders and funds.'; end if;
  if p_action = 'save_funder' then
    insert into funders (id, name, website, logo_url)
    values (coalesce((p->>'id')::uuid, gen_random_uuid()), trim(p->>'name'), nullif(trim(coalesce(p->>'website', '')), ''), nullif(trim(coalesce(p->>'logo_url', '')), ''))
    on conflict (id) do update set name = excluded.name, website = excluded.website, logo_url = coalesce(excluded.logo_url, funders.logo_url)
    returning id::text into id_;
  elsif p_action = 'add_person' then
    uid := pilot_find_profile(p->>'identifier');
    if uid is null then raise exception 'No account found for %. They must sign up at k12plus.app first.', p->>'identifier'; end if;
    select * into t from profiles where id = uid;
    if t.role = 'learner' then raise exception '% is registered as a learner, so cannot be given funder access.', t.username; end if;
    insert into funder_users (user_id, funder_id, added_by) values (uid, (p->>'funder_id')::uuid, me)
    on conflict (user_id) do update set funder_id = excluded.funder_id, added_by = excluded.added_by, added_at = now();
    id_ := uid::text;
  elsif p_action = 'remove_person' then
    delete from funder_users where user_id = (p->>'user_id')::uuid;
  elsif p_action = 'save_grant' then
    if coalesce((p->>'running_costs')::boolean, false) then
      -- only one grant pays the running costs at a time, so they are never counted twice
      update grants set running_costs = false where id is distinct from (p->>'id')::uuid;
    end if;
    insert into grants (id, funder_id, title, currency, per_usd, amount, starts_on, ends_on, running_costs, notes, created_by)
    values (coalesce((p->>'id')::uuid, gen_random_uuid()), (p->>'funder_id')::uuid, trim(p->>'title'), coalesce(p->>'currency', 'NAD'),
            coalesce((p->>'per_usd')::numeric, case coalesce(p->>'currency', 'NAD') when 'USD' then 1 else 18 end),
            (p->>'amount')::numeric, (p->>'starts_on')::date, (p->>'ends_on')::date, coalesce((p->>'running_costs')::boolean, false),
            nullif(trim(coalesce(p->>'notes', '')), ''), me)
    on conflict (id) do update set title = excluded.title, currency = excluded.currency, per_usd = excluded.per_usd, amount = excluded.amount,
                                   starts_on = excluded.starts_on, ends_on = excluded.ends_on, running_costs = excluded.running_costs, notes = excluded.notes
    returning id::text into id_;
  elsif p_action = 'save_line' then
    insert into budget_lines (grant_id, category, planned, note)
    values ((p->>'grant_id')::uuid, trim(p->>'category'), (p->>'planned')::numeric, nullif(trim(coalesce(p->>'note', '')), ''))
    on conflict (grant_id, category) do update set planned = excluded.planned, note = excluded.note
    returning id::text into id_;
  elsif p_action = 'remove_line' then
    delete from budget_lines where id = (p->>'id')::bigint;
  elsif p_action = 'add_expense' then
    if (p->>'spent_on')::date > (now() at time zone 'Africa/Windhoek')::date then raise exception 'An expense cannot be in the future.'; end if;
    if p->>'budget_line_id' is not null and not exists (select 1 from budget_lines where id = (p->>'budget_line_id')::bigint and grant_id = (p->>'grant_id')::uuid) then
      raise exception 'That budget line belongs to another grant.';
    end if;
    insert into expenses (grant_id, budget_line_id, spent_on, amount, description, reference, entered_by)
    values ((p->>'grant_id')::uuid, (p->>'budget_line_id')::bigint, (p->>'spent_on')::date, (p->>'amount')::numeric,
            trim(p->>'description'), nullif(trim(coalesce(p->>'reference', '')), ''), me)
    returning id::text into id_;
  elsif p_action = 'remove_expense' then
    delete from expenses where id = (p->>'id')::bigint;
  else
    raise exception 'Unknown action.';
  end if;
  return jsonb_build_object('ok', true, 'id', id_);
end;
$$;

-- ============ 6. Learners who need attention ============
-- One row for each learner in the group who needs attention, with the reasons and the
-- topics they keep getting wrong. Callers decide whether names may be shown.
create or replace function public.monitor_attention(p_ids uuid[], p_grain text)
returns jsonb
language sql stable security definer set search_path = public as $$
  with w as (select first_day::timestamp at time zone 'Africa/Windhoek' t0 from monitor_window(p_grain)),
  per as (
    select l.id,
           (select max(occurred_at) from learning_events e where e.learner_id = l.id and e.kind <> 'data') last_at,
           (select sum(attempted) from learning_events e, w where e.learner_id = l.id and e.occurred_at >= w.t0 and e.kind in ('quiz', 'game', 'practice')) att,
           (select sum(correct) from learning_events e, w where e.learner_id = l.id and e.occurred_at >= w.t0 and e.kind in ('quiz', 'game', 'practice')) cor,
           (select round(100.0 * a.score / nullif(a.max_score, 0)) from test_attempts a join tests t on t.id = a.test_id
             where a.learner_id = l.id and a.submitted_at is not null and t.purpose = 'baseline' order by a.submitted_at desc limit 1) base,
           (select coalesce(jsonb_agg(jsonb_build_object('topic', topic, 'accuracy', acc) order by acc), '[]'::jsonb)
              from (select e.topic, round(100.0 * sum(e.correct) / sum(e.attempted)) acc
                      from learning_events e, w
                     where e.learner_id = l.id and e.occurred_at >= w.t0 and e.topic is not null
                       and e.kind in ('quiz', 'game', 'practice') and e.attempted > 0
                     group by e.topic having sum(e.attempted) >= 5 and 100.0 * sum(e.correct) / sum(e.attempted) < 50
                     order by 2 limit 3) x) weak
      from unnest(p_ids) l(id)
  ), flagged as (
    select per.*,
           case when att > 0 then round(100.0 * cor / att) end acc,
           array_remove(array[
             case when last_at is null then 'not active yet'
                  when last_at < now() - interval '7 days' then 'not active for ' || extract(day from now() - last_at)::int || ' days' end,
             case when att >= 10 and 100.0 * cor / att < 40 then 'practice accuracy ' || round(100.0 * cor / att) || '%' end,
             case when base < 40 then 'start of year test ' || base || '%' end,
             case when jsonb_array_length(weak) > 0 then 'struggling with ' || (select string_agg(x->>'topic', ', ') from jsonb_array_elements(weak) x) end
           ], null) reasons
      from per
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'reasons', to_jsonb(reasons), 'weak', weak, 'accuracy', acc, 'last_active', last_at, 'baseline', base)
                            order by cardinality(reasons) desc, acc nulls first), '[]'::jsonb)
    from flagged where cardinality(reasons) > 0;
$$;

-- The attention list for one class or one school: names for those who look after the
-- learners, otherwise only the number (hidden for fewer than five learners in the group).
create or replace function public.monitor_attention_for(p_scope text, p_id uuid, p_grain text default 'week')
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me jsonb := monitor_me();
  sch uuid; reg smallint; cls uuid;
  sees text;
  ids uuid[];
  lst jsonb;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  if p_scope = 'class' then
    select c.id, c.school_id, s.region_id into cls, sch, reg from classes c join schools s on s.id = c.school_id where c.id = p_id;
    ids := monitor_ids(cls, null, null);
  elsif p_scope = 'school' then
    select s.id, s.region_id into sch, reg from schools s where s.id = p_id;
    ids := monitor_ids(null, sch, null);
  else
    raise exception 'Unknown area.';
  end if;
  sees := monitor_sees(me, cls, sch, reg);
  if sees is null then raise exception 'You do not have access here.'; end if;
  lst := monitor_attention(ids, p_grain);
  if sees = 'named' then
    return jsonb_build_object('named', true, 'learners', cardinality(ids), 'count', jsonb_array_length(lst),
      'rows', (select coalesce(jsonb_agg(x || jsonb_build_object('name', p.username, 'class', c.name)), '[]'::jsonb)
                 from jsonb_array_elements(lst) x join profiles p on p.id = (x->>'id')::uuid
                 left join enrolments e on e.learner_id = p.id and e.status = 'active' left join classes c on c.id = e.class_id));
  end if;
  if cardinality(ids) < 5 then return jsonb_build_object('named', false, 'too_few', true, 'learners', cardinality(ids)); end if;
  return jsonb_build_object('named', false, 'learners', cardinality(ids), 'count', jsonb_array_length(lst),
    'topics', (select coalesce(jsonb_agg(jsonb_build_object('topic', topic, 'learners', n) order by n desc), '[]'::jsonb)
                 from (select w->>'topic' topic, count(*) n from jsonb_array_elements(lst) x, jsonb_array_elements(x->'weak') w group by 1) t));
end;
$$;

-- Schools (in a region) or regions (in Namibia) ranked by the share of learners who need attention.
create or replace function public.monitor_attention_areas(p_region smallint default null, p_grain text default 'week')
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me jsonb := monitor_me();
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  if p_region is null and not coalesce((me->>'national')::boolean, false) then raise exception 'Only national viewers can see every region.'; end if;
  if p_region is not null and monitor_sees(me, null, null, p_region) is null then raise exception 'You do not have access to this region.'; end if;
  if p_region is null then
    return coalesce((select jsonb_agg(z order by (z->>'share')::numeric desc nulls last) from (
      select case when cardinality(ids) < 5 then jsonb_build_object('id', r.id, 'name', r.name, 'learners', cardinality(ids), 'too_few', true)
                  else jsonb_build_object('id', r.id, 'name', r.name, 'learners', cardinality(ids), 'count', jsonb_array_length(a),
                                          'share', round(100.0 * jsonb_array_length(a) / cardinality(ids))) end z
        from regions r, lateral (select monitor_ids(null, null, r.id) ids) i, lateral (select monitor_attention(i.ids, p_grain) a) aa
       where r.country = 'NA' and cardinality(ids) > 0) q), '[]'::jsonb);
  end if;
  return coalesce((select jsonb_agg(z order by (z->>'share')::numeric desc nulls last) from (
    select case when cardinality(ids) < 5 then jsonb_build_object('id', s.id, 'name', s.name, 'setting', s.setting, 'learners', cardinality(ids), 'too_few', true)
                else jsonb_build_object('id', s.id, 'name', s.name, 'setting', s.setting, 'learners', cardinality(ids), 'count', jsonb_array_length(a),
                                        'share', round(100.0 * jsonb_array_length(a) / cardinality(ids))) end z
      from schools s, lateral (select monitor_ids(null, s.id, null) ids) i, lateral (select monitor_attention(i.ids, p_grain) a) aa
     where s.region_id = p_region and s.in_pilot and cardinality(ids) > 0) q), '[]'::jsonb);
end;
$$;

-- ============ 7. Who may call what ============
do $$
declare f text;
begin
  foreach f in array array['funds_running_costs(date, date)', 'monitor_attention(uuid[], text)', 'monitor_me()'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['monitor_whoami()', 'funds_overview(uuid)', 'funds_admin(text, jsonb)',
                           'monitor_attention_for(text, uuid, text)', 'monitor_attention_areas(smallint, text)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

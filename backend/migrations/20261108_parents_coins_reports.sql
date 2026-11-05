-- K12Plus Monitor, part 4 (5 November 2026)
--   1. Learner accounts are managed only by class and school managers. Administrators no
--      longer manage them, and history shows them learner and parent names only where they
--      look after learners themselves.
--   2. Parents see their own child's progress. A parent names a child by the child's K12Plus
--      ID when signing up. The link counts only when the phone number on the guardian
--      consent matches the parent's, or when the child's class teacher or school confirms it.
--   3. Coins are kept on the server, with the same rules the app uses, so a learner keeps
--      them on a new phone, nobody can edit them, and teachers can see them.
--   4. Monthly reports for funders: built on the first of each month from exactly what the
--      funder sees in Monitor (numbers only), shown in Monitor and emailed when an email
--      service is connected.
-- Nothing here changes or deletes existing rows.

-- ============ 1. Administrators and learner accounts ============
create or replace function public.account_cover(p_actor uuid, p_class uuid, p_school uuid, p_region smallint, p_learner_rules boolean default false)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'rank', coalesce(max(case when x.source = 'administrator' then 5 else account_rank(x.scope) end), 0),
    'grant_rank', coalesce(max(case when x.source = 'administrator' then 5 when x.can_grant then account_rank(x.scope) end), 0))
    from account_scopes(p_actor) x
   where ((x.source = 'administrator' and not p_learner_rules)
          or (x.scope = 'class' and x.class_id = p_class)
          or (x.scope = 'school' and x.school_id = p_school)
          or (not p_learner_rules and x.scope = 'region' and x.region_id = p_region)
          or (not p_learner_rules and x.scope = 'country' and x.source <> 'administrator'));
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
  -- learners and parents are listed only for their class and school managers
  learners_here := p_scope in ('class', 'school')
        and (account_cover(me, (sc->>'class_id')::uuid, (sc->>'school_id')::uuid, null, true)->>'rank')::int >= 1;
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

create or replace function public.account_history(p_scope text, p_id text default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  sc jsonb := account_scope_check(p_scope, p_id);
  learners_ok boolean;
begin
  -- learner and parent names only for those who look after learners here
  learners_ok := p_scope in ('class', 'school')
        and (account_cover(me, (sc->>'class_id')::uuid, (sc->>'school_id')::uuid, null, true)->>'rank')::int >= 1;
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
                                                      select 1 from enrolments e
                                                       where e.learner_id in (a.target, nullif(a.details->>'learner_id', '')::uuid)
                                                         and e.class_id = (sc->>'class_id')::uuid) end
                            order by a.at desc limit 100) a
                     left join profiles pa on pa.id = a.actor
                     left join profiles pt on pt.id = a.target), '[]'::jsonb);
end;
$$;

-- ============ 2. Parents and their children ============
create table if not exists public.parent_links (
  parent_id uuid not null references auth.users(id) on delete cascade,
  learner_id uuid not null references auth.users(id) on delete cascade,
  status text not null check (status in ('confirmed', 'refused')),
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz not null default now(),
  primary key (parent_id, learner_id)
);
alter table public.parent_links enable row level security;

-- the last nine digits of a phone number, so +264 81 ... and 081 ... match
create or replace function public.phone_tail(p text)
returns text language sql immutable as $$
  select case when length(regexp_replace(coalesce(p, ''), '\D', '', 'g')) >= 9
              then right(regexp_replace(p, '\D', '', 'g'), 9) end;
$$;

-- Every child a parent has named, and whether the link counts. Until a link is confirmed the
-- parent sees only the K12Plus ID they typed, never the learner's name.
--   confirmed: the class teacher or school confirmed it, or the guardian consent carries the parent's phone
--   refused:   the class teacher or school said this is not the child's parent
--   waiting:   nobody has confirmed it yet
create or replace function public.parent_children(p_parent uuid)
returns table (learner_id uuid, name text, status text, by_phone boolean, uid text)
language sql stable security definer set search_path = public as $$
  select c.id, c.username,
         case when pl.status is not null then pl.status
              when ph.hit then 'confirmed' else 'waiting' end,
         pl.status is null and coalesce(ph.hit, false),
         c.learner_uid
    from profiles par
    join profiles c on c.role = 'learner' and c.learner_uid = any (coalesce(par.linked_children, '{}'::text[]))
    left join parent_links pl on pl.parent_id = par.id and pl.learner_id = c.id
    left join lateral (select exists (select 1 from consents k
                                        where k.kind = 'guardian' and k.learner_id = c.id and k.status = 'given'
                                          and phone_tail(k.guardian_phone) is not null
                                          and phone_tail(k.guardian_phone) = phone_tail(coalesce(par.phone_e164, par.phone))) hit) ph on true
   where par.id = p_parent and par.role = 'parent';
$$;

-- The parents who have named a learner, for that learner's class teacher and school.
create or replace function public.learner_parents(p_learner uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', par.id, 'name', par.username, 'phone', coalesce(par.phone_e164, par.phone),
                                               'status', pc.status, 'by_phone', pc.by_phone) order by par.username), '[]'::jsonb)
    from profiles c
    join profiles par on par.role = 'parent' and c.learner_uid = any (coalesce(par.linked_children, '{}'::text[]))
    cross join lateral (select * from parent_children(par.id) x where x.learner_id = c.id) pc
   where c.id = p_learner;
$$;

-- monitor_me, as in part 3, plus the confirmed children of a parent
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
    'children', coalesce((select jsonb_agg(learner_id) from parent_children(p.id) where status = 'confirmed'), '[]'::jsonb),
    'national', p.role = 'admin' or f is not null or (o.user_id is not null and o.region_id is null)
                or (p.role = 'ministry' and o.user_id is null)
                or exists (select 1 from account_scopes(p.id) where scope = 'country'));
end;
$$;

-- whoami, as in part 3, plus a parent's children
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
  v := v || coalesce((select jsonb_agg(jsonb_build_object('kind', 'child', 'id', x.learner_id, 'status', x.status, 'k12_id', x.uid,
                                                          'name', case when x.status = 'confirmed' then x.name else x.uid end,
                                                          'taking_part', case when x.status = 'confirmed' then pilot_active(x.learner_id) end)
                                       order by x.status, x.name)
                        from parent_children((me->>'id')::uuid) x where x.status <> 'refused'), '[]'::jsonb);
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
    'signed_in', true, 'id', me->>'id', 'name', me->>'name', 'admin', (me->>'admin')::boolean, 'role', me->>'role',
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

-- A class teacher or school manager confirms, or refuses, that someone is a learner's parent.
create or replace function public.parent_link_decide(p_parent uuid, p_learner uuid, p_ok boolean)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me jsonb := monitor_me();
  pp record;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  select * into pp from account_place(p_learner);
  if coalesce(monitor_sees(me, pp.class_id, pp.school_id, null), '') <> 'named' then
    raise exception 'Only the learner''s class teacher or school can confirm a parent.';
  end if;
  if not exists (select 1 from parent_children(p_parent) where learner_id = p_learner) then
    raise exception 'This person has not named this learner as their child.';
  end if;
  insert into parent_links (parent_id, learner_id, status, decided_by)
  values (p_parent, p_learner, case when p_ok then 'confirmed' else 'refused' end, (me->>'id')::uuid)
  on conflict (parent_id, learner_id) do update set status = excluded.status, decided_by = excluded.decided_by, decided_at = now();
  perform account_log(case when p_ok then 'parent_confirmed' else 'parent_refused' end, p_parent,
                      jsonb_build_object('learner', (select username from profiles where id = p_learner), 'learner_id', p_learner, 'school_id', pp.school_id));
  return jsonb_build_object('ok', true);
end;
$$;

-- ============ 3. Coins on the server ============
create table if not exists public.coin_events (
  id bigserial primary key,
  learner_id uuid not null references auth.users(id) on delete cascade,
  amount int not null check (amount between -100 and 500 and amount <> 0),
  reason text not null check (reason in ('practice', 'quiz', 'test', 'game', 'start')),
  once_key text,
  client_id text not null,
  day date not null,
  at timestamptz not null default now(),
  unique (learner_id, once_key),
  unique (learner_id, client_id)
);
create index if not exists coin_events_learner_idx on public.coin_events (learner_id, day);
alter table public.coin_events enable row level security;
drop policy if exists coin_events_own on public.coin_events;
create policy coin_events_own on public.coin_events for select to authenticated using (learner_id = auth.uid());

create or replace function public.coins_state(p_learner uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'balance', coalesce((select sum(amount) from coin_events where learner_id = p_learner), 0),
    'practice_today', coalesce((select sum(amount) from coin_events where learner_id = p_learner and reason = 'practice'
                                  and day = (now() at time zone 'Africa/Windhoek')::date), 0),
    'once', coalesce((select jsonb_agg(once_key) from coin_events where learner_id = p_learner and once_key is not null
                        and at > now() - interval '120 days'), '[]'::jsonb),
    'log', coalesce((select jsonb_agg(jsonb_build_object('at', at, 'n', amount, 'why', reason) order by at desc)
                       from (select * from coin_events where learner_id = p_learner order by at desc limit 30) z), '[]'::jsonb));
$$;

-- The app sends what happened on the phone; the server applies the same rules the app does:
--   practice: at most 60 coins an answer and 300 a day
--   quiz:     at most 60 coins, once for each quiz key
--   test:     50 coins, once for each test, only for a test the learner has submitted
--   game:     20, 25 or 30 coins, only if the learner has that many
--   start:    coins earned on this phone before coins were kept on the server, once, at most 500
-- Events the server will not count are still answered as done, so the phone stops sending
-- them; a test reward waits until the test itself has reached the server.
create or replace function public.coins_sync(p_events jsonb default '[]'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  today_ date := (now() at time zone 'Africa/Windhoek')::date;
  e jsonb;
  cid text; why text; once_ text; amt int; d date; used int; bal int;
  done jsonb := '[]'::jsonb;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  if (select role from profiles where id = me) is distinct from 'learner' then
    return jsonb_build_object('balance', null, 'done', '[]'::jsonb);
  end if;
  if jsonb_typeof(coalesce(p_events, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_events, '[]'::jsonb)) > 200 then
    raise exception 'Send at most 200 coin events at a time.';
  end if;
  perform pg_advisory_xact_lock(hashtext('k12coins:' || me::text));
  for e in select * from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) loop
    cid := e->>'id';
    if cid is null or cid !~ '^[A-Za-z0-9-]{8,64}$' then continue; end if;
    if exists (select 1 from coin_events where learner_id = me and client_id = cid) then done := done || to_jsonb(cid); continue; end if;
    why := e->>'why';
    once_ := nullif(left(coalesce(e->>'once', ''), 120), '');
    amt := case when coalesce(e->>'n', '') ~ '^-?[0-9]{1,4}$' then (e->>'n')::int else 0 end;
    d := case when coalesce(e->>'day', '') ~ '^\d{4}-\d{2}-\d{2}$' then (e->>'day')::date else today_ end;
    d := least(today_, greatest(today_ - 7, d));
    if why = 'practice' then
      once_ := null;
      select coalesce(sum(amount), 0) into used from coin_events where learner_id = me and reason = 'practice' and day = d;
      amt := least(greatest(amt, 0), 60, greatest(0, 300 - used));
    elsif why = 'quiz' then
      amt := case when once_ ~ '^quiz:' then least(greatest(amt, 0), 60) else 0 end;
    elsif why = 'test' then
      if once_ is null or once_ !~ '^test:' then amt := 0;
      elsif exists (select 1 from test_attempts a where a.learner_id = me and a.submitted_at is not null
                       and (a.test_id::text = substr(once_, 6) or a.id::text = substr(once_, 6))) then amt := 50;
      elsif e->>'at' ~ '^\d+$' and (e->>'at')::bigint < (extract(epoch from now()) * 1000)::bigint - 14 * 86400000 then amt := 0;
      else continue; -- the test has not reached the server yet: ask again later
      end if;
    elsif why = 'game' then
      once_ := null;
      select coalesce(sum(amount), 0) into bal from coin_events where learner_id = me;
      amt := case when amt in (-20, -25, -30) and bal + amt >= 0 then amt else 0 end;
    elsif why = 'start' then
      once_ := 'start';
      amt := least(greatest(amt, 0), 500);
    else
      amt := 0;
    end if;
    if amt <> 0 then
      insert into coin_events (learner_id, amount, reason, once_key, client_id, day)
      values (me, amt, why, once_, cid, d) on conflict do nothing;
    end if;
    done := done || to_jsonb(cid);
  end loop;
  return coins_state(me) || jsonb_build_object('done', done);
end;
$$;

-- ============ 4. The learner and class views, with coins and parents ============
create or replace function public.monitor_learner(p_learner uuid default null, p_grain text default 'week')
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me jsonb := monitor_me();
  lid uuid;
  pp record;
  named boolean;
  parent_ok boolean;
  w record;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  lid := coalesce(p_learner, (me->>'id')::uuid);
  select x.*, c.name class_name, s.name school_name, s.logo_url into pp
    from pilot_participants x join classes c on c.id = x.class_id join schools s on s.id = x.school_id
   where x.learner_id = lid;
  named := pp.learner_id is not null and coalesce(monitor_sees(me, pp.class_id, pp.school_id, null), '') = 'named';
  parent_ok := me->'children' @> to_jsonb(lid::text);
  if lid <> (me->>'id')::uuid and not named and not parent_ok then
    raise exception 'You can only open learners in your own classes or school, or your own children.';
  end if;
  if pp.learner_id is null then
    return jsonb_build_object('taking_part', false, 'name', case when parent_ok then (select username from profiles where id = lid) else me->>'name' end,
                              'child', parent_ok);
  end if;
  select * into w from monitor_window(p_grain);
  return monitor_stats(array[lid], p_grain, true) || jsonb_build_object(
    'taking_part', true, 'name', (select username from profiles where id = lid), 'child', parent_ok,
    'class', pp.class_name, 'school', pp.school_name, 'logo', pp.logo_url, 'grade', pp.grade,
    'class_id', case when named and lid <> (me->>'id')::uuid then pp.class_id end,
    'coins', jsonb_build_object(
       'balance', coalesce((select sum(amount) from coin_events where learner_id = lid), 0),
       'earned', coalesce((select sum(amount) from coin_events where learner_id = lid and amount > 0 and day >= w.first_day), 0),
       'spent', coalesce((select -sum(amount) from coin_events where learner_id = lid and amount < 0 and day >= w.first_day), 0)),
    'parents', case when named and lid <> (me->>'id')::uuid then learner_parents(lid) end,
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
    select coalesce(jsonb_agg(jsonb_build_object('id', x.learner_id, 'name', p.username,
                                                 'coins', coalesce((select sum(amount) from coin_events ce where ce.learner_id = x.learner_id), 0))
                              || monitor_stats(array[x.learner_id], p_grain, false)
                    order by lower(p.username)), '[]'::jsonb)
      into rows_j
      from pilot_participants x join profiles p on p.id = x.learner_id
     where x.class_id = c.id;
  end if;
  select count(*) into joined from enrolments where class_id = c.id and status = 'active';
  return monitor_mask(monitor_stats(monitor_ids(c.id, null, null), p_grain, true), named)
    || jsonb_build_object('id', c.id, 'name', c.name, 'grade', c.grade, 'school', c.school, 'school_id', c.school_id, 'logo', c.logo_url,
                          'region', c.region, 'region_id', c.region_id, 'named', named, 'learner_rows', rows_j,
                          'parents_waiting', case when named then (select count(*) from pilot_participants x
                                                                     cross join lateral jsonb_array_elements(learner_parents(x.learner_id)) lp
                                                                    where x.class_id = c.id and lp->>'status' = 'waiting') end,
                          'registrations', case when named or joined = 0 or joined >= 5
                                                then jsonb_build_object('joined', joined, 'with_consent', (select count(*) from pilot_participants where class_id = c.id))
                                                else jsonb_build_object('too_few', true) end);
end;
$$;

-- ============ 5. Monthly reports for funders ============
create table if not exists public.funder_reports (
  id bigserial primary key,
  funder_id uuid not null references public.funders(id) on delete cascade,
  month date not null check (month = date_trunc('month', month)::date),
  report jsonb not null,
  built_at timestamptz not null default now(),
  email_status text not null default 'waiting'
    check (email_status in ('waiting', 'sent', 'no_email_service', 'no_recipients', 'failed')),
  email_note text,
  sent_at timestamptz,
  unique (funder_id, month)
);
alter table public.funder_reports enable row level security;

-- Build last month's report for every funder that has people, from exactly what one of
-- those people sees in Monitor: the whole pilot in numbers, regions needing attention,
-- and the funder's own grants.
create or replace function public.funds_build_reports(p_month date default null)
returns int
language plpgsql security definer set search_path = public as $$
declare
  m date := coalesce(date_trunc('month', p_month)::date,
                     (date_trunc('month', (now() at time zone 'Africa/Windhoek')::date) - interval '1 month')::date);
  before_ text := coalesce(current_setting('request.jwt.claims', true), '');
  before_sub text := coalesce(current_setting('request.jwt.claim.sub', true), '');
  f record;
  u uuid;
  rep jsonb;
  n int := 0;
begin
  for f in select * from funders order by name loop
    select user_id into u from funder_users where funder_id = f.id order by added_at, user_id limit 1;
    if u is null then continue; end if;
    perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', u::text, true);
    -- the report must be built as the funder, never as an administrator
    if (monitor_me()->>'id')::uuid is distinct from u or coalesce((monitor_me()->>'admin')::boolean, false) then
      raise exception 'Could not build the report as the funder.';
    end if;
    rep := jsonb_build_object('month', m, 'funder', f.name, 'logo', f.logo_url,
                              'pilot', monitor_country('month'),
                              'attention', monitor_attention_areas(null, 'month'),
                              'grants', (select coalesce(jsonb_agg(g - 'expenses'), '[]'::jsonb) from jsonb_array_elements(funds_overview(null)->'grants') g));
    perform set_config('request.jwt.claims', before_, true);
    perform set_config('request.jwt.claim.sub', before_sub, true);
    insert into funder_reports (funder_id, month, report) values (f.id, m, rep)
    on conflict (funder_id, month) do update
      set report = excluded.report, built_at = now(),
          email_status = case when funder_reports.email_status = 'sent' then 'sent' else 'waiting' end;
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- Administrators can build the reports from Monitor at any time.
create or replace function public.funds_build_reports_now(p_month date default null)
returns int
language plpgsql security definer set search_path = public as $$
begin
  if not coalesce((monitor_me()->>'admin')::boolean, false) then raise exception 'Only K-12 EdTech can prepare funder reports.'; end if;
  return funds_build_reports(p_month);
end;
$$;

create or replace function public.funds_reports()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me jsonb := monitor_me();
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  if not coalesce((me->>'admin')::boolean, false) and me->>'funder' is null then raise exception 'Only funders and K-12 EdTech can see funder reports.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'funder', f.name, 'month', r.month, 'built_at', r.built_at,
                                                       'email_status', r.email_status, 'sent_at', r.sent_at) order by r.month desc, f.name)
                     from funder_reports r join funders f on f.id = r.funder_id
                    where coalesce((me->>'admin')::boolean, false) or r.funder_id = (me->>'funder')::uuid), '[]'::jsonb);
end;
$$;

create or replace function public.funds_report(p_id bigint)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me jsonb := monitor_me();
  r funder_reports;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  select * into r from funder_reports where id = p_id;
  if r.id is null or not (coalesce((me->>'admin')::boolean, false) or r.funder_id = (me->>'funder')::uuid) then
    raise exception 'Report not found.';
  end if;
  return r.report || jsonb_build_object('id', r.id, 'built_at', r.built_at, 'email_status', r.email_status, 'sent_at', r.sent_at);
end;
$$;

-- For the email service only: reports from the last three months still to send, with the
-- people to send them to (sign-in addresses made up by K12Plus are left out).
create or replace function public.funds_reports_to_send()
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'report', r.report,
           'to', (select coalesce(jsonb_agg(u.email order by u.email), '[]'::jsonb)
                    from funder_users fu join auth.users u on u.id = fu.user_id
                   where fu.funder_id = r.funder_id and u.email is not null
                     and u.email not like '%@learners.k12edu.io' and u.email not like '%@staff.k12edu.io'))
           order by r.id), '[]'::jsonb)
    from funder_reports r
   where r.email_status <> 'sent' and r.month >= (date_trunc('month', now()) - interval '3 months')::date;
$$;

create or replace function public.funds_report_mark(p_id bigint, p_status text, p_note text default null)
returns void
language sql security definer set search_path = public as $$
  update funder_reports set email_status = p_status, email_note = left(p_note, 300),
         sent_at = case when p_status = 'sent' then now() else sent_at end
   where id = p_id;
$$;

-- The monthly job proves itself to the email service with a secret kept in the vault.
create or replace function public.funds_cron_ok(p_secret text)
returns boolean
language plpgsql stable security definer set search_path = public as $$
declare s text;
begin
  select decrypted_secret into s from vault.decrypted_secrets where name = 'k12plus_funder_reports_cron';
  return s is not null and p_secret is not null and length(p_secret) >= 32 and s = p_secret;
exception when others then
  return false;
end;
$$;

-- ============ 6. Who may call what ============
do $$
declare f text;
begin
  foreach f in array array['phone_tail(text)', 'parent_children(uuid)', 'learner_parents(uuid)', 'coins_state(uuid)',
                           'funds_build_reports(date)', 'funds_reports_to_send()', 'funds_report_mark(bigint, text, text)',
                           'funds_cron_ok(text)', 'monitor_me()'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['funds_build_reports(date)', 'funds_reports_to_send()', 'funds_report_mark(bigint, text, text)', 'funds_cron_ok(text)'] loop
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  foreach f in array array['monitor_whoami()', 'monitor_learner(uuid, text)', 'monitor_class(uuid, text)', 'parent_link_decide(uuid, uuid, boolean)',
                           'coins_sync(jsonb)', 'funds_build_reports_now(date)', 'funds_reports()', 'funds_report(bigint)',
                           'account_list(text, text, text, text, int)', 'account_history(text, text)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- ============ 7. The schedule ============
-- 07:00 in Windhoek on the 1st: build last month's reports. 07:30 every day: send any report
-- not yet emailed (nothing happens when there is none, or no email service is connected).
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.unschedule(jobid) from cron.job where jobname = 'k12plus-monthly-funder-reports';
    perform cron.schedule('k12plus-monthly-funder-reports', '0 5 1 * *', 'select public.funds_build_reports()');
    if exists (select 1 from pg_available_extensions where name = 'pg_net') and exists (select 1 from pg_namespace where nspname = 'vault') then
      create extension if not exists pg_net;
      if not exists (select 1 from vault.secrets where name = 'k12plus_funder_reports_cron') then
        perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
                                    'k12plus_funder_reports_cron', 'Lets the daily job ask the funder-reports service to email funder reports');
      end if;
      perform cron.unschedule(jobid) from cron.job where jobname = 'k12plus-send-funder-reports';
      perform cron.schedule('k12plus-send-funder-reports', '30 5 * * *',
        $job$select net.http_post(url := 'https://uwqbjjzjdnjlbicxrwnp.supabase.co/functions/v1/funder-reports',
                                  headers := jsonb_build_object('Content-Type', 'application/json',
                                    'x-k12-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'k12plus_funder_reports_cron')),
                                  body := '{"action":"send"}'::jsonb)$job$);
    end if;
  end if;
end $$;

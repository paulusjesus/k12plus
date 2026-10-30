-- K12Plus pricing, approved 30 October 2026: daily question allowances by plan.
--
-- Additive only: one new table and one new function. No existing data is changed or removed.
--
--   Visitor (not signed in)              5 questions a day, counted on a random ID kept on the phone
--   Free plan                            5 questions a day
--   Individual plan (N$15 a month)       20 questions a day
--   School plan, and pilot learners      20 questions a day
--   Teachers and K-12 EdTech staff       40 questions a day
--
-- A question with a photo counts as one question. Days follow Namibian time. Only counts
-- are kept (who or which phone, the day, how many), never the questions themselves, and
-- rows are deleted after 7 days. Only the agent's server can call the function.

create table if not exists public.question_allowance (
  key text not null check (length(key) between 3 and 120),
  day date not null,
  questions int not null default 0 check (questions >= 0),
  primary key (key, day)
);
create index if not exists question_allowance_day_idx on public.question_allowance (day);
alter table public.question_allowance enable row level security;

create or replace function public.aim_allowance(p_user uuid, p_key text, p_take boolean default true)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_day date := (now() at time zone 'Africa/Windhoek')::date;
  v_plan text := 'visitor';
  v_key text := left(coalesce(p_key, ''), 120);
  v_limit int;
  v_used int;
  p profiles;
begin
  if p_user is not null then
    select * into p from profiles where id = p_user;
    v_key := 'user:' || p_user::text;
    if not found then
      v_plan := 'free';
    elsif p.role is not null and p.role not in ('learner', 'parent') then
      v_plan := 'staff';
    elsif pilot_active(p_user) then
      v_plan := 'school';
    elsif exists (select 1 from schools s where s.id = p.school_id and s.plan = 'school'
                    and (s.plan_expires_at is null or s.plan_expires_at > now())) then
      v_plan := 'school';
    elsif p.plan = 'individual' and (p.plan_expires_at is null or p.plan_expires_at > now()) then
      v_plan := 'individual';
    else
      v_plan := 'free';
    end if;
  end if;
  v_limit := case v_plan when 'staff' then 40 when 'school' then 20 when 'individual' then 20 else 5 end;
  if length(v_key) < 3 then
    return jsonb_build_object('plan', v_plan, 'limit', v_limit, 'used', 0, 'allowed', true);
  end if;

  delete from question_allowance where day < v_day - 7;
  if coalesce(p_take, true) then
    insert into question_allowance as qa (key, day, questions) values (v_key, v_day, 1)
    on conflict (key, day) do update set questions = qa.questions + 1 where qa.questions < v_limit
    returning questions into v_used;
    if v_used is not null then
      return jsonb_build_object('plan', v_plan, 'limit', v_limit, 'used', v_used, 'allowed', true);
    end if;
  end if;
  select questions into v_used from question_allowance where key = v_key and day = v_day;
  return jsonb_build_object('plan', v_plan, 'limit', v_limit, 'used', coalesce(v_used, 0),
                            'allowed', coalesce(v_used, 0) < v_limit and not coalesce(p_take, true));
end;
$$;

revoke execute on function public.aim_allowance(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.aim_allowance(uuid, text, boolean) to service_role;

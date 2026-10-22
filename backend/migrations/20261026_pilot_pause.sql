-- K12Plus pilot, item 5: teacher pause control
-- 26 October 2026
--
-- Additive only: new pilot_* functions and updated screens data. The pause
-- table (agent_pauses) and the pause rule in the message gate came with item 7.
--
-- * A teacher of the learner's class (or an administrator) can pause the agent
--   for a learner at any time, and resume it. Every pause and resume is kept,
--   with who did it, when and why.
-- * The gate checks the pause at the moment a message would be sent, so a
--   message prepared before the pause is still stopped.
-- * When the pause blocks a message, the message log shows who paused the
--   learner and when.

create or replace function public.pilot_pause_learner(p_learner uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not pilot_can_manage_learner(p_learner) then
    raise exception 'Only the learner''s teachers or K-12 EdTech can pause the agent for this learner.';
  end if;
  if pilot_is_paused(p_learner) then raise exception 'The agent is already paused for this learner.'; end if;
  insert into agent_pauses (learner_id, paused_by, reason)
  values (p_learner, auth.uid(), left(nullif(trim(coalesce(p_reason, '')), ''), 300));
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.pilot_resume_learner(p_learner uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  if not pilot_can_manage_learner(p_learner) then
    raise exception 'Only the learner''s teachers or K-12 EdTech can resume the agent for this learner.';
  end if;
  update agent_pauses set resumed_at = now(), resumed_by = auth.uid()
   where learner_id = p_learner and resumed_at is null;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'The agent is not paused for this learner.'; end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- every pause and resume for one learner, newest first
create or replace function public.pilot_pause_history(p_learner uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not pilot_can_manage_learner(p_learner) then
    raise exception 'Only the learner''s teachers or K-12 EdTech can see this.';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'paused_by', pb.username, 'paused_at', a.paused_at, 'reason', a.reason,
      'resumed_by', rb.username, 'resumed_at', a.resumed_at) order by a.paused_at desc)
      from agent_pauses a
      left join profiles pb on pb.id = a.paused_by
      left join profiles rb on rb.id = a.resumed_by
     where a.learner_id = p_learner), '[]'::jsonb);
end;
$$;

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
  paused_by_name text;
  paused_at_ts timestamptz;
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
    if not c_pause then
      select a.paused_at, p.username into paused_at_ts, paused_by_name
        from agent_pauses a left join profiles p on p.id = a.paused_by
       where a.learner_id = lid and a.resumed_at is null;
    end if;
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
                             'sent_this_week', n_week, 'local_time', to_char(local_ts, 'Dy HH24:MI'))
          || case when c_pause then '{}'::jsonb
                  else jsonb_build_object('paused_by', paused_by_name, 'paused_at', paused_at_ts) end,
          p_now, case when st = 'sent' then p_now end)
  returning id into log_id;

  if st = 'sent' and kind = 'learner' then
    insert into learner_messages (learner_id, message_log_id, body, created_at) values (lid, log_id, left(p->>'body', 2000), p_now);
  end if;
  return jsonb_build_object('id', log_id, 'status', st, 'reason', reason);
end;
$$;

create or replace function public.pilot_my_classes()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Please log in first.'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', c.id, 'name', c.name, 'grade', c.grade, 'code', c.class_code,
      'school', s.name, 'region', r.name, 'setting', s.setting,
      'school_consent', exists (select 1 from consents k where k.kind = 'school' and k.school_id = s.id and k.status = 'given'),
      'learners', coalesce((
        select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.username, 'k12id', p.learner_uid,
                                            'joined', e.enrolled_at,
                                            'consent', pilot_consent_state(p.id, s.id),
                                            'taking_part', pilot_active(p.id),
                                            'pause', (select jsonb_build_object('by', tp.username, 'at', a.paused_at, 'reason', a.reason)
                                                        from agent_pauses a left join profiles tp on tp.id = a.paused_by
                                                       where a.learner_id = p.id and a.resumed_at is null))
                         order by p.username)
          from enrolments e join profiles p on p.id = e.learner_id
         where e.class_id = c.id and e.status = 'active'), '[]'::jsonb)
    ) order by c.grade)
      from class_teachers ct
      join classes c on c.id = ct.class_id
      join schools s on s.id = c.school_id
      left join regions r on r.id = s.region_id
     where ct.teacher_id = auth.uid()), '[]'::jsonb);
end;
$$;

do $$
declare f text;
begin
  foreach f in array array['pilot_pause_learner(uuid, text)', 'pilot_resume_learner(uuid)', 'pilot_pause_history(uuid)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

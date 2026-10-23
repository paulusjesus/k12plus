-- K12Plus pilot, item 12: offline lessons and sync
-- 1 November 2026
--
-- Additive only. No existing data is changed or removed.
--
-- 1. Quiz results made without a signal are kept on the phone and sent later. Each
--    result now carries a reference made on the phone, so a result that is sent twice
--    (for example when the signal drops just as it is sent) is stored once only.
--    The new column is empty for older rows, which is allowed by the unique index.
-- 2. Lesson packs (lessons/*.json) are drafts until a pilot teacher, a regional
--    champion or a K-12 EdTech administrator has checked them. Learners only see
--    checked packs. A check belongs to one version of a pack, so changing a pack's
--    content (and raising its version) sends it back for checking.

-- ============ 1. Quiz results: stored once only ============
alter table public.quiz_attempts add column if not exists client_ref text;
alter table public.quiz_attempts drop constraint if exists quiz_attempts_client_ref_len;
alter table public.quiz_attempts add constraint quiz_attempts_client_ref_len check (client_ref is null or length(client_ref) between 8 and 64);
create unique index if not exists quiz_attempts_user_client_ref_key on public.quiz_attempts (user_id, client_ref);

-- ============ 2. Lesson pack checks ============
create table if not exists public.lesson_checks (
  pack_id text not null check (pack_id ~ '^[a-z0-9-]{3,40}$'),
  version int not null check (version between 1 and 1000),
  checked_by uuid references public.profiles(id) on delete set null,
  checked_name text not null,
  checked_role text not null check (checked_role in ('admin', 'champion', 'teacher')),
  note text check (note is null or length(note) <= 300),
  checked_at timestamptz not null default now(),
  primary key (pack_id, version)
);
alter table public.lesson_checks enable row level security;

-- who may check lesson packs: K-12 EdTech administrators, regional champions and
-- teachers of a pilot class
create or replace function public.pilot_lesson_checker_role() returns text
language sql stable security definer set search_path = public as $$
  select case
    when pilot_is_admin() then 'admin'
    when pilot_champion_region() is not null then 'champion'
    when exists (select 1 from class_teachers where teacher_id = auth.uid()) then 'teacher'
  end;
$$;

-- The checked packs. Anyone may ask (the app shows learners only checked packs);
-- the checker's name is shown to staff only.
create or replace function public.pilot_lesson_checks()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare staff boolean := auth.uid() is not null and pilot_lesson_checker_role() is not null;
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('pack_id', pack_id, 'version', version, 'checked_at', checked_at,
                                        'checked_name', case when staff then checked_name end,
                                        'checked_role', checked_role,
                                        'note', case when staff then note end) order by pack_id, version)
    from lesson_checks), '[]'::jsonb);
end;
$$;

-- Mark a pack version as checked (p_checked true) or take the check back (false).
-- Taking a check back is for administrators, or for the person who made it.
create or replace function public.pilot_check_lesson(p_pack text, p_version int, p_checked boolean, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  r text := pilot_lesson_checker_role();
  nm text;
  existing lesson_checks;
begin
  if me is null then raise exception 'Please log in first.'; end if;
  if r is null then raise exception 'Only pilot teachers, champions and K-12 EdTech administrators can check lessons.'; end if;
  if coalesce(p_pack, '') !~ '^[a-z0-9-]{3,40}$' or coalesce(p_version, 0) not between 1 and 1000 then raise exception 'Unknown lesson pack.'; end if;
  select * into existing from lesson_checks where pack_id = p_pack and version = p_version;
  if p_checked then
    if existing.pack_id is null then
      select coalesce(nullif(trim(username), ''), 'K12Plus staff') into nm from profiles where id = me;
      insert into lesson_checks (pack_id, version, checked_by, checked_name, checked_role, note)
      values (p_pack, p_version, me, left(nm, 80), r, left(nullif(trim(coalesce(p_note, '')), ''), 300));
    end if;
  else
    if existing.pack_id is not null then
      if r <> 'admin' and existing.checked_by is distinct from me then
        raise exception 'Only the person who checked this lesson, or an administrator, can take the check back.';
      end if;
      delete from lesson_checks where pack_id = p_pack and version = p_version;
    end if;
  end if;
  return pilot_lesson_checks();
end;
$$;

revoke execute on function public.pilot_lesson_checker_role() from public, anon;
revoke execute on function public.pilot_check_lesson(text, int, boolean, text) from public, anon;
grant execute on function public.pilot_check_lesson(text, int, boolean, text) to authenticated;
revoke execute on function public.pilot_lesson_checks() from public;
grant execute on function public.pilot_lesson_checks() to anon, authenticated;

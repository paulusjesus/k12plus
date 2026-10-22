-- K12Plus: 22 October 2026
-- Normalised phone number so learners can log in with a mobile number
-- (used by the auth-login Edge Function). Local numbers starting with 0 are
-- stored with the country code of the learner's profile (+264 Namibia, +27 South Africa).
alter table public.profiles add column if not exists phone_e164 text
  generated always as (
    case
      when phone is null or regexp_replace(phone, '\D', '', 'g') = '' then null
      when regexp_replace(phone, '\D', '', 'g') like '00%' then substr(regexp_replace(phone, '\D', '', 'g'), 3)
      when regexp_replace(phone, '\D', '', 'g') like '0%' then
        (case when country = 'South Africa' then '27' else '264' end) || substr(regexp_replace(phone, '\D', '', 'g'), 2)
      else regexp_replace(phone, '\D', '', 'g')
    end
  ) stored;
create index if not exists profiles_phone_e164_idx on public.profiles (phone_e164);

-- The username holds the learner's full name, and two learners can share a
-- name, so it must not be unique. The k12plus ID (learner_uid) stays unique.
alter table public.profiles drop constraint if exists profiles_username_key;

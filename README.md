# K12Plus - AI tutoring for Grades 8-12 in Namibia and Grades 11-12 in South Africa

Live at https://k12plus.app (mirror: https://k12edu.io)

K12Plus is an AI-powered, offline-ready learning platform built by K-Twelve Educational
Technologies cc. Learners chat with an AI tutor grounded
in the official NSSCO/NSSCAS (Namibia, NIED) and CAPS (South Africa, DBE) curricula, take
quizzes whose results are sealed in a tamper-evident hash chain, and keep learning offline
as an installable Progressive Web App. Educators generate lesson plans and schemes of work.
Voice input, photo upload and handwritten input all reach the tutor through Claude.

## Architecture
- Frontend: static PWA (this repo root) served by Hostinger, offline-first service worker
- AI: Google Cloud Run function (backend/index.js) calling the Claude API, with per-IP
  rate limiting, origin allowlisting, and agent execution logging
- Data: Supabase (Postgres) - accounts, profiles, 562-school directory, quiz attempts,
  agent logs, hash-chained trust records (backend/schema.sql)
- Curricula: k12plus-syllabus.js (NIED Junior Secondary Grades 8-9, NSSCO 6131 for Grades
  10-11, and NSSCAS 8227 for Grade 12, all extracted verbatim from official NIED syllabi
  for Namibia) plus backend/caps_curriculum.json (CAPS Grades 11-12, DBE, for South Africa)

No secrets live in this repository. All keys are injected as environment variables in
Google Cloud Run.

(c) 2026 K-Twelve Educational Technologies cc

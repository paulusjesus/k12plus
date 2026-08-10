# K12Plus - AI tutoring for Grade 11-12 learners in Namibia and South Africa

Live at https://k12plus.app (mirror: https://k12edu.io)

K12Plus is an AI-powered, offline-ready learning platform built by K-Twelve Educational
Technologies cc for the Build with Gemini XPRIZE. Learners chat with an AI tutor grounded
in the official NSSCO/NSSCAS (Namibia, NIED) and CAPS (South Africa, DBE) curricula, take
quizzes whose results are sealed in a tamper-evident hash chain, and keep learning offline
as an installable Progressive Web App. Educators generate lesson plans and schemes of work.
Voice input, photo upload and handwritten input all reach the tutor through Gemini.

## Architecture
- Frontend: static PWA (this repo root) served by Hostinger, offline-first service worker
- AI: Google Cloud Run function (backend/index.js) calling the Gemini API, with per-IP
  rate limiting, origin allowlisting, and agent execution logging
- Data: Supabase (Postgres) - accounts, profiles, 562-school directory, quiz attempts,
  agent logs, hash-chained trust records (backend/schema.sql)
- Curricula: backend/curriculum.json (NSSCO 6131 + NSSCAS 8227, extracted verbatim from
  official NIED syllabi) and backend/caps_curriculum.json (CAPS Grades 11-12, DBE)

No secrets live in this repository. All keys are injected as environment variables in
Google Cloud Run.

(c) 2026 K-Twelve Educational Technologies cc

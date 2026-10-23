# Pilot tests

Each pilot item has tests that prove its "Done when" check from the Pilot Readiness Brief.

| File | What it tests | How to run |
|---|---|---|
| `item1.test.js` | Item 1 database rules: regions, schools, classes, roles, enrolment and security, on a local Postgres (PGlite) loaded with `bootstrap.sql` (a stand-in for the live schema) and the real migration | `npm i @electric-sql/pglite@0.2.17 && node item1.test.js` |
| `pilot-admin.test.ts` | The `pilot-admin` Edge Function (new basic-phone learner accounts) against a stand-in for Supabase | start `pilot-admin.mock.ts` (port 9997) and the function with `SUPABASE_URL=http://localhost:9997`, then `deno run -A pilot-admin.test.ts` |
| `item2.test.js` | Item 2 consent rules: both consents needed, withdrawal takes effect at once, data flagged for removal, no way around the rules | `node item2.test.js` |
| `item2.ui.test.js` | Consent screens end to end: school letter, parent form upload, withdrawal, data removal | as for `item1.ui.test.js` |
| `item7.test.js` | Item 7 message gate: consent, pause, allowed hours (Namibian time), weekly and text limits, content result, every attempt logged, review sample, rule changes, security | `node item7.test.js` |
| `agent-messenger.rules.test.ts` | Fixed content rules (links, phone numbers, unsuitable words, length) | `deno run -A agent-messenger.rules.test.ts` |
| `agent-messenger.test.ts` | The agent-messenger Edge Function end to end: only the server can send, AI review fails closed, delivery | start `agent-messenger.mock.ts` (port 9995) and the function with `SUPABASE_URL=http://localhost:9995 ANTHROPIC_URL=http://localhost:9995/v1/messages`, then `deno run -A agent-messenger.test.ts` |
| `item7.ui.test.js` | Message review screens and the learner's agent messages | as for `item1.ui.test.js` |
| `item5.test.js` | Item 5 pause: who may pause or resume, a paused learner gets nothing (including messages prepared before), the log shows who paused, full history | `node item5.test.js` |
| `item5.ui.test.js` | Pause and resume from the teacher's class list | as for `item1.ui.test.js` |
| `../signout.ui.test.js` | Sign out removes the session from the phone and cancels it on the server | as for `item1.ui.test.js` |
| `item4.test.js` | Item 4: learning record (consent first, no duplicates, bad records ignored) and three Mondays of summaries with exact figures, logged without names, withdrawal | `node item4.test.js` |
| `item4.ui.test.js` | Activity from the real chat box, offline then synced once, nothing for unconsented learners, sign-out clears the queue, the teacher's summary card | as for `item1.ui.test.js` |
| `item3.test.js` | Item 3 tests: answers never leave the server, drafts must be approved, consent and grade first, two sittings, fair marking, a full class of 30 (20 on phones, 10 on paper), every score in one place with pilot IDs only, closing times, withdrawal. Set `K12_TEST_BANK` to the generated `seed.sql` to also check the real question bank (kept out of this public repository) | `node item3.test.js` |
| `aim-lock.test.ts` | The agent stays quiet while a pilot learner sits a test; nobody else is affected, and an error never locks anyone out | start `aim-lock.mock.ts` (port 9994) and the `aim` function with `SUPABASE_URL=http://localhost:9994 SUPABASE_ANON_KEY=anon ANTHROPIC_API_KEY=dummy`, then `deno run -A aim-lock.test.ts` |
| `item3.ui.test.js` | Test screens end to end: approval and dates, sitting the test on a 390 px phone with and without signal, the agent lock, printing the paper version, entering paper answers, the score list and CSV | as for `item1.ui.test.js` |
| `item1.ui.test.js` | The pilot screens in app.html in headless Chromium, with every click running the real SQL in PGlite | serve the site on 127.0.0.1:8765, set `VENDOR_DIR` to a folder with React and Babel in `node_modules`, then `node item1.ui.test.js` |

This folder is not served by the website (`tests/.htaccess`).

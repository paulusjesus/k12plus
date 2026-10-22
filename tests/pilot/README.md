# Pilot tests

Each pilot item has tests that prove its "Done when" check from the Pilot Readiness Brief.

| File | What it tests | How to run |
|---|---|---|
| `item1.test.js` | Item 1 database rules: regions, schools, classes, roles, enrolment and security, on a local Postgres (PGlite) loaded with `bootstrap.sql` (a stand-in for the live schema) and the real migration | `npm i @electric-sql/pglite@0.2.17 && node item1.test.js` |
| `pilot-admin.test.ts` | The `pilot-admin` Edge Function (new basic-phone learner accounts) against a stand-in for Supabase | start `pilot-admin.mock.ts` (port 9997) and the function with `SUPABASE_URL=http://localhost:9997`, then `deno run -A pilot-admin.test.ts` |
| `item1.ui.test.js` | The pilot screens in app.html in headless Chromium, with every click running the real SQL in PGlite | serve the site on 127.0.0.1:8765, set `VENDOR_DIR` to a folder with React and Babel in `node_modules`, then `node item1.ui.test.js` |

This folder is not served by the website (`tests/.htaccess`).

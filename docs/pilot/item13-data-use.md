# K12Plus data use per learner (pilot item 13)

Measured on 23 October 2026 by Claude for K-Twelve Educational Technologies.

## Summary

K12Plus uses very little mobile data. A typical pilot learner will use about **2.5 MB a month**, and a very heavy user about **6.5 MB**. At about US$1.20 per GB (the figure used in the pilot build plan) that costs **under US$0.01 per learner per month**. Even at five times that price, which is roughly what very small bundles can cost, it stays under US$0.05.

The build plan assumed about 300 MB a month (US$0.40 to US$1.00). The real figure is about 1% of that, so mobile data is no longer a meaningful part of the US$2.50 per learner per month budget. Text messages (up to about US$0.60) and USSD (not yet quoted) remain the costs to watch.

The planned three days of work to slim the app (compiling the pages in advance) is not needed. The plan expected the in-browser compiler (about 650 KB) to be downloaded on every first visit, but the app never loads it.

## Measured figures

| What the learner does | Data used now | Before today's fixes |
|---|---|---|
| First visit on a new phone (homepage, app saved for offline use, app opened) | 340 KB | 492 KB |
| Opening the app again on a later day | 10 KB | 11 KB |
| One question to the agent and its reply | 3 to 9 KB | 3 KB, then growing without limit as the chat gets longer |
| A sitting of 12 questions | 90 KB | 96 KB |
| A long sitting of 20 questions | 165 KB | about 225 KB (estimated) |
| One question with a photo of an exercise book page | 150 KB | 150 KB |
| An app update after we publish a change (estimate from file sizes) | about 120 KB | about 120 KB |
| Homepage ready to type in on a slow 3G connection | 3.3 seconds | 3.9 seconds |

The app also opens with no signal at all once it has been visited, and the USSD menu uses no mobile data.

## Monthly estimate per learner

| | Typical pilot learner | Heavy user |
|---|---|---|
| Sittings | 13 a month (3 a week), 12 questions each | 22 a month (5 a week), 20 questions each |
| Photo questions | 4 a month | 13 a month |
| App updates | 4 a month | 4 a month |
| Data in the first month | 2.7 MB | 6.5 MB |
| Data in later months | 2.3 MB | 6.2 MB |
| Cost at US$1.20 per GB | US$0.003 | US$0.008 |
| Cost at US$6.00 per GB | US$0.016 | US$0.04 |

Photos are the largest single item. A learner who sends many photos could use more, but 100 photos a month would still be only about 15 MB.

## What was fixed while measuring

1. **The logo** shown on every page was a 960 by 1,300 pixel image (59 KB) displayed at about 40 pixels high. The pages now use a 128 pixel copy (5.5 KB). The original file stays in place in case anything outside the site links to it.
2. **The offline set-up** downloaded five scripts twice on a first visit, because it saved them under different addresses from the ones the pages use. It also downloaded the About, Pricing and Contact pages and a second copy of the homepage in advance. Both are fixed, and a test keeps the addresses in step.
3. **Long chats**: every question re-sent the whole conversation, although the agent reads only the last 16 messages. The app now sends only what the agent reads, so no answer changes.
4. **Empty image requests**: three image placeholders made a wasted request on every visit. The phone now answers these itself.
5. **The phone's own data counter**, which pilot learners' phones send for the item 8 data-cost report, counted files served from the phone's cache as if they had been downloaded. A return visit that used 10 KB was recorded as 889 KB, so the report would have overstated data use about 25 times on a typical day. The counter now skips those files and adds what the offline service downloads in the background. It is now within about 3% for a sitting of questions. It still leaves out a few KB per visit for setting up the secure connection, so the report will slightly understate data use. At these sizes that is less than US$0.001 a month.

## Method

- The real site ran in Chromium with its service worker switched on, as on a phone. A local stand-in answered for every server the app talks to (k12plus.app, unpkg for React, Google Fonts and Supabase). It behaved like the live servers: brotli compression, HTTP/2, the live host's caching rules (pages and scripts are checked with ETags on every visit and downloaded only when they change), React cached for a year, and the logo cached for a week. These rules were read from k12plus.app on 23 October 2026.
- Bytes were counted on the raw connections, so the totals include encryption, connection set-up and headers. TCP/IP packet headers (about 3% more) are not included.
- The agent was replaced by a stand-in whose replies are 740 characters long. That is the 90th percentile of real replies in the agent logs from August to October 2026 (median 95 output tokens, 90th percentile 178), so the question figures err on the high side. No AI calls were made.
- The photo was a 1024 by 768 picture of a ruled exercise book page with handwriting and paper grain, as the app shrinks photos to 1024 pixels wide before sending.
- "Before" and "now" were measured with the same method, on the version live on k12plus.app on 23 October 2026 and on the branch with the fixes.
- To repeat the measurement, run `tests/pilot/item13.test.js`. It runs `tests/pilot/item13.measure.js` and fails if any figure goes over its limit: first visit 400 KB, return visit 25 KB, 12 questions 150 KB, one question 16 KB, one photo 250 KB.

## Limits of this measurement

- These are measurements in a simulated phone, not on a real low-cost Android phone on a Namibian network. The figures should be close, because data use depends on what is downloaded, not on the phone. A check with the pilot's real phones will come from the corrected data counter in the item 8 report.
- Google Fonts sizes were measured on k12plus.app. Older phones may receive slightly larger font files.
- App updates depend on how often we publish changes during the pilot. Four a month is an assumption.

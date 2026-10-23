# Connecting K12Plus to a USSD gateway (pilot item 11)

The USSD service is built and tested. It needs one outside step to go live: an agreement with a USSD gateway for *141*12# (MTC, and Telecom Namibia for TN Mobile numbers, or an aggregator that covers both).

## What the gateway calls

- **Address:** `https://uwqbjjzjdnjlbicxrwnp.supabase.co/functions/v1/ussd?key=SECRET`
- **Method:** POST, form fields or JSON: `sessionId`, `serviceCode`, `phoneNumber`, `text` (everything the learner has typed in the session, joined with `*`). This is the format used by Africa's Talking and most aggregators.
- **Reply:** plain text starting with `CON ` (wait for the next key) or `END ` (finish).
- **Secret:** the gateway must send a shared secret, either in the address as `?key=` or in the header `x-ussd-key`. Until the secret is set, the function answers every gateway call with "K12Plus on USSD is being connected for the pilot".

If the chosen gateway uses a different format (for example XML, or only the last key pressed instead of the whole text), send me its documentation; adding an adapter is a small change.

## Questions to ask the providers

1. The price per USSD session (or per screen), set-up and monthly fees, and whether sessions can be charged to K-12 EdTech so they are free for learners.
2. Whether *141*12# itself is available, and the lead time.
3. How long a session may last, and how long the gateway waits for each screen (the agent needs about 3 to 8 seconds to answer a question).
4. The longest screen they accept (the service keeps every screen to 182 characters).
5. Whether learners can type letters (for questions to the agent and class codes) and whether the characters ^ ~ [ ] are shown correctly.
6. When a learner dials a longer code such as *141*12*1#, whether the extra digits arrive in `text` or in `serviceCode` (both work).

## Going live

1. Sign the agreement and give the gateway the address above.
2. Tell me, and I will create the secret, store it in Supabase as `USSD_SECRET`, and send it to the gateway contact (never by chat).
3. Run the field check below.

## What learners get

- **\*141\*12#**: main menu with the four subjects (Mathematics, Physical Science, Biology, Business Studies), My results, and Join my class for a registered learner who is not in a class yet.
- **\*141\*12\*1# to \*141\*12\*4#**: straight to the AI Math Agent, AI Physical Science Agent, AI Biology Agent or AI Business Studies Agent.
- Each subject: a practice question, a short lesson and "ask the agent". Practice and lessons use only lessons a teacher has checked; subjects without lessons yet say they are coming soon.
- The learner is found by the phone number the network gives. On a phone shared by siblings, the first screen asks who is using it (first names only). An unknown number can practise and read lessons, and is told how to register; it cannot ask the agent.
- Up to 10 questions to the agent per phone per day. During a pilot test the agent takes a break, as on the app.

## Field check (with the live gateway)

For each network (MTC and TN Mobile), on a basic phone, in a rural area with weak signal:

| Check | MTC | TN Mobile |
|---|---|---|
| *141*12# shows the main menu with the learner's first name | | |
| *141*12*1#, *2#, *3# and *4# open the right agent | | |
| A practice question can be answered and is marked | | |
| A question to the agent is answered before the session times out | | |
| Every screen is readable (no missing or odd characters) | | |
| The session appears in the Pilot page figures (sessions, questions) | | |

## Privacy

The phone number is never stored by the USSD service, only a keyed fingerprint of it, used to limit questions per phone and to count sessions. Sessions are deleted after 30 days. For pilot learners with consent, each session, practice answer, lesson and question is added to the learning record (and questions to the agent are kept for the teachers' monthly review). For anyone else nothing is recorded. The administrator's simulator records nothing for the learner.

// The aim function's pilot features. Start aim-lock.mock.ts, then the aim function with
// SUPABASE_URL=http://localhost:9994 SUPABASE_ANON_KEY=anon SUPABASE_SERVICE_ROLE_KEY=svc
// ANTHROPIC_API_KEY=dummy ANTHROPIC_URL=http://localhost:9994/v1/messages, then:
// deno run -A aim-lock.test.ts
const FN = 'http://localhost:8000';
let pass = 0, fail = 0;
const ok = (c: boolean, n: string, x?: unknown) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, JSON.stringify(x ?? '')); } };
const ask = async (extra: Record<string, unknown>) => {
  const t0 = Date.now();
  const r = await fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://k12plus.app' },
    body: JSON.stringify({ action: 'chat', system: 'x', messages: [{ role: 'assistant', content: 'Hello!' }, { role: 'user', content: 'What is 2 + 2?' }], ...extra }) });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body, ms: Date.now() - t0 };
};
const calls = async () => (await fetch('http://localhost:9994/__calls')).json();
const fb = { kind: 'chat', subject: 'Mathematics' };

console.log('\nAgent pause during a pilot test (item 3)');
let r = await ask({ k12token: 'locked', k12feedback: fb });
ok(r.status === 423 && /in the middle of a test/.test(r.body.reply) && !/tutor/i.test(r.body.reply), 'a learner sitting a test gets a calm note instead of help, with the word agent', r);
let c = await calls();
ok(c.context.length === 1 && c.context[0].auth === 'Bearer locked' && c.context[0].apikey === 'anon' && c.claude === 0, "the check runs as the learner's own sign-in, and Claude is not asked", c);
r = await ask({ k12token: 'broken' });
ok(r.status === 200, 'if the check fails, the agent still helps (current learners are never locked out by an error)', r.status);
r = await ask({ k12token: 'slow' });
ok(r.status === 200 && r.ms < 4800 + 3000, 'a slow check gives up after 3 seconds', r.ms);
r = await ask({ action: 'chatimg', image: { mime: 'image/png', data: 'x' }, k12token: 'locked' });
ok(r.status === 423, 'photo questions are covered too');

console.log('\nKeeping pilot learners\' answers for the monthly review (item 9)');
const before = (await calls()).saved.length;
r = await ask({ k12token: 'pilot', k12feedback: fb, learner_id: 'someone-else' });
c = await calls();
const s = c.saved.at(-1);
ok(r.status === 200 && r.body.reply === 'Two plus two is four. 💡' && c.saved.length === before + 1, 'a pilot learner gets the answer, and it is kept for review', r);
ok(s.auth === 'Bearer svc' && s.body.learner_id === 'L-pilot' && s.body.question === 'What is 2 + 2?' && s.body.reply === 'Two plus two is four. 💡' && s.body.subject === 'Mathematics' && s.body.kind === 'chat',
   'it is stored by the server, for the learner the database confirmed (not one named by the app), with the question and the reply', s);
await ask({ k12token: 'other', k12feedback: fb });
await ask({ k12token: 'pilot' });
await ask({ k12feedback: fb });
ok((await calls()).saved.length === before + 1, 'nothing is kept for a learner without consent, for replies not marked for review, or without a sign-in');
await ask({ action: 'chatimg', image: { mime: 'image/png', data: 'x' }, k12token: 'pilot', k12feedback: fb });
c = await calls();
ok(c.saved.at(-1).body.kind === 'photo' && /with a photo, not kept/.test(c.saved.at(-1).body.question) && !JSON.stringify(c.saved.at(-1)).includes('"data"'), 'photo questions are kept as text only: the photo itself is not stored', c.saved.at(-1).body);
await ask({ k12token: 'pilot', k12feedback: { kind: 'real_life', subject: 'Mathematics', topic: 'Quadratic functions' }, messages: [{ role: 'user', content: 'Topic: Quadratic functions. Give 3 vivid real-life mini scenarios...' }] });
c = await calls();
ok(c.saved.at(-1).body.kind === 'real_life' && c.saved.at(-1).body.question === 'Real-Life Lab story about Quadratic functions (Mathematics)', 'Real-Life Lab stories are kept too, labelled clearly', c.saved.at(-1).body);
r = await ask({});
ok(r.status === 200 && (await calls()).context.length === c.context.length, 'learners outside the pilot send no token and no extra check is made');
console.log(`\n${pass} passed, ${fail} failed`);
Deno.exit(fail ? 1 : 0);

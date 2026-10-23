// The agent stays quiet while a pilot learner sits a test, and nobody else is affected.
// Start aim-lock.mock.ts, then the aim function with SUPABASE_URL=http://localhost:9994,
// SUPABASE_ANON_KEY=anon and ANTHROPIC_API_KEY=dummy, then: deno run -A aim-lock.test.ts
const FN = 'http://localhost:8000';
let pass = 0, fail = 0;
const ok = (c: boolean, n: string, x?: unknown) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, JSON.stringify(x ?? '')); } };
const ask = async (extra: Record<string, unknown>) => {
  const t0 = Date.now();
  const r = await fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://k12plus.app' },
    body: JSON.stringify({ action: 'chat', system: 'x', messages: [{ role: 'user', content: 'What is 2 + 2?' }], ...extra }) });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body, ms: Date.now() - t0 };
};
const calls = async () => (await fetch('http://localhost:9994/__calls')).json();

console.log('\nAgent lock during a pilot test');
let r = await ask({ k12token: 'locked' });
ok(r.status === 423 && /in the middle of a test/.test(r.body.reply) && !/tutor/i.test(r.body.reply), 'a learner sitting a test gets a calm note instead of help, with the word agent', r);
let c = await calls();
ok(c.length === 1 && c[0].auth === 'Bearer locked' && c[0].apikey === 'anon', "the check runs as the learner's own sign-in, not with the service key", c);
r = await ask({ k12token: 'free' });
ok(r.status !== 423, 'a pilot learner not in a test is helped as usual', r.status);
r = await ask({});
c = await calls();
ok(r.status !== 423 && c.length === 2, 'a learner outside the pilot sends no token and no extra check is made', c.length);
r = await ask({ k12token: 'broken' });
ok(r.status !== 423, 'if the check fails, the agent still helps (current learners are never locked out by an error)', r.status);
r = await ask({ k12token: 'slow' });
ok(r.status !== 423 && r.ms < 4800 + 3000, 'a slow check gives up after 3 seconds', r.ms);
r = await ask({ action: 'chatimg', image: { mime: 'image/png', data: 'x' }, k12token: 'locked' });
ok(r.status === 423, 'photo questions are covered too');
console.log(`\n${pass} passed, ${fail} failed`);
Deno.exit(fail ? 1 : 0);

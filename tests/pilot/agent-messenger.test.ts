// End-to-end tests for agent-messenger against agent-messenger.mock.ts
const FN = 'http://localhost:8000';
let pass = 0, fail = 0;
const ok = (c: boolean, n: string, x?: unknown) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, JSON.stringify(x ?? '')); } };
const post = async (auth: string | null, body: any) => {
  const r = await fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer ' + auth } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const calls = async () => (await fetch('http://localhost:9995/__calls')).json();
const L = '33333333-3333-3333-3333-333333333333', T = '44444444-4444-4444-4444-444444444444';
const msg = { action: 'send', learnerId: L, channel: 'in_app', purpose: 'follow_up', text: 'Hi! Quick one: what is 3x when x = 4?' };
// a fake service-role JWT (the gateway checks signatures; here only the role matters)
const svcJwt = 'h.' + btoa(JSON.stringify({ role: 'service_role' })).replace(/=+$/, '') + '.s';
const userJwt = 'h.' + btoa(JSON.stringify({ role: 'authenticated', sub: 'x' })).replace(/=+$/, '') + '.s';

console.log('\nWho may send');
let r = await post(null, msg);
ok(r.status === 403, 'signed-out request cannot send', r);
r = await post(userJwt, msg);
ok(r.status === 403, 'a signed-in user cannot send messages to learners', r);
r = await post(svcJwt, msg);
ok(r.status === 200 && r.body.status === 'sent' && r.body.content.ok, 'the server sends a clean in-app message after both checks', r);
let c = await calls();
ok(c.anthropic.length === 1 && c.anthropic[0].model === 'claude-haiku-5-5' && c.anthropic[0].key === 'akey' && c.anthropic[0].ws === 'wrk' && !c.anthropic[0].hasTemp, 'the review uses Claude Haiku with the workspace header and no temperature', c.anthropic[0]);
ok(c.log[0].content_ok === true && c.log[0].learner_id === L && c.log[0].recipient_kind === 'learner', 'the gate receives the result of the content check');

console.log('\nContent check');
r = await post(svcJwt, { ...msg, text: 'Visit www.cheats.com' });
c = await calls();
ok(r.body.status === 'blocked' && c.anthropic.length === 1 && c.log.at(-1).content_ok === false && /link/.test(c.log.at(-1).content_reason), 'a fixed-rule failure is blocked and logged without calling the AI', c.log.at(-1));
r = await post(svcJwt, { ...msg, text: 'Hi, REVIEW_NO what is your favourite colour?' });
ok(r.body.status === 'blocked' && (await calls()).log.at(-1).content_reason === 'off topic', 'the AI review can block a message, and its reason is logged');
r = await post(svcJwt, { ...msg, text: 'Hi, REVIEW_DOWN what is 2 + 2?' });
ok(r.body.status === 'blocked' && /unavailable/.test((await calls()).log.at(-1).content_reason), 'if the AI review is down, the message is blocked, never sent unchecked');
r = await post(svcJwt, { ...msg, text: 'Hi, REVIEW_GARBLE what is 2 + 2?' });
ok(r.body.status === 'blocked', 'an unclear AI answer blocks the message');

console.log('\nDelivery');
r = await post(svcJwt, { ...msg, channel: 'sms' });
c = await calls();
ok(r.body.status === 'failed' && r.body.reason === 'sms_not_connected' && c.delivery.at(-1).p_ok === false, 'until a text message provider is connected, approved texts are logged as not delivered', r.body);
r = await post(svcJwt, { action: 'send', teacherId: T, channel: 'email', purpose: 'monday_summary', text: 'Monday summary for Grade 11 Mathematics: 24 of 35 learners were active.' });
ok(r.status === 200 && (await calls()).log.at(-1).recipient_kind === 'teacher', 'teacher summaries go through the same check and log');
r = await post(svcJwt, { ...msg, channel: 'carrier pigeon' });
ok(r.status === 400, 'unknown channels are refused');

console.log('\nAdministrators can test wording');
r = await post('user:tch', { action: 'check', text: 'Hello' });
ok(r.status === 403, 'teachers cannot use the wording check', r);
r = await post('user:adm', { action: 'check', text: 'Call me on 0812345678' });
ok(r.status === 200 && r.body.ok === false && /phone/.test(r.body.reason), 'administrator sees why a draft would be blocked', r.body);
const before = (await calls()).log.length;
await post('user:adm', { action: 'check', text: 'What is 5 squared?' });
ok((await calls()).log.length === before, 'testing wording sends and logs nothing');

console.log(`\n${pass} passed, ${fail} failed`);
Deno.exit(fail ? 1 : 0);

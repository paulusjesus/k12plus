// Supabase Edge Function `ussd` (pilot item 11): K12Plus on basic phones, *141*12#.
//
// The mobile network's USSD gateway calls this function for every screen, in the
// common format used by Africa's Talking and most aggregators:
//   POST (form or JSON)  sessionId, serviceCode, phoneNumber, text
//   text is everything the learner has typed in this session, joined with *
//   reply  "CON <screen>" to wait for the next key, "END <screen>" to finish
// The gateway proves it is the gateway with a shared secret, sent as ?key=... on
// the callback address or as the header x-ussd-key (set USSD_SECRET when the
// gateway agreement is signed; until then gateway calls are refused politely).
//
// The administrator's simulator (Pilot page) calls the same function with
// { simulate: true, ... } and the administrator's sign-in. Simulated sessions run
// the real menus but record nothing for the learner.
//
// Collect as little as possible: the phone number is never stored, only a keyed
// fingerprint of it (to limit questions to the agent per phone and to count
// sessions). Records for the learning record are kept for pilot learners only.
import { run, gsm, type Deps, type Learner, type Pack, AGENT } from './menu.ts';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY') || SERVICE;
const SITE = (Deno.env.get('SITE_URL') || 'https://k12plus.app').replace(/\/$/, '');
const CLAUDE_URL = Deno.env.get('ANTHROPIC_URL') || 'https://api.anthropic.com/v1/messages'; // ANTHROPIC_URL only in tests
const ORIGINS = ['https://k12plus.app', 'https://www.k12plus.app', 'https://k12edu.io', 'https://www.k12edu.io'];
const MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5']; // a USSD screen waits only a few seconds, so the fast model goes first

const svc = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
async function rpc(name: string, args: unknown, headers: Record<string, string> = svc) {
  const r = await fetch(`${URL_}/rest/v1/rpc/${name}`, { method: 'POST', headers, body: JSON.stringify(args ?? {}) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${name} ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

// keyed fingerprint of the phone number (digits only, Namibian 0 replaced by 264)
export function phoneDigits(raw: string): string {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = '264' + d.slice(1);
  return d;
}
async function phoneHash(digits: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('k12plus-ussd:' + SERVICE), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(digits));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
}

// lesson packs: the checked ones only, read from the website and kept for 10 minutes
let packCache: { at: number; packs: Pack[] } | null = null;
async function checkedPacks(): Promise<Pack[]> {
  if (packCache && Date.now() - packCache.at < 600_000) return packCache.packs;
  try {
    const [idx, checks] = await Promise.all([
      fetch(`${SITE}/lessons/index.json`).then((r) => r.json()),
      rpc('pilot_lesson_checks', {}),
    ]);
    const ok = (idx.packs || []).filter((e: any) => (checks || []).some((c: any) => c.pack_id === e.id && c.version === e.version));
    const packs = (await Promise.all(ok.map((e: any) => fetch(`${SITE}/lessons/${e.id}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null))))
      .filter((p: any) => p && ok.some((e: any) => e.id === p.id && e.version === p.version));
    packCache = { at: Date.now(), packs };
  } catch (e) {
    console.error('packs', (e as Error).message);
    if (!packCache) return [];
  }
  return packCache!.packs;
}

async function askAgent(subject: string, question: string, learner: Learner | null, simulated: boolean): Promise<string> {
  const agent = AGENT[subject] || 'AI Math Agent';
  const system = `You are the ${agent} from K12Plus, answering a${learner?.grade ? ' Grade ' + learner.grade : ''} learner in Namibia who is using a basic phone (USSD). ` +
    'Follow the Namibian NIED syllabus. Be warm and encouraging. Reply in at most 400 characters of plain text: no lists, no markdown, no emojis, ' +
    'and only basic keyboard characters (write x^2, sqrt(x), pi, <=). Guide the first step and the key idea rather than only giving the answer. Use "learners", not "students".';
  for (const model of MODELS) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(CLAUDE_URL, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', 'x-api-key': Deno.env.get('ANTHROPIC_API_KEY') || '', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 600, output_config: { effort: 'low' }, system, messages: [{ role: 'user', content: String(question).slice(0, 300) }] }),
      });
      if (!r.ok) { console.error('claude', model, r.status); continue; }
      const data = await r.json();
      const text = (data.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim();
      if (!text) continue;
      const reply = gsm(text).slice(0, 560);
      const u = data.usage || {};
      // counts only, no message text (see pilot item 14)
      fetch(`${URL_}/rest/v1/agent_logs`, { method: 'POST', headers: { ...svc, Prefer: 'return=minimal' },
        body: JSON.stringify({ agent: 'tutor', action: simulated ? 'ussd question (simulator)' : 'ussd question', tokens_in: u.input_tokens, tokens_out: u.output_tokens, model }) }).catch(() => {});
      if (learner && learner.taking_part && !simulated) {
        await rpc('pilot_save_exchange', { p: { learner_id: learner.id, kind: 'chat', subject, topic: 'Asked by USSD', question: String(question).slice(0, 1000), reply, model } }).catch(() => {});
      }
      return reply;
    } catch (e) {
      console.error('claude', model, (e as Error).message);
    } finally { clearTimeout(timer); }
  }
  return 'Sorry, the agent could not answer just now. Please try again in a few minutes.';
}

const hits = new Map<string, { t: number; n: number }>();
function limited(key: string, max = 40): boolean {
  const now = Date.now();
  const rec = hits.get(key);
  if (!rec || now - rec.t > 60_000) { hits.set(key, { t: now, n: 1 }); return false; }
  rec.n++;
  return rec.n > max;
}

async function isAdmin(token: string): Promise<boolean> {
  if (!token) return false;
  try { return (await rpc('pilot_is_admin', {}, { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' })) === true; }
  catch { return false; }
}

async function read(req: Request): Promise<Record<string, any>> {
  const type = req.headers.get('content-type') || '';
  if (type.includes('application/json')) return await req.json().catch(() => ({}));
  const form = new URLSearchParams(await req.text());
  return Object.fromEntries(form.entries());
}

export async function handle(req: Request): Promise<Response> {
  const origin = req.headers.get('origin') || '';
  const cors: Record<string, string> = {
    'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-ussd-key',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const reply = (text: string, end: boolean, status = 200) =>
    new Response((end ? 'END ' : 'CON ') + text, { status, headers: { ...cors, 'Content-Type': 'text/plain; charset=utf-8' } });
  if (req.method !== 'POST') return reply('K12Plus USSD', true, 405);

  const body = await read(req);
  const simulated = body.simulate === true || body.simulate === 'true';
  if (simulated) {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!(await isAdmin(token))) return reply('Only K-12 EdTech administrators can use the simulator.', true, 403);
  } else {
    const secret = Deno.env.get('USSD_SECRET') || '';
    const given = new URL(req.url).searchParams.get('key') || req.headers.get('x-ussd-key') || '';
    if (!secret) return reply('K12Plus on USSD is being connected for the pilot. Please try again soon.', true, 503);
    if (given !== secret) return reply('Not allowed.', true, 401);
  }

  const sessionId = String(body.sessionId || body.session_id || '').slice(0, 90);
  const digits = phoneDigits(String(body.phoneNumber || body.msisdn || body.phone || ''));
  if (!sessionId || digits.length < 9) return reply('Something went wrong. Please dial *141*12# again.', true, 400);
  const hash = await phoneHash(digits);
  if (limited(hash)) return reply('Too many screens in one minute. Please wait a moment and dial *141*12# again.', true, 429);

  try {
    const sid = (simulated ? 'sim-' : '') + sessionId;
    const sess = await rpc('pilot_ussd_session', { p_session: sid, p_phone_hash: hash, p_simulated: simulated });
    const learners: Learner[] = await rpc('pilot_ussd_who', { p_phone: digits });
    const segs = String(body.text ?? '').length ? String(body.text).split('*') : [];
    let steps = sess.steps || 0;
    let shortcut: string | null = null;
    const code = String(body.serviceCode || '').match(/^\*141\*12\*([1-4])#$/);
    if (!sess.state || !sess.state.started) {
      if (code) shortcut = code[1];
      else if (segs.length && steps === 0) { shortcut = segs[0]; steps = 1; } // dialled *141*12*1#: the gateway passes the 1 as text
    }
    const inputs = segs.slice(steps);
    const deps: Deps = {
      sessionId: sid, simulated, askedToday: sess.asked_today || 0, learners,
      packs: checkedPacks,
      results: (id) => rpc('pilot_ussd_results', { p_learner: id }),
      join: (id, c) => rpc('pilot_ussd_join', { p_learner: id, p_code: c }),
      ask: (subject, q, l) => askAgent(subject, q, l, simulated),
      record: async (id, events) => { await rpc('pilot_ussd_record', { p_learner: id, p_events: events }); },
      random: Math.random,
    };
    const out = await run(sess.state || {}, inputs, deps, { shortcut });
    await rpc('pilot_ussd_save', { p_session: sid, p_state: out.state, p_steps: segs.length, p_learner: out.state.learner || null, p_ai: out.aiAsked });
    return reply(out.text, out.end);
  } catch (e) {
    console.error('ussd', (e as Error).message);
    return reply('Sorry, something went wrong. Please dial *141*12# again.', true, 500);
  }
}

// USSD_TEST_PORT is set only by the automated tests
const testPort = Deno.env.get('USSD_TEST_PORT');
if (testPort) Deno.serve({ port: Number(testPort) }, handle); else Deno.serve(handle);

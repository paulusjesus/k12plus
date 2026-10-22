// Supabase Edge Function `agent-messenger`
// The only way the agents send a message to a learner or a teacher.
//
//  action "send"   (server only: called with the service role key by the
//                   scheduled jobs for follow-ups and Monday summaries)
//      1. content check: fixed rules, then a short review by Claude Haiku.
//         If the review cannot run, the message is blocked (fail closed).
//      2. pilot_log_message(): consent, pause, allowed hours, weekly limits.
//         Every attempt is logged, sent or blocked.
//      3. delivery: in-app messages are delivered by the database. Text
//         messages and emails go to a provider once one is connected.
//
//  action "check"  (administrator): runs only the content check on a draft,
//                   so wording can be tried without sending anything.

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';
const ANTHROPIC_WORKSPACE = Deno.env.get('ANTHROPIC_WORKSPACE_ID') || '';
const ANTHROPIC_URL = Deno.env.get('ANTHROPIC_URL') || 'https://api.anthropic.com/v1/messages';
const SMS_PROVIDER = Deno.env.get('SMS_PROVIDER') || '';
const EMAIL_PROVIDER = Deno.env.get('EMAIL_PROVIDER') || '';
const CHECK_MODEL = 'claude-haiku-5-5';
const ORIGINS = ['https://k12plus.app', 'https://www.k12plus.app', 'https://k12edu.io', 'https://www.k12edu.io'];

export const LEARNER_MAX = 320; // about two text messages
const BLOCKED_WORDS = [
  'sex', 'sexy', 'nude', 'naked', 'porn', 'kiss', 'date me', 'boyfriend', 'girlfriend', 'babe', 'darling',
  'kill', 'suicide', 'weapon', 'gun', 'knife', 'drugs', 'alcohol', 'beer', 'drunk', 'dagga', 'bet', 'betting', 'gamble',
  'stupid', 'idiot', 'dumb', 'lazy', 'useless', 'hate',
  'damn', 'hell', 'shit', 'fuck', 'bitch',
];
const ASKS_FOR_PERSONAL = /(your (password|pin|address|home|location|photo|picture|selfie|bank|account)|send me (a|your)|meet (me|up)|where do you live|whatsapp me|call me)/i;

export type Verdict = { ok: boolean; reason: string };

// Fixed rules: fast, free, and the same every time
export function contentRules(text: string, recipient: 'learner' | 'teacher'): Verdict {
  const s = String(text || '').trim();
  if (!s) return { ok: false, reason: 'empty message' };
  if (recipient === 'learner' && s.length > LEARNER_MAX) return { ok: false, reason: `longer than ${LEARNER_MAX} characters` };
  const urls = s.match(/(https?:\/\/\S+|www\.\S+|\b[a-z0-9-]+\.(com|net|org|io|co|na|za|ly|me|app)\b\S*)/gi) || [];
  if (urls.some((u) => !/^(https?:\/\/)?(www\.)?k12plus\.app\b/i.test(u))) return { ok: false, reason: 'contains a link' };
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(s)) return { ok: false, reason: 'contains an email address' };
  if (/(\+?\d[\d\s-]{6,}\d)/.test(s.replace(/\b\d{1,3}\s?[x×*+\-−=]\s?\d{1,3}\b/g, ''))) return { ok: false, reason: 'contains a phone number' };
  const lower = s.toLowerCase();
  const word = BLOCKED_WORDS.find((w) => new RegExp(`(^|[^a-z])${w.replace(/ /g, '\\s+')}([^a-z]|$)`, 'i').test(lower));
  if (word) return { ok: false, reason: `contains a word that is not allowed (${word})` };
  if (ASKS_FOR_PERSONAL.test(s)) return { ok: false, reason: 'asks for personal information or contact' };
  return { ok: true, reason: '' };
}

const REVIEW_PROMPT = `You review short messages before an AI learning agent sends them. The readers are secondary school learners aged 14 to 19 in Namibia, or their teachers.
Approve a message only if ALL of these are true:
- it is about school learning, practice, or encouragement to keep learning;
- it is kind and respectful, and never shames, threatens, pressures or guilt-trips;
- it contains nothing romantic, sexual, violent, frightening or otherwise unsuitable for a 14-year-old;
- it does not ask for personal information, money, photos, or contact outside K12Plus, and does not suggest meeting;
- it gives no medical, legal, financial or religious advice;
- it contains no links (other than k12plus.app), phone numbers or email addresses.
Reply with JSON only, nothing else: {"ok": true or false, "reason": "a few words"}`;

export function parseVerdict(text: string): Verdict | null {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (typeof j.ok !== 'boolean') return null;
    return { ok: j.ok, reason: String(j.reason || '').slice(0, 200) };
  } catch {
    return null;
  }
}

async function aiReview(text: string): Promise<Verdict> {
  if (!ANTHROPIC_KEY) return { ok: false, reason: 'content review unavailable (no AI key)' };
  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01',
    };
    if (ANTHROPIC_WORKSPACE) headers['anthropic-workspace-id'] = ANTHROPIC_WORKSPACE;
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST', headers,
      body: JSON.stringify({
        model: CHECK_MODEL, max_tokens: 200, system: REVIEW_PROMPT,
        messages: [{ role: 'user', content: 'Message to review:\n"""\n' + text + '\n"""' }],
      }),
    });
    if (!r.ok) return { ok: false, reason: `content review unavailable (${r.status})` };
    const j = await r.json();
    const out = (j.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    return parseVerdict(out) || { ok: false, reason: 'content review gave no clear answer' };
  } catch {
    return { ok: false, reason: 'content review unavailable (network)' };
  }
}

export async function contentCheck(text: string, recipient: 'learner' | 'teacher'): Promise<Verdict> {
  const fixed = contentRules(text, recipient);
  if (!fixed.ok) return fixed;
  return aiReview(text);
}

const svcHeaders = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
async function rpc(fn: string, args: unknown) {
  const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, { method: 'POST', headers: svcHeaders, body: JSON.stringify(args) });
  if (!r.ok) throw new Error(`rpc ${fn} ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

function jwtRole(token: string): string {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(part + '==='.slice((part.length + 3) % 4))).role || '';
  } catch {
    return '';
  }
}

// Text message and email providers plug in here once chosen.
async function deliver(channel: string, _logId: number): Promise<{ ok: boolean; ref: string | null; cost: number | null }> {
  if (channel === 'sms' && SMS_PROVIDER) { /* provider adapter goes here */ }
  if (channel === 'email' && EMAIL_PROVIDER) { /* provider adapter goes here */ }
  return { ok: false, ref: channel === 'sms' ? 'sms_not_connected' : 'email_not_connected', cost: null };
}

const CHANNELS = ['in_app', 'sms', 'email'];
const PURPOSES = ['follow_up', 'monday_summary', 'consent_request', 'test'];

async function send(body: any) {
  const recipient = body.teacherId ? 'teacher' : 'learner';
  const id = String(recipient === 'teacher' ? body.teacherId : body.learnerId || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return [400, { error: 'learnerId or teacherId required' }];
  if (!CHANNELS.includes(body.channel)) return [400, { error: 'channel must be in_app, sms or email' }];
  if (!PURPOSES.includes(body.purpose)) return [400, { error: 'unknown purpose' }];
  const text = String(body.text || '').trim();
  const verdict = await contentCheck(text, recipient);
  const result = await rpc('pilot_log_message', { p: {
    recipient_kind: recipient,
    learner_id: recipient === 'learner' ? id : null,
    teacher_id: recipient === 'teacher' ? id : null,
    channel: body.channel, purpose: body.purpose, body: text || '(empty)',
    content_ok: verdict.ok, content_reason: verdict.reason || null,
  } });
  if (result.status === 'approved') {
    const d = await deliver(body.channel, result.id);
    await rpc('pilot_mark_delivery', { p_id: result.id, p_ok: d.ok, p_provider_ref: d.ref, p_cost: d.cost });
    result.status = d.ok ? 'sent' : 'failed';
    if (!d.ok) result.reason = d.ref;
  }
  return [200, { ...result, content: verdict }];
}

async function check(req: Request, body: any) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const ur = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
  if (!ur.ok) return [401, { error: 'Please log in again.' }];
  const u = await ur.json();
  const pr = await fetch(`${URL_}/rest/v1/profiles?select=role&id=eq.${u.id}`, { headers: svcHeaders });
  const [me] = pr.ok ? await pr.json() : [];
  if (me?.role !== 'admin') return [403, { error: 'Only K-12 EdTech administrators can test message wording.' }];
  const verdict = await contentCheck(String(body.text || ''), body.recipient === 'teacher' ? 'teacher' : 'learner');
  return [200, verdict];
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('origin') || '';
  const cors = {
    'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  try {
    if (body.action === 'send') {
      const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (!(token === SERVICE || jwtRole(token) === 'service_role')) return json(403, { error: 'server only' });
      const [s, b] = await send(body);
      return json(s as number, b);
    }
    if (body.action === 'check') { const [s, b] = await check(req, body); return json(s as number, b); }
    return json(400, { error: 'unknown action' });
  } catch (e) {
    console.error('agent-messenger failed', (e as Error).message);
    return json(500, { error: 'Something went wrong.' });
  }
});

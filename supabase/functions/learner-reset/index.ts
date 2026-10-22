// Supabase Edge Function `learner-reset`
// Password reset for learners who have no email address.
//
//  action "issue"  (signed-in parent or verified teacher)
//      A parent linked to the learner, or a verified educator at the learner's
//      school, gets a one-time 6-character code for that learner. The code is
//      valid for 30 minutes, works once, and allows 5 tries. Only a hash is stored.
//  action "redeem" (anyone)
//      The learner sends their mobile number or k12plus ID, the code and a new
//      password. If the code matches, the password is changed.

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const ORIGINS = ['https://k12plus.app', 'https://www.k12plus.app', 'https://k12edu.io', 'https://www.k12edu.io'];
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const CODE_MINUTES = 30;
const MAX_TRIES = 5;
const MAX_ISSUED_PER_HOUR = 10;
const STAFF_ROLES = ['educator', 'school_admin', 'principal', 'hod'];
const BAD_CODE = 'That code is not valid or has expired. Ask your parent or teacher for a new one.';

const hits = new Map<string, { t: number; n: number }>();
function limited(key: string, max: number): boolean {
  const now = Date.now();
  const rec = hits.get(key);
  if (!rec || now - rec.t > 60_000) { hits.set(key, { t: now, n: 1 }); return false; }
  rec.n++;
  return rec.n > max;
}

export function phoneCandidates(raw: string): string[] {
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length < 7) return [];
  if (d.startsWith('0')) return ['264' + d.slice(1), '27' + d.slice(1)];
  return [d];
}

export function normaliseCode(c: string): string {
  return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes).map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

const svcHeaders = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { ...svcHeaders, Prefer: 'return=representation', ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`rest ${path.split('?')[0]} ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

async function issue(req: Request, body: any) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const ur = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
  if (!ur.ok) return [401, { error: 'Please log in again, then create the code.' }];
  const caller = (await ur.json()) as { id: string };

  const [me] = await rest(`profiles?select=id,role,school_id,linked_children,verified_educator&id=eq.${caller.id}`);
  const uid = String(body.learnerId || '').trim().toUpperCase();
  if (!/^K12-(NA|ZA)-[A-Z0-9]{6}$/.test(uid)) return [400, { error: 'Enter the learner\'s k12plus ID, for example K12-NA-AB12CD.' }];
  const [learner] = await rest(`profiles?select=id,role,school_id,username,learner_uid&learner_uid=eq.${uid}`);

  const linked = (me?.linked_children || []).map((x: string) => String(x).toUpperCase());
  const parentOk = me?.role === 'parent' && linked.includes(uid);
  const teacherOk = STAFF_ROLES.includes(me?.role) && me?.verified_educator === true && !!me?.school_id && me.school_id === learner?.school_id;
  if (!learner || learner.role !== 'learner' || !(parentOk || teacherOk)) {
    const why = STAFF_ROLES.includes(me?.role) && !me?.verified_educator
      ? 'Your educator account is not verified yet. Ask K12Plus to verify it, then try again.'
      : 'You can create codes only for your own linked learners (parents) or for learners at your school (verified teachers).';
    return [403, { error: why }];
  }

  const since = new Date(Date.now() - 3600_000).toISOString();
  const recent = await rest(`reset_codes?select=id&issued_by=eq.${me.id}&created_at=gte.${since}`);
  if ((recent || []).length >= MAX_ISSUED_PER_HOUR) return [429, { error: 'You have created many codes this hour. Please try again later.' }];

  // any earlier unused code for this learner stops working
  await rest(`reset_codes?learner_id=eq.${learner.id}&used_at=is.null`, { method: 'PATCH', body: JSON.stringify({ expires_at: new Date().toISOString() }) });
  const code = newCode();
  await rest('reset_codes', {
    method: 'POST',
    body: JSON.stringify({
      learner_id: learner.id, issued_by: me.id, code_hash: await sha256(`${learner.id}:${code}`),
      expires_at: new Date(Date.now() + CODE_MINUTES * 60_000).toISOString(),
    }),
  });
  const firstName = String(learner.username || '').trim().split(/\s+/)[0] || 'the learner';
  return [200, { code, learnerName: firstName, expiresInMinutes: CODE_MINUTES }];
}

async function redeem(body: any) {
  const identifier = String(body.identifier || '').trim().slice(0, 80);
  const code = normaliseCode(body.code);
  const password = String(body.password || '');
  if (password.length < 6) return [400, { error: 'Your new password needs at least 6 characters.' }];
  if (!identifier || code.length !== 6) return [400, { error: BAD_CODE }];

  let learners: { id: string }[] = [];
  if (/^K12-(NA|ZA)-[A-Z0-9]{6}$/i.test(identifier)) {
    learners = await rest(`profiles?select=id&role=eq.learner&learner_uid=eq.${identifier.toUpperCase()}`);
  } else {
    const phones = phoneCandidates(identifier);
    if (!phones.length) return [400, { error: BAD_CODE }];
    learners = await rest(`profiles?select=id&role=eq.learner&phone_e164=in.(${phones.join(',')})&limit=6`);
  }
  const now = new Date().toISOString();
  for (const l of learners || []) {
    const rows = await rest(`reset_codes?select=id,code_hash,attempts&learner_id=eq.${l.id}&used_at=is.null&expires_at=gt.${now}&attempts=lt.${MAX_TRIES}&order=created_at.desc&limit=1`);
    const row = rows && rows[0];
    if (!row) continue;
    if (row.code_hash === await sha256(`${l.id}:${code}`)) {
      const pr = await fetch(`${URL_}/auth/v1/admin/users/${l.id}`, { method: 'PUT', headers: svcHeaders, body: JSON.stringify({ password }) });
      if (!pr.ok) throw new Error(`password update ${pr.status}: ${(await pr.text()).slice(0, 160)}`);
      await rest(`reset_codes?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify({ used_at: now }) });
      return [200, { ok: true }];
    }
    await rest(`reset_codes?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify({ attempts: row.attempts + 1 }) });
  }
  return [400, { error: BAD_CODE }];
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('origin') || '';
  const cors = {
    'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  const ip = (req.headers.get('x-forwarded-for') || 'x').split(',')[0].trim();
  if (limited(ip, 10)) return json(429, { error: 'Too many attempts. Please wait a minute and try again.' });

  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  try {
    if (body.action === 'issue') { const [s, b] = await issue(req, body); return json(s as number, b); }
    if (body.action === 'redeem') { const [s, b] = await redeem(body); return json(s as number, b); }
    return json(400, { error: 'unknown action' });
  } catch (e) {
    console.error('learner-reset failed', (e as Error).message);
    return json(500, { error: 'Something went wrong. Please try again.' });
  }
});

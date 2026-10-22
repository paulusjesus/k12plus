// Supabase Edge Function `auth-login`
// Lets learners log in with a mobile number or their k12plus ID instead of an
// email address. The browser never learns which email an account uses: this
// function looks the account up with the service role, tries the password
// against Supabase Auth, and returns the session only when the password matches.
//
// Identifier forms:
//   K12-NA-ABC123         k12plus ID (profiles.learner_uid)
//   +264 81 234 5678      mobile number, any spacing; 081 234 5678 is tried as
//   081 234 5678          Namibia (+264) and South Africa (+27)
//   John Shikongo         legacy accounts created before 22 Oct 2026, whose
//                         login address was built from the name

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const ORIGINS = ['https://k12plus.app', 'https://www.k12plus.app', 'https://k12edu.io', 'https://www.k12edu.io'];
const MAX_CANDIDATES = 6; // a family phone may be shared by several learners
const GENERIC = 'Those details do not match a k12plus account. Check your number or ID and password.';

const hits = new Map<string, { t: number; n: number }>();
function limited(ip: string): boolean {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.t > 60_000) { hits.set(ip, { t: now, n: 1 }); return false; }
  rec.n++;
  return rec.n > 10; // 10 attempts per minute per IP
}

export function phoneCandidates(raw: string): string[] {
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length < 7) return [];
  if (d.startsWith('0')) return ['264' + d.slice(1), '27' + d.slice(1)];
  return [d];
}

export function legacyEmail(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_]/g, '') + '@learners.k12edu.io';
}

async function admin(path: string) {
  const r = await fetch(`${URL_}${path}`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
  return r.ok ? r.json() : null;
}

async function emailsFor(identifier: string): Promise<string[]> {
  const id = identifier.trim();
  let ids: string[] = [];
  if (/^K12-(NA|ZA)-[A-Z0-9]{6}$/i.test(id)) {
    const rows = await admin(`/rest/v1/profiles?select=id&learner_uid=eq.${encodeURIComponent(id.toUpperCase())}&limit=1`);
    ids = (rows || []).map((r: any) => r.id);
  } else {
    const phones = phoneCandidates(id);
    if (phones.length && !/[a-z]/i.test(id)) {
      const rows = await admin(`/rest/v1/profiles?select=id&phone_e164=in.(${phones.join(',')})&order=created_at.desc&limit=${MAX_CANDIDATES}`);
      ids = (rows || []).map((r: any) => r.id);
    } else if (/[a-z]/i.test(id)) {
      return [legacyEmail(id)];
    }
  }
  const emails: string[] = [];
  for (const uid of ids) {
    const u = await admin(`/auth/v1/admin/users/${uid}`);
    if (u && u.email) emails.push(u.email);
  }
  return emails;
}

async function passwordGrant(email: string, password: string) {
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON },
    body: JSON.stringify({ email, password }),
  });
  return r.ok ? r.json() : null;
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('origin') || '';
  const cors = {
    'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const ip = (req.headers.get('x-forwarded-for') || 'x').split(',')[0].trim();
  if (limited(ip)) return json({ error: 'Too many attempts. Please wait a minute and try again.' }, 429);

  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const identifier = String(body.identifier || '').slice(0, 80);
  const password = String(body.password || '');
  if (!identifier || !password) return json({ error: GENERIC }, 400);

  try {
    const emails = await emailsFor(identifier);
    for (const email of emails) {
      const session = await passwordGrant(email, password);
      if (session && session.access_token) return json(session);
    }
    return json({ error: GENERIC }, 400);
  } catch (e) {
    console.error('auth-login failed', (e as Error).message);
    return json({ error: 'Could not log you in right now. Please try again.' }, 500);
  }
});

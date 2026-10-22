// Supabase Edge Function `pilot-admin`
// Pilot tasks that need the server to create accounts. Everything else in the
// pilot structure runs through the pilot_* database functions.
//
//  action "new_learner"  (signed-in teacher of the class, or administrator)
//      Creates an account for a learner who has no smartphone or no account yet,
//      using their name and mobile number, and adds them to the class. The
//      learner reaches the agents by USSD with that number, or can later set a
//      password with a reset code from their teacher.

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const ORIGINS = ['https://k12plus.app', 'https://www.k12plus.app', 'https://k12edu.io', 'https://www.k12edu.io'];
const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const hits = new Map<string, { t: number; n: number }>();
function limited(key: string, max: number): boolean {
  const now = Date.now();
  const rec = hits.get(key);
  if (!rec || now - rec.t > 60_000) { hits.set(key, { t: now, n: 1 }); return false; }
  rec.n++;
  return rec.n > max;
}

export function phoneCandidates(raw: string): string[] {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length < 7) return [];
  if (d.startsWith('0')) return ['264' + d.slice(1), '27' + d.slice(1)];
  return [d];
}

// Namibian mobile numbers start with 08 (081 MTC, 085 TN Mobile), also accepted with +264
export function validNamibianMobile(raw: string): boolean {
  const d = String(raw || '').replace(/\D/g, '');
  return /^08\d{8}$/.test(d) || /^2648\d{8}$/.test(d) || /^002648\d{8}$/.test(d);
}

export function cleanName(raw: string): string {
  return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

function randomFrom(chars: string, n: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes).map((b) => chars[b % chars.length]).join('');
}

const svcHeaders = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { ...svcHeaders, Prefer: 'return=representation', ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`rest ${path.split('?')[0]} ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

async function newLearner(req: Request, body: any) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const ur = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
  if (!ur.ok) return [401, { error: 'Please log in again, then add the learner.' }];
  const caller = (await ur.json()) as { id: string };

  const classId = String(body.classId || '');
  if (!/^[0-9a-f-]{36}$/i.test(classId)) return [400, { error: 'Choose a class first.' }];
  const [cls] = await rest(`classes?select=id,school_id,grade,name&id=eq.${classId}`);
  if (!cls) return [404, { error: 'Class not found.' }];
  const [me] = await rest(`profiles?select=id,role&id=eq.${caller.id}`);
  const teaches = await rest(`class_teachers?select=teacher_id&class_id=eq.${classId}&teacher_id=eq.${caller.id}`);
  if (!(me?.role === 'admin' || (teaches || []).length)) return [403, { error: 'Only this class\'s teachers can add learners.' }];

  const name = cleanName(body.name);
  if (name.length < 2) return [400, { error: 'Enter the learner\'s name.' }];
  const phone = String(body.phone || '').trim();
  if (!validNamibianMobile(phone)) return [400, { error: 'Enter a Namibian mobile number, for example 081 234 5678.' }];

  // Siblings may share a phone, but the same name on the same number is almost certainly the same learner.
  const same = await rest(`profiles?select=learner_uid,username&role=eq.learner&phone_e164=in.(${phoneCandidates(phone).join(',')})&limit=10`);
  const dup = (same || []).find((p: any) => String(p.username || '').toLowerCase() === name.toLowerCase());
  if (dup) return [409, { error: `${dup.username} already has an account (${dup.learner_uid}). Add them with that k12plus ID instead.` }];

  let learnerUid = '';
  for (let i = 0; i < 5 && !learnerUid; i++) {
    const cand = 'K12-NA-' + randomFrom(ID_CHARS, 6);
    const taken = await rest(`profiles?select=id&learner_uid=eq.${cand}`);
    if (!(taken || []).length) learnerUid = cand;
  }
  if (!learnerUid) throw new Error('could not create a k12plus ID');

  // The password is random and never shown: the learner uses USSD with this number,
  // or gets a reset code from the teacher to set their own password for the app.
  const ar = await fetch(`${URL_}/auth/v1/admin/users`, {
    method: 'POST', headers: svcHeaders,
    body: JSON.stringify({ email: learnerUid.toLowerCase() + '@learners.k12edu.io', password: randomFrom(ID_CHARS, 24), email_confirm: true }),
  });
  if (!ar.ok) throw new Error(`create user ${ar.status}: ${(await ar.text()).slice(0, 160)}`);
  const user = await ar.json();
  try {
    await rest('profiles', {
      method: 'POST',
      body: JSON.stringify({ id: user.id, username: name, role: 'learner', grade: cls.grade, school_id: cls.school_id, phone, country: 'Namibia', learner_uid: learnerUid }),
    });
    await rest('enrolments', {
      method: 'POST',
      body: JSON.stringify({ class_id: cls.id, learner_id: user.id, joined_via: 'teacher', enrolled_by: caller.id }),
    });
  } catch (e) {
    await fetch(`${URL_}/auth/v1/admin/users/${user.id}`, { method: 'DELETE', headers: svcHeaders });
    throw e;
  }
  return [200, { ok: true, learnerUid, name, className: cls.name }];
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
  if (limited(ip, 60)) return json(429, { error: 'Too many requests. Please wait a minute and try again.' });

  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  try {
    if (body.action === 'new_learner') { const [s, b] = await newLearner(req, body); return json(s as number, b); }
    return json(400, { error: 'unknown action' });
  } catch (e) {
    console.error('pilot-admin failed', (e as Error).message);
    return json(500, { error: 'Something went wrong. Please try again.' });
  }
});

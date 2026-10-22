// Supabase Edge Function `pilot-admin`
// Pilot tasks that need the server to create accounts. Everything else in the
// pilot structure runs through the pilot_* database functions.
//
//  action "new_learner"  (signed-in teacher of the class, or administrator)
//      Creates an account for a learner who has no smartphone or no account yet,
//      using their name and mobile number, and adds them to the class. The
//      learner reaches the agents by USSD with that number, or can later set a
//      password with a reset code from their teacher.
//
//  action "record_consent"  (teacher of the learner's class, regional champion
//      for school consent, or administrator)
//      Stores a photo or PDF of a signed consent form in the private
//      consent-forms bucket and records the consent:
//        kind "guardian": a parent or guardian's consent for one learner
//        kind "school":   the principal's consent for the whole school
//
//  action "consent_form_url"  (administrator)
//      A link to one stored consent form that works for 5 minutes.

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

const RELATIONS = ['mother', 'father', 'guardian', 'grandparent', 'other'];
const MAX_FILE = 3 * 1024 * 1024;

export function fileKind(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf';
  return null;
}

// signed date: a real date, not in the future, not more than a year ago
export function validSignedOn(raw: string, now = new Date()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw || ''))) return false;
  const d = new Date(raw + 'T00:00:00Z');
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) return false;
  const today = new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z');
  return d.getTime() <= today.getTime() + 86_400_000 && today.getTime() - d.getTime() <= 366 * 86_400_000;
}

function b64ToBytes(b64: string): Uint8Array {
  const clean = String(b64 || '').replace(/^data:[^,]*,/, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function callerOf(req: Request): Promise<{ id: string; token: string } | null> {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const ur = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
  if (!ur.ok) return null;
  const u = await ur.json();
  return { id: u.id, token };
}

// ask the database, as the caller, whether they may manage this learner or school
async function callerMay(token: string, fn: string, args: Record<string, string>): Promise<boolean> {
  const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!r.ok) return false;
  return (await r.json()) === true;
}

async function recordConsent(req: Request, body: any) {
  const caller = await callerOf(req);
  if (!caller) return [401, { error: 'Please log in again, then record the consent.' }];
  const kind = body.kind === 'school' ? 'school' : body.kind === 'guardian' ? 'guardian' : '';
  if (!kind) return [400, { error: 'Choose school or parent consent.' }];
  const target = String(kind === 'school' ? body.schoolId : body.learnerId || '');
  if (!/^[0-9a-f-]{36}$/i.test(target)) return [400, { error: kind === 'school' ? 'Choose the school.' : 'Choose the learner.' }];

  const allowed = kind === 'school'
    ? await callerMay(caller.token, 'pilot_can_manage_school', { p_school: target })
    : await callerMay(caller.token, 'pilot_can_manage_learner', { p_learner: target });
  if (!allowed) {
    return [403, { error: kind === 'school'
      ? 'Only K-12 EdTech or the regional champion can record school consent.'
      : 'Only the learner\'s teachers or K-12 EdTech can record parent consent.' }];
  }

  const name = cleanName(body.givenByName);
  if (name.length < 2) return [400, { error: kind === 'school' ? 'Enter the principal\'s name.' : 'Enter the parent or guardian\'s name.' }];
  const relation = kind === 'school' ? 'principal' : String(body.relation || '').toLowerCase();
  if (kind === 'guardian' && !RELATIONS.includes(relation)) return [400, { error: 'Choose how they are related to the learner.' }];
  const signedOn = String(body.signedOn || '');
  if (!validSignedOn(signedOn)) return [400, { error: 'Enter the date the form was signed (not in the future, and within the last year).' }];

  let bytes: Uint8Array;
  try { bytes = b64ToBytes(body.file); } catch { return [400, { error: 'Attach a photo of the signed form.' }]; }
  if (!bytes.length) return [400, { error: 'Attach a photo of the signed form.' }];
  if (bytes.length > MAX_FILE) return [400, { error: 'The photo is too large. Please take it again.' }];
  const ext = fileKind(bytes);
  if (!ext) return [400, { error: 'The form must be a photo (JPEG or PNG) or a PDF.' }];

  const path = `${kind}/${target}/${Date.now()}.${ext}`;
  const up = await fetch(`${URL_}/storage/v1/object/consent-forms/${path}`, {
    method: 'POST',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': ext === 'pdf' ? 'application/pdf' : `image/${ext === 'jpg' ? 'jpeg' : 'png'}` },
    body: new Blob([bytes as BlobPart]),
  });
  if (!up.ok) throw new Error(`upload ${up.status}: ${(await up.text()).slice(0, 160)}`);

  const id = await rest('rpc/pilot_save_consent', {
    method: 'POST',
    body: JSON.stringify({ p: {
      kind, school_id: kind === 'school' ? target : null, learner_id: kind === 'guardian' ? target : null,
      given_by_name: name, given_by_relation: relation, method: 'paper_form', evidence_path: path,
      signed_on: signedOn, recorded_by: caller.id,
    } }),
  });
  return [200, { ok: true, consentId: id }];
}

async function consentFormUrl(req: Request, body: any) {
  const caller = await callerOf(req);
  if (!caller) return [401, { error: 'Please log in again.' }];
  const [me] = await rest(`profiles?select=role&id=eq.${caller.id}`);
  if (me?.role !== 'admin') return [403, { error: 'Only K-12 EdTech administrators can open consent forms.' }];
  const id = parseInt(String(body.consentId || ''), 10);
  if (!id) return [400, { error: 'Choose a consent record.' }];
  const [row] = await rest(`consents?select=evidence_path&id=eq.${id}`);
  if (!row?.evidence_path) return [404, { error: 'This consent has no stored form.' }];
  const r = await fetch(`${URL_}/storage/v1/object/sign/consent-forms/${row.evidence_path}`, {
    method: 'POST', headers: svcHeaders, body: JSON.stringify({ expiresIn: 300 }),
  });
  if (!r.ok) throw new Error(`sign ${r.status}`);
  const j = await r.json();
  return [200, { url: `${URL_}/storage/v1${j.signedURL}` }];
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
    if (body.action === 'record_consent') { const [s, b] = await recordConsent(req, body); return json(s as number, b); }
    if (body.action === 'consent_form_url') { const [s, b] = await consentFormUrl(req, body); return json(s as number, b); }
    return json(400, { error: 'unknown action' });
  } catch (e) {
    console.error('pilot-admin failed', (e as Error).message);
    return json(500, { error: 'Something went wrong. Please try again.' });
  }
});

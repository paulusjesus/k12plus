// Supabase Edge Function `account-admin`
// The account work in K12Plus Monitor that needs Supabase Auth: new accounts,
// temporary passwords, switching accounts off and on, and school logos.
//
// Who may do what is decided in the database, not here. Each request is first
// checked by account_authorise, called with the manager's own sign-in, so every
// rule (class, school, region or country; learners only by class and school
// managers) applies exactly as it does on screen. Only then does this function
// use the service key, and it reports the outcome with account_finish so the
// change log is complete.
//
//  action "create"              add a learner or a teacher, with a temporary password
//  action "reset_password"      give someone a temporary password
//  action "disable" / "enable"  stop or allow sign-in (nothing is deleted)
//  action "change_own_password" the signed-in person replaces their temporary password
//  action "logo"                a school manager uploads the school's logo

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const ORIGINS = ['https://k12plus.app', 'https://www.k12plus.app', 'https://monitor.k12plus.app', 'https://k12edu.io', 'https://www.k12edu.io'];
const MAX_LOGO = 300 * 1024;
const FOREVER = '876000h'; // about a hundred years: Supabase's way of saying "switched off"

const hits = new Map<string, { t: number; n: number }>();
function limited(key: string, max: number): boolean {
  const now = Date.now();
  const rec = hits.get(key);
  if (!rec || now - rec.t > 60_000) { hits.set(key, { t: now, n: 1 }); return false; }
  rec.n++;
  return rec.n > max;
}

// At least 8 characters with a letter and a number. Learners type these on basic
// phones too, so nothing stricter.
export function passwordProblem(p: string): string | null {
  const s = String(p || '');
  if (s.length < 8) return 'The password needs at least 8 characters.';
  if (s.length > 72) return 'The password can have at most 72 characters.';
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) return 'The password needs at least one letter and one number.';
  return null;
}

export function imageKind(b: Uint8Array): { ext: string; mime: string } | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { ext: 'png', mime: 'image/png' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return { ext: 'webp', mime: 'image/webp' };
  return null;
}

const svc = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };

// Calls a database function as the manager, so the database's own rules decide.
async function asManager(token: string, fn: string, args: unknown) {
  const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args),
  });
  const text = await r.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (!r.ok) {
    const msg = (data && data.message) || 'That could not be done.';
    throw Object.assign(new Error(msg), { status: r.status === 401 ? 401 : 403 });
  }
  return data;
}

async function finish(auditId: number, ok: boolean, result: Record<string, unknown> = {}) {
  const r = await fetch(`${URL_}/rest/v1/rpc/account_finish`, {
    method: 'POST', headers: svc, body: JSON.stringify({ p_audit: auditId, p_ok: ok, p_result: result }),
  });
  if (!r.ok) throw new Error(`finish ${r.status}: ${(await r.text()).slice(0, 160)}`);
}

async function updateAuthUser(id: string, body: Record<string, unknown>) {
  const r = await fetch(`${URL_}/auth/v1/admin/users/${id}`, { method: 'PUT', headers: svc, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`update user ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}

async function signedInUser(token: string) {
  const r = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
  return r.ok ? r.json() : null;
}

const UUID = /^[0-9a-f-]{36}$/i;

export async function handle(action: string, body: any, token: string): Promise<[number, unknown]> {
  if (action === 'change_own_password') {
    const user = await signedInUser(token);
    if (!user) return [401, { error: 'Please sign in again.' }];
    if (!user.app_metadata?.must_change_password) return [400, { error: 'Your password is not a temporary one. Change it from your profile in the app.' }];
    const problem = passwordProblem(body.new_password);
    if (problem) return [400, { error: problem }];
    if (body.new_password === body.temporary_password) return [400, { error: 'Choose a password that is different from the temporary one.' }];
    await updateAuthUser(user.id, { password: body.new_password, app_metadata: { must_change_password: false } });
    return [200, { ok: true }];
  }

  if (action === 'reset_password' || action === 'disable' || action === 'enable') {
    if (!UUID.test(String(body.user_id || ''))) return [400, { error: 'Choose an account first.' }];
    if (action === 'reset_password') {
      const problem = passwordProblem(body.temp_password);
      if (problem) return [400, { error: problem }];
    }
    const a = await asManager(token, 'account_authorise', { p_action: action, p_target: body.user_id, p: {} });
    try {
      if (action === 'reset_password') {
        await updateAuthUser(body.user_id, { password: body.temp_password, app_metadata: { must_change_password: true } });
      } else {
        await updateAuthUser(body.user_id, { ban_duration: action === 'disable' ? FOREVER : 'none' });
      }
    } catch (e) {
      await finish(a.audit_id, false, { error: (e as Error).message });
      throw e;
    }
    await finish(a.audit_id, true);
    return [200, { ok: true }];
  }

  if (action === 'create') {
    const problem = passwordProblem(body.temp_password);
    if (problem) return [400, { error: problem }];
    const p = {
      role: body.role, name: body.name, school_id: body.school_id, class_id: body.class_id || null,
      grade: body.grade ? Number(body.grade) : null, class_letter: body.class_letter || null,
      phone: body.phone || null, email: body.email || null,
    };
    const a = await asManager(token, 'account_authorise', { p_action: 'create', p_target: null, p });
    const cr = await fetch(`${URL_}/auth/v1/admin/users`, {
      method: 'POST', headers: svc,
      body: JSON.stringify({ email: a.email, password: body.temp_password, email_confirm: true, app_metadata: { must_change_password: true } }),
    });
    if (!cr.ok) {
      const text = await cr.text();
      const taken = cr.status === 422 || /already/i.test(text);
      await finish(a.audit_id, false, { error: taken ? 'email already used' : text.slice(0, 160) });
      return taken ? [409, { error: 'That email address already has a k12plus account.' }] : [500, { error: 'The account could not be created. Please try again.' }];
    }
    const user = await cr.json();
    try {
      await finish(a.audit_id, true, { user_id: user.id });
    } catch (e) {
      // the profile could not be written: remove the half-made sign-in so nothing is left behind
      await fetch(`${URL_}/auth/v1/admin/users/${user.id}`, { method: 'DELETE', headers: svc });
      throw e;
    }
    return [200, { ok: true, user_id: user.id, k12_id: a.learner_uid, name: a.name, signs_in_with: body.email ? a.email : a.learner_uid }];
  }

  if (action === 'logo') {
    if (!UUID.test(String(body.school_id || ''))) return [400, { error: 'Choose the school first.' }];
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(String(body.data || '')), (c) => c.charCodeAt(0));
    } catch {
      return [400, { error: 'That file could not be read.' }];
    }
    if (bytes.length > MAX_LOGO) return [400, { error: 'The logo must be smaller than 300 KB.' }];
    const kind = imageKind(bytes);
    if (!kind) return [400, { error: 'The logo must be a PNG, JPG or WebP picture.' }];
    const a = await asManager(token, 'account_authorise', { p_action: 'logo', p_target: null, p: { school_id: body.school_id } });
    const path = `${body.school_id}.${kind.ext}`;
    const up = await fetch(`${URL_}/storage/v1/object/school-logos/${path}`, {
      method: 'POST', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': kind.mime, 'x-upsert': 'true' }, body: bytes,
    });
    if (!up.ok) {
      await finish(a.audit_id, false, { error: `upload ${up.status}` });
      return [500, { error: 'The logo could not be saved. Please try again.' }];
    }
    const url = `${URL_}/storage/v1/object/public/school-logos/${path}?v=${Date.now()}`;
    await finish(a.audit_id, true, { url });
    return [200, { ok: true, url }];
  }

  return [400, { error: 'Unknown action.' }];
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('origin') || '';
  const cors = {
    'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const ip = (req.headers.get('x-forwarded-for') || 'x').split(',')[0].trim();
  if (limited(ip + token.slice(-16), 30)) return json({ error: 'Too many requests. Please wait a minute and try again.' }, 429);

  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  try {
    const [status, out] = await handle(String(body.action || ''), body, token);
    return json(out, status);
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.status) return json({ error: err.message }, err.status);
    console.error('account-admin failed', err.message);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});

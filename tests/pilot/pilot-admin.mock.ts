// Stand-in for Supabase (auth + REST) used to test the pilot-admin Edge Function.
const profiles: any[] = [
  { id: 'tch', role: 'educator', username: 'Ms Amutenya' },
  { id: 'other', role: 'educator', username: 'Mr Other' },
  { id: 'adm', role: 'admin', username: 'Admin' },
  { id: 'old', role: 'learner', username: 'Selma Nangolo', learner_uid: 'K12-NA-OLD111', phone_e164: '264813334444' },
];
const classes = [{ id: '11111111-1111-1111-1111-111111111111', school_id: 'S1', grade: 11, name: 'Grade 11 Mathematics' }];
const classTeachers = [{ class_id: classes[0].id, teacher_id: 'tch' }];
const enrolments: any[] = []; const users: any[] = []; const deleted: string[] = [];
let failEnrol = false;
const uploads: any[] = []; const consents: any[] = [];
const manageLearner: Record<string, string[]> = { tch: ['L1'], adm: ['L1', 'L2'] };
const manageSchool: Record<string, string[]> = { champ: ['22222222-2222-2222-2222-222222222222'], adm: ['22222222-2222-2222-2222-222222222222'] };
const e164 = (p: string) => { let d = p.replace(/\D/g, ''); if (d.startsWith('00')) d = d.slice(2); return d.startsWith('0') ? '264' + d.slice(1) : d; };
function match(row: any, sp: URLSearchParams) {
  for (const [k, v] of sp) {
    if (['select', 'order', 'limit'].includes(k)) continue;
    const val = row[k];
    if (v.startsWith('eq.') && String(val) !== v.slice(3)) return false;
    if (v.startsWith('in.(') && !v.slice(4, -1).split(',').includes(String(val))) return false;
  }
  return true;
}
Deno.serve({ port: 9997 }, async (req) => {
  const u = new URL(req.url); const sp = u.searchParams;
  if (u.pathname === '/auth/v1/user') { const t = (req.headers.get('authorization') || '').replace('Bearer ', ''); return t.startsWith('user:') ? Response.json({ id: t.slice(5) }) : new Response('{}', { status: 401 }); }
  if (u.pathname === '/rest/v1/profiles' && req.method === 'GET') return Response.json(profiles.filter((p) => match(p, sp)));
  if (u.pathname === '/rest/v1/profiles' && req.method === 'POST') { const b = await req.json(); const row = { ...b, phone_e164: e164(b.phone) }; profiles.push(row); return Response.json([row]); }
  if (u.pathname === '/rest/v1/classes') return Response.json(classes.filter((c) => match(c, sp)));
  if (u.pathname === '/rest/v1/class_teachers') return Response.json(classTeachers.filter((c) => match(c, sp)));
  if (u.pathname === '/rest/v1/enrolments' && req.method === 'POST') { if (failEnrol) return new Response('boom', { status: 500 }); const b = await req.json(); enrolments.push(b); return Response.json([b]); }
  if (u.pathname === '/auth/v1/admin/users' && req.method === 'POST') { const b = await req.json(); const row = { id: 'u' + (users.length + 1), ...b }; users.push(row); return Response.json(row); }
  const m = u.pathname.match(/^\/auth\/v1\/admin\/users\/(.+)$/);
  if (m && req.method === 'DELETE') { deleted.push(m[1]); return Response.json({}); }
  if (u.pathname === '/rest/v1/rpc/pilot_can_manage_learner') {
    const who = (req.headers.get('authorization') || '').replace('Bearer user:', ''); const b = await req.json();
    const ids: Record<string, string> = { '33333333-3333-3333-3333-333333333333': 'L1', '44444444-4444-4444-4444-444444444444': 'L2' };
    return Response.json((manageLearner[who] || []).includes(ids[b.p_learner]));
  }
  if (u.pathname === '/rest/v1/rpc/pilot_can_manage_school') {
    const who = (req.headers.get('authorization') || '').replace('Bearer user:', ''); const b = await req.json();
    return Response.json((manageSchool[who] || []).includes(b.p_school));
  }
  if (u.pathname.startsWith('/storage/v1/object/consent-forms/') && req.method === 'POST') {
    const bytes = new Uint8Array(await req.arrayBuffer());
    uploads.push({ path: u.pathname.replace('/storage/v1/object/consent-forms/', ''), type: req.headers.get('content-type'), size: bytes.length, auth: req.headers.get('authorization') });
    return Response.json({ Key: 'ok' });
  }
  if (u.pathname === '/rest/v1/rpc/pilot_save_consent') { const b = await req.json(); consents.push({ id: consents.length + 1, ...b.p }); return Response.json(consents.length); }
  if (u.pathname === '/rest/v1/consents') return Response.json(consents.filter((c) => match(c, sp)).map((c) => ({ evidence_path: c.evidence_path })));
  if (u.pathname.startsWith('/storage/v1/object/sign/consent-forms/')) return Response.json({ signedURL: '/object/sign/consent-forms/' + u.pathname.split('/consent-forms/')[1] + '?token=abc' });
  if (u.pathname === '/__state') return Response.json({ profiles, enrolments, users, deleted, uploads, consents });
  if (u.pathname === '/__failEnrol') { failEnrol = true; return Response.json({}); }
  return new Response('nf', { status: 404 });
});

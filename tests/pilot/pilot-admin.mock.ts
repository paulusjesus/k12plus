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
  if (u.pathname === '/__state') return Response.json({ profiles, enrolments, users, deleted });
  if (u.pathname === '/__failEnrol') { failEnrol = true; return Response.json({}); }
  return new Response('nf', { status: 404 });
});

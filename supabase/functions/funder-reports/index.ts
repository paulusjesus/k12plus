// Supabase Edge Function `funder-reports`
// Emails each funder its monthly K12Plus report. The reports themselves are built in the
// database on the 1st of each month (funds_build_reports), from exactly what the funder
// sees in K12Plus Monitor: the whole pilot in numbers, regions needing attention, and the
// funder's own grants. No learner names are ever in them.
//
// Who may call it:
//   the daily job, with the secret kept in the database vault (header x-k12-cron)
//   a K-12 EdTech administrator signed in to Monitor (action "build_send" builds last
//   month's reports first, then sends)
//
// Email is sent through Resend once RESEND_API_KEY is set as a secret of this function.
// Until then every report stays in Monitor, marked "email service not connected".

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const RESEND_KEY = Deno.env.get('RESEND_API_KEY') || '';
const RESEND_URL = Deno.env.get('RESEND_URL') || 'https://api.resend.com/emails'; // RESEND_URL only in tests
const FROM = Deno.env.get('REPORT_FROM') || 'K12Plus Monitor <monitor@k12plus.app>';
const REPLY_TO = Deno.env.get('REPORT_REPLY_TO') || 'info@k12plus.app';
const MONITOR = 'https://monitor.k12plus.app';
const ORIGINS = ['https://monitor.k12plus.app', 'https://k12plus.app', 'https://www.k12plus.app'];

const svc = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };

async function rpc(fn: string, args: unknown, headers: Record<string, string> = svc) {
  const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args) });
  const text = await r.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (!r.ok) throw new Error((data && (data.message || data.error)) || `${fn} failed (${r.status})`);
  return data;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function monthName(iso: string): string {
  const [y, m] = String(iso).slice(0, 7).split('-').map(Number);
  return `${MONTHS[(m || 1) - 1]} ${y}`;
}
export function money(n: number | null | undefined, cur: string): string {
  if (n == null) return 'none';
  const sym: Record<string, string> = { NAD: 'N$', USD: 'US$', ZAR: 'R', EUR: '€', GBP: '£' };
  return (sym[cur] || cur + ' ') + Number(n).toLocaleString('en-GB', { maximumFractionDigits: 0 });
}
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const fmt = (n: unknown) => Number(n || 0).toLocaleString('en-GB');

// The email for one report: a plain-text version and a simple HTML version with the same words.
export function reportEmail(rep: any, id: number) {
  const month = monthName(rep.month);
  const p = rep.pilot || {};
  const m = (p.series || []).find((x: any) => String(x.start).slice(0, 7) === String(rep.month).slice(0, 7)) || {};
  const lines: string[] = [];
  lines.push(`Dear colleagues at ${rep.funder},`);
  lines.push('');
  lines.push(`Here is the K12Plus pilot report for ${month}. Every figure is a number only, with no learner names, and any group of fewer than five learners is left out.`);
  lines.push('');
  lines.push('The pilot');
  if (!p.learners) {
    lines.push('No learners are taking part yet, so there are no learning figures this month.');
  } else {
    lines.push(`Learners taking part with consent: ${fmt(p.learners)}`);
    lines.push(`Learners active in the last 7 days: ${fmt(p.active_week)}`);
    lines.push(`Practice accuracy in ${month}: ${m.accuracy == null ? 'no practice yet' : m.accuracy + '%'}`);
    lines.push(`Minutes spent learning in ${month}: ${fmt(m.minutes)}`);
    lines.push(`Questions to the agents in ${month}: ${fmt(m.questions)}`);
  }
  const need = (rep.attention || []).filter((a: any) => !a.too_few && a.share > 0).slice(0, 3);
  if (need.length) {
    lines.push('');
    lines.push('Where support is most needed');
    for (const a of need) lines.push(`${a.name}: ${a.share}% of learners need attention (${a.count} of ${a.learners})`);
  }
  lines.push('');
  lines.push((rep.grants || []).length === 1 ? 'Your grant' : 'Your grants');
  if (!(rep.grants || []).length) lines.push('No grant is recorded for you yet.');
  for (const g of rep.grants || []) {
    lines.push(`${g.title}: ${money(g.amount, g.currency)} granted, ${money(g.spent, g.currency)} spent (${g.used_pct}%), ${money(g.remaining, g.currency)} remaining. ${g.time_pct}% of the grant period has passed.`);
  }
  lines.push('');
  lines.push(`The full report, with charts and every budget line, is in K12Plus Monitor: ${MONITOR}/#report/${id}`);
  lines.push('');
  lines.push('With thanks,');
  lines.push('The K12Plus team, K-Twelve Educational Technologies');
  const text = lines.join('\n');
  const html = '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#1F2033;max-width:620px">' +
    lines.map((l) => {
      if (!l) return '';
      if (/^(The pilot|Where support is most needed|Your grants?)$/.test(l)) return `<h3 style="font-size:16px;margin:18px 0 6px;color:#5A4BE0">${esc(l)}</h3>`;
      if (l.startsWith('The full report')) return `<p><a href="${MONITOR}/#report/${id}" style="color:#5A4BE0;font-weight:bold">Open the full report in K12Plus Monitor</a></p>`;
      return `<p style="margin:0 0 6px">${esc(l)}</p>`;
    }).join('') + '</div>';
  return { subject: `K12Plus pilot report for ${month}, ${rep.funder}`, text, html };
}

async function isAdmin(token: string): Promise<boolean> {
  const ur = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
  if (!ur.ok) return false;
  const u = await ur.json();
  const pr = await fetch(`${URL_}/rest/v1/profiles?select=role&id=eq.${encodeURIComponent(u.id)}`, { headers: svc });
  const rows = pr.ok ? await pr.json() : [];
  return rows.length === 1 && rows[0].role === 'admin';
}

export async function sendAll() {
  const list: any[] = (await rpc('funds_reports_to_send', {})) || [];
  const out = { sent: 0, waiting: 0, failed: 0, no_recipients: 0 };
  for (const item of list) {
    if (!item.to || !item.to.length) { await rpc('funds_report_mark', { p_id: item.id, p_status: 'no_recipients' }); out.no_recipients++; continue; }
    if (!RESEND_KEY) { await rpc('funds_report_mark', { p_id: item.id, p_status: 'no_email_service' }); out.waiting++; continue; }
    const mail = reportEmail(item.report, item.id);
    const r = await fetch(RESEND_URL, {
      method: 'POST', headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: item.to, reply_to: REPLY_TO, subject: mail.subject, text: mail.text, html: mail.html }),
    });
    if (r.ok) { await rpc('funds_report_mark', { p_id: item.id, p_status: 'sent' }); out.sent++; }
    else { await rpc('funds_report_mark', { p_id: item.id, p_status: 'failed', p_note: (await r.text()).slice(0, 300) }); out.failed++; }
  }
  return out;
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin') || '';
  const cors: Record<string, string> = {
    'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { body = {}; }
  try {
    const secret = req.headers.get('x-k12-cron');
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    let admin = false;
    if (secret) {
      if (!(await rpc('funds_cron_ok', { p_secret: secret }))) return json({ error: 'Not allowed.' }, 403);
    } else if (token && token !== ANON && (await isAdmin(token))) {
      admin = true;
    } else {
      return json({ error: 'Only K-12 EdTech can send funder reports.' }, 403);
    }
    let built: number | null = null;
    if (body.action === 'build_send') {
      if (!admin) return json({ error: 'Only K-12 EdTech can prepare funder reports.' }, 403);
      built = await rpc('funds_build_reports_now', {}, { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
    } else if (body.action !== 'send') {
      return json({ error: 'Unknown action.' }, 400);
    }
    const out = await sendAll();
    return json({ ok: true, built, ...out, email_service: !!RESEND_KEY });
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message || 'The reports could not be sent.' }, 500);
  }
});

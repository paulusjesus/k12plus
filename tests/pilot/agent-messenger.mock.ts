// Stand-in for Anthropic and Supabase, to test agent-messenger end to end
const calls: any = { anthropic: [], log: [], delivery: [] };
Deno.serve({ port: 9995 }, async (req) => {
  const u = new URL(req.url);
  if (u.pathname === '/v1/messages') {
    const b = await req.json();
    calls.anthropic.push({ model: b.model, key: req.headers.get('x-api-key'), ws: req.headers.get('anthropic-workspace-id'), hasTemp: 'temperature' in b });
    const text = b.messages[0].content;
    if (text.includes('REVIEW_DOWN')) return new Response('overloaded', { status: 529 });
    if (text.includes('REVIEW_GARBLE')) return Response.json({ content: [{ type: 'text', text: 'I think it is fine' }] });
    const okv = !text.includes('REVIEW_NO');
    return Response.json({ content: [{ type: 'text', text: JSON.stringify({ ok: okv, reason: okv ? 'on topic' : 'off topic' }) }] });
  }
  if (u.pathname === '/rest/v1/rpc/pilot_log_message') {
    const { p } = await req.json(); calls.log.push(p);
    const status = !p.content_ok ? 'blocked' : p.channel === 'in_app' ? 'sent' : 'approved';
    return Response.json({ id: calls.log.length, status, reason: p.content_ok ? null : 'content' });
  }
  if (u.pathname === '/rest/v1/rpc/pilot_mark_delivery') { calls.delivery.push(await req.json()); return new Response(null, { status: 204 }); }
  if (u.pathname === '/auth/v1/user') { const t = (req.headers.get('authorization') || '').replace('Bearer ', ''); return t.startsWith('user:') ? Response.json({ id: t.slice(5) }) : new Response('{}', { status: 401 }); }
  if (u.pathname === '/rest/v1/profiles') return Response.json(u.searchParams.get('id') === 'eq.adm' ? [{ role: 'admin' }] : [{ role: 'educator' }]);
  if (u.pathname === '/__calls') return Response.json(calls);
  return new Response('nf', { status: 404 });
});

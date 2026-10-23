// Stand-in for Supabase, to test the agent lock in the aim function
const calls: any[] = [];
Deno.serve({ port: 9994 }, async (req) => {
  const u = new URL(req.url);
  if (u.pathname === '/rest/v1/rpc/pilot_my_test_lock') {
    const auth = req.headers.get('authorization') || '';
    calls.push({ auth, apikey: req.headers.get('apikey') });
    if (auth === 'Bearer slow') { await new Promise((r) => setTimeout(r, 5000)); return Response.json(true); }
    if (auth === 'Bearer broken') return new Response('oops', { status: 500 });
    return Response.json(auth === 'Bearer locked');
  }
  if (u.pathname === '/__calls') return Response.json(calls);
  return new Response('{}', { status: 201 }); // agent_logs and anything else
});

// Stand-in for Supabase and Claude, to test the aim function's pilot features:
// the test lock (item 3) and keeping pilot learners' answers for review (item 9)
const calls: any = { context: [], saved: [], claude: 0 };
Deno.serve({ port: 9994 }, async (req) => {
  const u = new URL(req.url);
  if (u.pathname === '/rest/v1/rpc/pilot_agent_context') {
    const auth = req.headers.get('authorization') || '';
    calls.context.push({ auth, apikey: req.headers.get('apikey') });
    if (auth === 'Bearer slow') { await new Promise((r) => setTimeout(r, 5000)); return Response.json({ locked: true }); }
    if (auth === 'Bearer broken') return new Response('oops', { status: 500 });
    if (auth === 'Bearer locked') return Response.json({ locked: true, taking_part: true, learner_id: 'L-locked' });
    if (auth === 'Bearer pilot') return Response.json({ locked: false, taking_part: true, learner_id: 'L-pilot' });
    return Response.json({ locked: false, taking_part: false, learner_id: 'L-other' });
  }
  if (u.pathname === '/rest/v1/rpc/pilot_save_exchange') {
    calls.saved.push({ auth: req.headers.get('authorization'), body: (await req.json()).p });
    return Response.json({ stored: true });
  }
  if (u.pathname === '/v1/messages') { calls.claude++; return Response.json({ content: [{ type: 'text', text: 'Two plus two is four. 💡' }], usage: { input_tokens: 10, output_tokens: 8 } }); }
  if (u.pathname === '/__calls') return Response.json(calls);
  return new Response('{}', { status: 201 }); // agent_logs and anything else
});

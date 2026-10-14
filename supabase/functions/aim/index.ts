// @ts-nocheck
// GENERATED FILE: edit backend/index.js, then run `python3 backend/build-edge.py`.
// Supabase Edge Function `aim` (Deno). Thin adapter around the Cloud Run handler.
// deno-lint-ignore-file no-explicit-any

// process.env shim: Supabase provides SUPABASE_SERVICE_ROLE_KEY automatically.
const process: any = {
  env: new Proxy({}, {
    get: (_t, k) => {
      const key = String(k);
      if (key === 'SUPABASE_SERVICE_KEY') return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
      return Deno.env.get(key);
    },
  }),
};

// functions-framework shim: capture the handler registered with functions.http
let handler: any = null;
const functions = { http: (_name: string, h: any) => { handler = h; } };

/**
 * K12Plus AI Proxy. Runs as the Supabase Edge Function `aim` (generated from
 * this file by backend/build-edge.py) and can still run as a Google Cloud Run
 * function. All LLM calls go through the Anthropic Claude API.
 *
 * Actions: tutor | lesson_plan | generate_questions | ministry_brief | chat | chatimg
 * The frontend sends the relevant NIED syllabus objectives with each request
 * (single curriculum source of truth lives in the app bundle).
 *
 * Env vars (set at deploy, never in the repo):
 *  ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY (on Supabase: SUPABASE_SERVICE_ROLE_KEY)
 */


// Primary model favours answer quality (this is a tutor, quality matters most);
// the fallback is used if the primary errors, is rate-limited or overloaded.
// Note: current Claude models reject non-default temperature/top_p/top_k (400),
// and adaptive thinking is on by default and counts toward max_tokens, so we
// keep effort low for speed and leave generous max_tokens headroom.
const CLAUDE_MODELS = ['claude-sonnet-5-5', 'claude-haiku-5-5'];
const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_VERSION = '2023-06-01';
// statuses where trying the next model may help (400/404: model-specific rejection)
const RETRYABLE = [400, 404, 408, 429, 500, 502, 503, 504, 529];

const clip = (s, n) => String(s || '').slice(0, n);

// Claude needs non-empty turns that start with the learner, so drop blank
// turns and any leading tutor greeting the app keeps in its chat history.
function toClaudeMessages(messages) {
  const out = (messages || [])
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').trim() }))
    .filter((m) => m.content);
  while (out.length && out[0].role === 'assistant') out.shift();
  if (!out.length) out.push({ role: 'user', content: 'Hello' });
  return out;
}

// Single entry point for every Claude call. Returns text, token usage and the model used.
async function claudeRequest(systemText, claudeMessages, { maxTokens = 4096, effort = 'low' } = {}) {
  let lastErr = null;
  for (const model of CLAUDE_MODELS) {
    let res;
    try {
      res = await fetch(CLAUDE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': CLAUDE_VERSION,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          output_config: { effort },
          system: systemText,
          messages: claudeMessages,
        }),
      });
    } catch (e) {
      lastErr = `Claude network error (${model}): ${e.message}`;
      continue;
    }
    if (res.ok) {
      const data = await res.json();
      const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('').trim();
      if (!text) {
        lastErr = `Claude ${model} returned no text (stop_reason ${data.stop_reason})`;
        continue;
      }
      const u = data.usage || {};
      return { text, tokensIn: u.input_tokens, tokensOut: u.output_tokens, model, truncated: data.stop_reason === 'max_tokens' };
    }
    lastErr = `Claude ${model} ${res.status}: ${clip(await res.text(), 300)}`;
    console.error(lastErr);
    if (!RETRYABLE.includes(res.status)) break; // 401/403: key problem, the next model will not help
  }
  throw new Error(lastErr || 'Claude unavailable');
}

function callClaude(systemText, messages, maxTokens = 4096, effort = 'low') {
  return claudeRequest(systemText, toClaudeMessages(messages), { maxTokens, effort });
}

// For image questions: a single-turn call with the learner's photo attached.
function callClaudeWithImage(systemText, promptText, imageMime, imageBase64, maxTokens = 4096) {
  const content = [
    { type: 'image', source: { type: 'base64', media_type: imageMime || 'image/png', data: imageBase64 } },
    { type: 'text', text: promptText || 'Please help me with this.' },
  ];
  return claudeRequest(systemText, [{ role: 'user', content }], { maxTokens, effort: 'low' });
}

async function logAgent(entry) {
  try {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/agent_logs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: process.env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(entry),
    });
  } catch (e) {
    console.error('agent log failed', e.message);
  }
}

const parseJson = (t) => JSON.parse(t.replace(/^```json?\s*|```\s*$/g, ''));

functions.http('aim', async (req, res) => {
  var _origins = ['https://k12plus.app','https://www.k12plus.app','https://k12edu.io','https://www.k12edu.io'];
  var _o = (req.headers.origin || '');
  res.set('Access-Control-Allow-Origin', _origins.indexOf(_o) > -1 ? _o : _origins[0]);
  globalThis._rl = globalThis._rl || {};
  var _ip = String(req.headers['x-forwarded-for'] || 'x').split(',')[0];
  var _now = Date.now();
  var _rec = globalThis._rl[_ip];
  if (!_rec || _now - _rec.t > 60000) { _rec = { t: _now, n: 0 }; globalThis._rl[_ip] = _rec; }
  _rec.n++;
  if (_rec.n > 30) return res.status(429).json({ error: 'Too many requests, slow down.' });
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey, x-client-info');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'tutor not configured', detail: 'ANTHROPIC_API_KEY is not set' });
  }

  const {
    action, grade = 12, syllabus = '8227', topic = null,
    objectives = '', messages = [], kind = 'lesson_plan',
    count = 5, difficulty = 'mixed', stats = null, region = null,
    image = null,
  } = req.body || {};
  const sylName = syllabus === '8227' ? 'NSSCAS Mathematics 8227 (Advanced Subsidiary)' : 'NSSCO Mathematics 6131 (Ordinary Level)';
  const obj = clip(objectives, 6000);

  try {
    if (action === 'tutor') {
      const sys = `You are Kai, the AI Math Tutor (AIM) for Namibian learners, built by K-Twelve Educational Technologies.
You teach strictly according to the Namibian national curriculum set by NIED.
Current learner: Grade ${grade}, ${sylName}.
${topic ? `Current topic: ${topic}\nOfficial syllabus objectives (teach ONLY to this depth):\n${obj}` : ''}
Rules:
- Guide step-by-step. Never dump the final answer immediately; build understanding first.
- Calm, encouraging language. Learners may have maths anxiety. Never shame.
- Use "learners" not "students". Use Namibian context (N$, local names, real situations).
- Keep responses concise and mobile-friendly.
- If asked beyond syllabus depth, answer briefly and steer back to syllabus level.
- If the learner is stuck three times, break the problem into the smallest possible step.`;
      const out = await callClaude(sys, messages.slice(-12), 4096);
      await logAgent({
        agent: 'tutor', action: `answer grade ${grade} ${topic || 'general'}`,
        input_summary: clip(messages.at(-1)?.content, 200),
        output_summary: clip(out.text, 200),
        tokens_in: out.tokensIn, tokens_out: out.tokensOut, model: out.model,
      });
      return res.json({ reply: out.text });
    }

    if (action === 'lesson_plan') {
      if (!topic) return res.status(400).json({ error: 'topic required' });
      const shape = kind === 'scheme_of_work'
        ? '{"title":"","term":"","weeks":[{"week":1,"focus":"","objectives":[""],"activities":[""],"assessment":""}]}'
        : '{"title":"","duration":"40 minutes","objectives":[""],"materials":[""],"introduction":"","development":[{"step":"","minutes":0}],"practice":"","assessment":"","homework":"","differentiation":{"support":"","extension":""}}';
      const sys = `You are the AIM Lesson Planning agent for Namibian educators.
Generate a ${kind === 'scheme_of_work' ? 'scheme of work (term-length plan, week by week)' : 'single lesson plan (40-minute period)'} for Grade ${grade}, ${sylName}, topic: ${topic}.
Official NIED syllabus objectives (align every element to these):
${obj}
Return STRICT JSON only, no markdown fences, exactly this shape: ${shape}
Use "learners" not "students". Namibian context. Practical for under-resourced classrooms (chalkboard, shared textbooks, no projector).`;
      const out = await callClaude(sys, [{ role: 'user', content: `Generate the ${kind} now.` }], 16000);
      let plan;
      try { plan = parseJson(out.text) } catch { return res.status(502).json({ error: 'generation format error, retry' }) }
      await logAgent({
        agent: 'lesson_planner', action: `${kind} grade ${grade} ${topic}`,
        output_summary: clip(plan.title, 200), tokens_in: out.tokensIn, tokens_out: out.tokensOut, model: out.model,
      });
      return res.json({ plan });
    }

    if (action === 'generate_questions') {
      if (!topic) return res.status(400).json({ error: 'topic required' });
      const sys = `Generate ${count} ${difficulty} practice questions strictly within these NIED syllabus objectives for Grade ${grade}, topic ${topic}:
${obj}
Return STRICT JSON array only: [{"q":"","answer":"","acceptedForms":[""],"hint":"","steps":[""],"difficulty":"easy|medium|hard"}]
Answers must be exact, checkable strings (numbers or simple expressions).`;
      const out = await callClaude(sys, [{ role: 'user', content: 'Generate now.' }], 12000);
      let questions;
      try { questions = parseJson(out.text) } catch { return res.status(502).json({ error: 'generation format error, retry' }) }
      await logAgent({
        agent: 'content_generator', action: `questions grade ${grade} ${topic} x${count}`,
        output_summary: `${questions.length} questions`, tokens_in: out.tokensIn, tokens_out: out.tokensOut, model: out.model,
      });
      return res.json({ questions });
    }

    if (action === 'ministry_brief') {
      const sys = `You are the AIM Ministry Brief agent. Write a weekly briefing for the Namibian Ministry of Education, Arts and Culture based on real platform statistics. Be factual, concise, actionable. Never invent numbers not present in the data.
Return STRICT JSON: {"headline":"","highlights":[""],"risks":[""],"recommendations":[""]}`;
      const out = await callClaude(sys, [{ role: 'user', content: clip(JSON.stringify(stats), 8000) }], 8000);
      let brief;
      try { brief = parseJson(out.text) } catch { return res.status(502).json({ error: 'generation format error, retry' }) }
      await logAgent({
        agent: 'ministry_brief', action: `weekly brief ${region || 'national'}`,
        output_summary: clip(brief.headline, 200), tokens_in: out.tokensIn, tokens_out: out.tokensOut, model: out.model,
      });
      return res.json({ brief });
    }

    if (action === 'chat') {
      // K12Plus tutor chat: the frontend supplies the full system prompt
      // (subject focus, curriculum context, tone). Still logged either way.
      const sys = clip(req.body.system, 4000) ||
        'You are the k12plus tutor for learners in Namibia and South Africa. Be a patient, warm teacher.';
      const out = await callClaude(sys, (messages || []).slice(-16), 4096);
      await logAgent({
        agent: 'tutor', action: 'k12plus chat',
        input_summary: clip(messages.at(-1)?.content, 200),
        output_summary: clip(out.text, 200),
        tokens_in: out.tokensIn, tokens_out: out.tokensOut, model: out.model,
      });
      return res.json({ reply: out.text });
    }

    if (action === 'chatimg') {
      // K12Plus tutor chat with a photographed exercise book page attached.
      if (!image || !image.data) return res.status(400).json({ error: 'image required' });
      const sys = clip(req.body.system, 4000) ||
        'You are the k12plus tutor for learners in Namibia and South Africa. Be a patient, warm teacher.';
      const lastUserText = (messages || []).slice(-1)[0]?.content || 'Please help me with this.';
      const out = await callClaudeWithImage(sys, lastUserText, image.mime, image.data, 4096);
      await logAgent({
        agent: 'tutor', action: 'k12plus chat with image',
        input_summary: clip(lastUserText, 200),
        output_summary: clip(out.text, 200),
        tokens_in: out.tokensIn, tokens_out: out.tokensOut, model: out.model,
      });
      return res.json({ reply: out.text });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    console.error(e);
    const agentFor = { tutor: 'tutor', chat: 'tutor', chatimg: 'tutor', lesson_plan: 'lesson_planner',
      generate_questions: 'content_generator', ministry_brief: 'ministry_brief' };
    await logAgent({
      agent: agentFor[action] || 'triage', action: `${action || 'unknown'} failed`,
      output_summary: clip(e.message, 200), success: false, model: null,
    });
    return res.status(500).json({ error: 'server error', detail: clip(e.message, 200) });
  }
});


// Express-style req/res adapter for Deno.serve
Deno.serve(async (request: Request) => {
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  let body: any = {};
  if (request.method === 'POST') {
    try { body = await request.json(); } catch { body = {}; }
  }
  const req = { method: request.method, headers, body };
  return await new Promise<Response>((resolve) => {
    const outHeaders = new Headers();
    let statusCode = 200;
    const res: any = {
      set(k: string, v: string) { outHeaders.set(k, v); return res; },
      status(c: number) { statusCode = c; return res; },
      json(o: unknown) {
        outHeaders.set('Content-Type', 'application/json');
        resolve(new Response(JSON.stringify(o), { status: statusCode, headers: outHeaders }));
        return res;
      },
      send(s: string) {
        resolve(new Response(statusCode === 204 ? null : s, { status: statusCode, headers: outHeaders }));
        return res;
      },
    };
    Promise.resolve(handler(req, res)).catch((e: any) => {
      console.error(e);
      resolve(new Response(JSON.stringify({ error: 'server error' }), { status: 500, headers: outHeaders }));
    });
  });
});

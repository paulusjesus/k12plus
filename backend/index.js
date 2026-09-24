/**
 * K12Plus AI Proxy - Google Cloud Function (2nd gen)
 * Runs on Google Cloud (Cloud Run function); all LLM calls go through the
 * Anthropic Claude API.
 *
 * Actions: tutor | lesson_plan | generate_questions | ministry_brief | chat | chatimg
 * The frontend sends the relevant NIED syllabus objectives with each request
 * (single curriculum source of truth lives in the app bundle).
 *
 * Env vars (set at deploy, never in the repo):
 *  ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, ALLOWED_ORIGIN
 */

const functions = require('@google-cloud/functions-framework');

// Primary model favours answer quality (this is a tutor, quality matters most);
// the fallback is used only if the primary is rate-limited or overloaded.
const CLAUDE_MODELS = ['claude-sonnet-5', 'claude-haiku-4-5-20251001'];
const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_VERSION = '2023-06-01';

const clip = (s, n) => String(s || '').slice(0, n);

function toClaudeMessages(messages) {
  return messages.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));
}

async function callClaude(systemText, messages, maxTokens = 1024) {
  const claudeMessages = toClaudeMessages(messages);
  let lastErr = null;
  for (const model of CLAUDE_MODELS) {
    const res = await fetch(CLAUDE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': CLAUDE_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0.7,
        system: systemText,
        messages: claudeMessages,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      const text = (data.content || []).map((b) => b.text || '').join('');
      const u = data.usage || {};
      return { text, tokensIn: u.input_tokens, tokensOut: u.output_tokens };
    }
    lastErr = `Claude ${res.status}: ${await res.text()}`;
    // fall through to the fallback model on overload or rate errors
    if (res.status !== 529 && res.status !== 429 && res.status !== 500 && res.status !== 503) break;
  }
  throw new Error(lastErr || 'Claude unavailable');
}

// For image questions: a single-turn call with the learner's photo attached.
async function callClaudeWithImage(systemText, promptText, imageMime, imageBase64, maxTokens = 1024) {
  const content = [
    { type: 'image', source: { type: 'base64', media_type: imageMime || 'image/png', data: imageBase64 } },
    { type: 'text', text: promptText || 'Please help me with this.' },
  ];
  let lastErr = null;
  for (const model of CLAUDE_MODELS) {
    const res = await fetch(CLAUDE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': CLAUDE_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0.7,
        system: systemText,
        messages: [{ role: 'user', content }],
      }),
    });
    if (res.ok) {
      const data = await res.json();
      const text = (data.content || []).map((b) => b.text || '').join('');
      const u = data.usage || {};
      return { text, tokensIn: u.input_tokens, tokensOut: u.output_tokens };
    }
    lastErr = `Claude ${res.status}: ${await res.text()}`;
    if (res.status !== 529 && res.status !== 429 && res.status !== 500 && res.status !== 503) break;
  }
  throw new Error(lastErr || 'Claude unavailable');
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
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

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
      const out = await callClaude(sys, messages.slice(-12));
      await logAgent({
        agent: 'tutor', action: `answer grade ${grade} ${topic || 'general'}`,
        input_summary: clip(messages.at(-1)?.content, 200),
        output_summary: clip(out.text, 200),
        tokens_in: out.tokensIn, tokens_out: out.tokensOut,
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
      const out = await callClaude(sys, [{ role: 'user', content: `Generate the ${kind} now.` }], 4096);
      let plan;
      try { plan = parseJson(out.text) } catch { return res.status(502).json({ error: 'generation format error, retry' }) }
      await logAgent({
        agent: 'lesson_planner', action: `${kind} grade ${grade} ${topic}`,
        output_summary: clip(plan.title, 200), tokens_in: out.tokensIn, tokens_out: out.tokensOut,
      });
      return res.json({ plan });
    }

    if (action === 'generate_questions') {
      if (!topic) return res.status(400).json({ error: 'topic required' });
      const sys = `Generate ${count} ${difficulty} practice questions strictly within these NIED syllabus objectives for Grade ${grade}, topic ${topic}:
${obj}
Return STRICT JSON array only: [{"q":"","answer":"","acceptedForms":[""],"hint":"","steps":[""],"difficulty":"easy|medium|hard"}]
Answers must be exact, checkable strings (numbers or simple expressions).`;
      const out = await callClaude(sys, [{ role: 'user', content: 'Generate now.' }], 4096);
      let questions;
      try { questions = parseJson(out.text) } catch { return res.status(502).json({ error: 'generation format error, retry' }) }
      await logAgent({
        agent: 'content_generator', action: `questions grade ${grade} ${topic} x${count}`,
        output_summary: `${questions.length} questions`, tokens_in: out.tokensIn, tokens_out: out.tokensOut,
      });
      return res.json({ questions });
    }

    if (action === 'ministry_brief') {
      const sys = `You are the AIM Ministry Brief agent. Write a weekly briefing for the Namibian Ministry of Education, Arts and Culture based on real platform statistics. Be factual, concise, actionable. Never invent numbers not present in the data.
Return STRICT JSON: {"headline":"","highlights":[""],"risks":[""],"recommendations":[""]}`;
      const out = await callClaude(sys, [{ role: 'user', content: clip(JSON.stringify(stats), 8000) }], 2048);
      let brief;
      try { brief = parseJson(out.text) } catch { return res.status(502).json({ error: 'generation format error, retry' }) }
      await logAgent({
        agent: 'ministry_brief', action: `weekly brief ${region || 'national'}`,
        output_summary: clip(brief.headline, 200), tokens_in: out.tokensIn, tokens_out: out.tokensOut,
      });
      return res.json({ brief });
    }

    if (action === 'chat') {
      // K12Plus tutor chat: the frontend supplies the full system prompt
      // (subject focus, curriculum context, tone). Still logged either way.
      const sys = clip(req.body.system, 4000) ||
        'You are the k12plus tutor for learners in Namibia and South Africa. Be a patient, warm teacher.';
      const out = await callClaude(sys, (messages || []).slice(-16), 1024);
      await logAgent({
        agent: 'tutor', action: 'k12plus chat',
        input_summary: clip(messages.at(-1)?.content, 200),
        output_summary: clip(out.text, 200),
        tokens_in: out.tokensIn, tokens_out: out.tokensOut,
      });
      return res.json({ reply: out.text });
    }

    if (action === 'chatimg') {
      // K12Plus tutor chat with a photographed exercise book page attached.
      if (!image || !image.data) return res.status(400).json({ error: 'image required' });
      const sys = clip(req.body.system, 4000) ||
        'You are the k12plus tutor for learners in Namibia and South Africa. Be a patient, warm teacher.';
      const lastUserText = (messages || []).slice(-1)[0]?.content || 'Please help me with this.';
      const out = await callClaudeWithImage(sys, lastUserText, image.mime, image.data, 1024);
      await logAgent({
        agent: 'tutor', action: 'k12plus chat with image',
        input_summary: clip(lastUserText, 200),
        output_summary: clip(out.text, 200),
        tokens_in: out.tokensIn, tokens_out: out.tokensOut,
      });
      return res.json({ reply: out.text });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server error', detail: clip(e.message, 200) });
  }
});

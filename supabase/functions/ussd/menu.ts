// K12Plus USSD menus (pilot item 11). Pure logic: no network, no database. The
// Edge Function (index.ts) gives it the learner(s) on the phone, the checked lesson
// packs and the actions it may take, and turns its reply into the gateway's format.
//
// Screens follow the codes on the K12Plus profile:
//   *141*12#    main menu        *141*12*1#  Mathematics       *141*12*2#  Physical Science
//   *141*12*3#  Biology          *141*12*4#  Business Studies
// Each subject offers a practice question, a short lesson and "ask the agent".
// A USSD screen holds about 182 characters and a basic phone can only send digits on
// most networks, so: every screen is cut to fit, answers that need a minus sign, a
// decimal point or a fraction are offered as numbered choices, and all text is
// written in the basic GSM character set (x^2 instead of x², - instead of −).

export const MAX = 182;
export const SUBJECTS = ['Mathematics', 'Physical Science', 'Biology', 'Business Studies'];
export const AGENT = { 'Mathematics': 'AI Math Agent', 'Physical Science': 'AI Physical Science Agent', 'Biology': 'AI Biology Agent', 'Business Studies': 'AI Business Studies Agent' } as Record<string, string>;
export const DAILY_QUESTIONS = 10;

export type Learner = { id: string; first_name: string; grade: number | null; in_class: boolean; taking_part: boolean; locked: boolean };
export type Item = { id: string; type: 'number' | 'choice'; q: string; options?: string[]; answer: string; accept?: string[]; hint?: string; solution?: string; ussd?: { options: string[]; answer: string } };
export type Pack = { id: string; version: number; grade: number; subject: string; topic: string; title: string; keyPoints: string[]; examples: { q: string; steps: string[]; answer: string }[]; practice: Item[] };
export type Record_ = { kind: 'ussd' | 'practice' | 'lesson' | 'question'; client_ref: string; subject?: string; topic?: string; correct?: number; attempted?: number };
export type State = {
  screen?: string; learner?: string | null; subject?: string; pending?: string | null;
  pack?: string; item?: string; done?: string[]; right?: number; tried?: number;
  pages?: string[]; page?: number; back?: string; joinMsg?: string; started?: boolean;
};
export interface Deps {
  sessionId: string;
  simulated: boolean;
  askedToday: number;
  learners: Learner[];
  packs: () => Promise<Pack[]>;
  results: (learnerId: string) => Promise<{ taking_part: boolean; right?: number; tried?: number; best?: string | null; weakest?: string | null }>;
  join: (learnerId: string, code: string) => Promise<{ ok: boolean; error?: string; class?: string; school?: string }>;
  ask: (subject: string, question: string, learner: Learner | null) => Promise<string>;
  record: (learnerId: string, events: Record_[]) => Promise<void>;
  random: () => number;
}
export type Out = { text: string; end: boolean; state: State; aiAsked: number };

// ---------- text for basic phones ----------
const GSM_MAP: Record<string, string> = {
  '−': '-', '–': '-', '—': '-', '×': 'x', '÷': '/', '≤': '<=', '≥': '>=', '≠': '!=', '≈': '~',
  '²': '^2', '³': '^3', '⁴': '^4', '⁵': '^5', '⁶': '^6', 'ⁿ': '^n', 'ˣ': '^x', '⁺': '+', '⁻': '^-',
  '⁰': '0', '¹': '1', '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', 'ₙ': 'n',
  '√': 'sqrt ', 'π': 'pi', 'θ': 'theta', '∞': 'infinity', '°': ' degrees', '′': "'", '→': '->', '⇔': '<=>',
  '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', ' ': ' ', '·': '.', '•': '-', 'ₑ': 'e', 'ₐ': 'a',
  '½': '1/2', '⅓': '1/3', '¼': '1/4', '¾': '3/4', '€': 'EUR', 'ₙ₊₁': 'n+1',
};
// characters every basic phone shows: the GSM 03.38 basic set (without the rarely
// supported ones) and ^ ~ { } [ ] | from its extension table, which phones also show
const GSM_OK = /[A-Za-z0-9 \n@$_!"#%&'()*+,\-./:;<=>?^~{}\[\]|£¥èéùìòÇØøÅåÆæßÉÄÖÑÜ§äöñüà]/;
export function gsm(s: string): string {
  let out = '';
  for (const ch of String(s || '').normalize('NFC')) {
    if (GSM_OK.test(ch)) out += ch;
    else if (GSM_MAP[ch] != null) out += GSM_MAP[ch];
    else if (/\s/.test(ch)) out += ' ';
    else {
      const plain = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
      out += GSM_OK.test(plain) ? plain : '';
    }
  }
  return out.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
}
// a screen: body text cut to fit, with the option lines always shown in full
export function screen(body: string, options: string[] = []): string {
  const opts = options.map(gsm).join('\n');
  const room = MAX - (opts ? opts.length + 1 : 0);
  let b = gsm(body);
  if (b.length > room) b = b.slice(0, Math.max(0, room - 3)).replace(/\s+\S*$/, '') + '...';
  return opts ? (b ? b + '\n' + opts : opts) : b;
}
// longer text split into pages that fit with their option lines
export function pages(text: string, size = 140): string[] {
  const words = gsm(text).split(/(\s+)/);
  const out: string[] = []; let cur = '';
  for (const w of words) {
    if ((cur + w).length > size && cur.trim()) { out.push(cur.trim()); cur = w.trimStart(); } else cur += w;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.length ? out : [''];
}
const shortTopic = (t: string) => String(t || '').split('/').pop()!.trim();

// typed answers on a keypad are digits only
function typeable(it: Item) { return it.type === 'number' && /^\d+$/.test(it.answer); }
function choicesOf(it: Item): { options: string[]; answer: string } | null {
  if (it.type === 'choice') return { options: it.options || [], answer: it.answer };
  if (!typeable(it) && it.ussd) return it.ussd;
  return null;
}
function usable(it: Item) { return typeable(it) || !!choicesOf(it); }

// ---------- the menus ----------
export async function run(prev: State, inputs: string[], deps: Deps, opts: { shortcut?: string | null } = {}): Promise<Out> {
  let s: State = { ...prev };
  let aiAsked = 0;
  const one = deps.learners.length === 1 ? deps.learners[0] : null;
  const me = (): Learner | null => deps.learners.find((l) => l.id === s.learner) || null;
  const rec = async (events: Record_[]) => { const l = me(); if (l && !deps.simulated) await deps.record(l.id, events); };
  const ref = (k: string) => ('ussd-' + deps.sessionId).slice(0, 48) + '-' + k;

  // first screen of the session
  if (!s.started) {
    s.started = true;
    s.learner = one ? one.id : null;
    s.pending = opts.shortcut && /^[1-4]$/.test(opts.shortcut) ? opts.shortcut : null;
    if (s.learner) await rec([{ kind: 'ussd', client_ref: ref('session') }]);
    if (deps.learners.length > 1) s.screen = 'who';
    else if (s.pending) { s.subject = SUBJECTS[+s.pending - 1]; s.pending = null; s.screen = 'subject'; }
    else s.screen = 'main';
  }

  for (const raw of inputs) {
    const inp = String(raw || '').trim();
    const back = inp === '0' || inp === '00';
    switch (s.screen) {
      case 'who': {
        const n = parseInt(inp, 10);
        const l = deps.learners[n - 1];
        if (!l) break;
        s.learner = l.id;
        await rec([{ kind: 'ussd', client_ref: ref('session') }]);
        if (s.pending) { s.subject = SUBJECTS[+s.pending - 1]; s.pending = null; s.screen = 'subject'; } else s.screen = 'main';
        break;
      }
      case 'main': {
        if (/^[1-4]$/.test(inp)) { s.subject = SUBJECTS[+inp - 1]; s.screen = 'subject'; }
        else if (inp === '5') s.screen = me() ? 'results' : 'register';
        else if (inp === '6' && me() && !me()!.in_class) s.screen = 'join';
        break;
      }
      case 'subject': {
        if (back) { s.screen = 'main'; break; }
        if (inp === '1') { await pickItem(s, deps); s.screen = s.item ? 'practice' : 'none'; }
        else if (inp === '2') { await pickLesson(s, deps, rec, ref); s.screen = s.pages ? 'lesson' : 'none'; }
        else if (inp === '3') s.screen = 'ask';
        break;
      }
      case 'none': { s.screen = inp === '3' ? 'ask' : 'subject'; break; }
      case 'practice': {
        if (back) { s.screen = 'subject'; break; }
        const it = await findItem(s, deps);
        if (!it) { s.screen = 'subject'; break; }
        const ch = choicesOf(it.item);
        let right: boolean;
        if (ch) { const n = parseInt(inp, 10); if (!(n >= 1 && n <= ch.options.length)) break; right = 'ABCD'[n - 1] === ch.answer; }
        else { if (!/^\d+$/.test(inp)) break; right = [it.item.answer, ...(it.item.accept || [])].some((a) => /^\d+$/.test(a) && parseInt(a, 10) === parseInt(inp, 10)); }
        s.tried = (s.tried || 0) + 1; s.right = (s.right || 0) + (right ? 1 : 0);
        s.done = [...(s.done || []), it.item.id];
        s.back = right ? 'right' : 'wrong';
        await rec([{ kind: 'practice', client_ref: ref('q' + s.tried), subject: it.pack.subject, topic: it.pack.topic, correct: right ? 1 : 0, attempted: 1 }]);
        s.screen = 'feedback';
        break;
      }
      case 'feedback': {
        if (inp === '1') { await pickItem(s, deps); s.screen = s.item ? 'practice' : 'none'; } else if (back) s.screen = 'subject';
        break;
      }
      case 'lesson':
      case 'answer': {
        if (inp === '1' && (s.page || 0) < (s.pages || []).length - 1) s.page = (s.page || 0) + 1;
        else if (back || inp === '1') { s.screen = 'subject'; s.pages = undefined; s.page = 0; }
        break;
      }
      case 'ask': {
        if (back) { s.screen = 'subject'; break; }
        const l = me();
        if (!l) { s.screen = 'register'; break; }
        if (l.locked) { s.screen = 'locked'; break; }
        if (deps.askedToday + aiAsked >= DAILY_QUESTIONS) { s.screen = 'limit'; break; }
        if (inp.length < 3) break;
        const reply = await deps.ask(s.subject || 'Mathematics', raw, l);
        aiAsked++;
        await rec([{ kind: 'question', client_ref: ref('a' + (deps.askedToday + aiAsked)), subject: s.subject }]);
        s.pages = pages(reply); s.page = 0; s.screen = 'answer';
        break;
      }
      case 'results': case 'register': case 'locked': case 'limit': case 'joined': {
        s.screen = s.screen === 'results' || s.screen === 'joined' ? 'main' : 'subject';
        if (!s.subject && s.screen === 'subject') s.screen = 'main';
        break;
      }
      case 'join': {
        if (back) { s.screen = 'main'; break; }
        const l = me();
        if (!l) { s.screen = 'register'; break; }
        const r = await deps.join(l.id, inp);
        if (r.ok) { l.in_class = true; s.joinMsg = 'You have joined ' + (r.class || 'your class') + (r.school ? ' at ' + r.school : '') + '.'; s.screen = 'joined'; }
        else s.joinMsg = 'Not joined: ' + (r.error || 'that class code was not found.');
        break;
      }
      default: s.screen = 'main';
    }
  }
  return { ...(await render(s, deps)), state: s, aiAsked };
}

async function subjectPacks(s: State, deps: Deps, learner: Learner | null): Promise<Pack[]> {
  const all = (await deps.packs()).filter((p) => p.subject === s.subject);
  const g = learner && learner.grade;
  const mine = g ? all.filter((p) => p.grade === g) : [];
  return mine.length ? mine : all;
}
async function pickItem(s: State, deps: Deps) {
  const learner = deps.learners.find((l) => l.id === s.learner) || null;
  const packs = await subjectPacks(s, deps, learner);
  const pool: { p: Pack; it: Item }[] = [];
  for (const p of packs) for (const it of p.practice) if (usable(it) && !(s.done || []).includes(it.id)) pool.push({ p, it });
  if (!pool.length) { s.item = undefined; return; }
  const pick = pool[Math.floor(deps.random() * pool.length) % pool.length];
  s.pack = pick.p.id; s.item = pick.it.id;
}
async function findItem(s: State, deps: Deps) {
  const p = (await deps.packs()).find((x) => x.id === s.pack);
  const item = p && p.practice.find((i) => i.id === s.item);
  return p && item ? { pack: p, item } : null;
}
async function pickLesson(s: State, deps: Deps, rec: (e: Record_[]) => Promise<void>, ref: (k: string) => string) {
  const learner = deps.learners.find((l) => l.id === s.learner) || null;
  const packs = await subjectPacks(s, deps, learner);
  if (!packs.length) { s.pages = undefined; return; }
  const p = packs[Math.floor(deps.random() * packs.length) % packs.length];
  const ex = p.examples[0];
  const text = p.title + '. ' + p.keyPoints.join(' ') + (ex ? ' Example: ' + ex.q + ' ' + ex.steps.join(' ') + ' Answer: ' + ex.answer : '');
  s.pages = pages(text); s.page = 0; s.pack = p.id;
  await rec([{ kind: 'lesson', client_ref: ref('l-' + p.id), subject: p.subject, topic: p.topic }]);
}

async function render(s: State, deps: Deps): Promise<{ text: string; end: boolean }> {
  const l = deps.learners.find((x) => x.id === s.learner) || null;
  const agent = AGENT[s.subject || 'Mathematics'];
  switch (s.screen) {
    case 'who':
      return { text: screen('K12Plus. Who is using this phone?', deps.learners.map((x, i) => (i + 1) + ' ' + x.first_name)), end: false };
    case 'main': {
      const head = l ? 'Hi ' + l.first_name + '! K12Plus' : 'Welcome to K12Plus';
      const opts = SUBJECTS.map((x, i) => (i + 1) + ' ' + x).concat([l ? '5 My results' : '5 Register']);
      if (l && !l.in_class) opts.push('6 Join my class');
      return { text: screen(head, opts), end: false };
    }
    case 'subject':
      return { text: screen(agent, ['1 Practice question', '2 Short lesson', '3 Ask the agent', '0 Back']), end: false };
    case 'none':
      return { text: screen((s.done && s.done.length ? 'Well done, you have done every practice question for ' : 'Practice and lessons for ') + s.subject + (s.done && s.done.length ? ' here.' : ' are coming soon.'), ['3 Ask the agent', '0 Back']), end: false };
    case 'practice': {
      const it = await findItem(s, deps);
      if (!it) return { text: screen(agent, ['1 Practice question', '2 Short lesson', '3 Ask the agent', '0 Back']), end: false };
      const ch = choicesOf(it.item);
      const n = 'Q' + ((s.tried || 0) + 1) + '. ';
      if (ch) return { text: screen(n + it.item.q, ch.options.map((o, i) => (i + 1) + ' ' + o).concat(['0 Back'])), end: false };
      return { text: screen(n + it.item.q, ['Type the answer (numbers only)', '0 Back']), end: false };
    }
    case 'feedback': {
      const it = await findItem(s, deps);
      const ch = it && choicesOf(it.item);
      const ans = it ? (ch ? ch.options['ABCD'.indexOf(ch.answer)] : it.item.answer) : '';
      const head = s.back === 'right' ? 'Correct! ' : 'Not quite. The answer is ' + ans + '. ';
      return { text: screen(head + (it?.item.solution || ''), ['1 Next question', '0 Back']), end: false };
    }
    case 'lesson':
    case 'answer': {
      const ps = s.pages || [''];
      const i = Math.min(s.page || 0, ps.length - 1);
      const more = i < ps.length - 1;
      return { text: screen(ps[i], more ? ['1 More', '0 Back'] : ['0 Back']), end: false };
    }
    case 'ask':
      if (!l) return { text: screen('To ask the agent, your teacher must first register this phone number for K12Plus.', ['0 Back']), end: false };
      return { text: screen('Type your question for the ' + agent + ':'), end: false };
    case 'locked':
      return { text: screen('You are in the middle of a test, so the agent is taking a break until you submit it. Do your best!', ['0 Back']), end: false };
    case 'limit':
      return { text: screen('You have asked ' + DAILY_QUESTIONS + ' questions today. Well done! You can ask more tomorrow. Try a practice question now.', ['0 Back']), end: false };
    case 'results': {
      if (!l) return { text: screen('Ask your teacher to register this number.', ['0 Back']), end: false };
      const r = await deps.results(l.id);
      const now = s.tried ? ' This session: ' + (s.right || 0) + ' of ' + s.tried + ' right.' : '';
      if (!r.taking_part) return { text: screen('Results are kept when your class takes part in the K12Plus pilot.' + now, ['0 Back']), end: false };
      if (!r.tried) return { text: screen('No practice in the last 30 days yet. Try a practice question!' + now, ['0 Back']), end: false };
      const line = 'Last 30 days: ' + r.right + ' of ' + r.tried + ' right.' + (r.best ? ' Strongest: ' + shortTopic(r.best) + '.' : '') + (r.weakest && r.weakest !== r.best ? ' Practise more: ' + shortTopic(r.weakest) + '.' : '');
      return { text: screen(line, ['0 Back']), end: false };
    }
    case 'register':
      return { text: screen('Ask your teacher to add you to K12Plus with this phone number. Then dial *141*12# again. Practice and lessons work already.'), end: true };
    case 'join':
      return { text: screen((s.joinMsg ? s.joinMsg + ' ' : '') + 'Type your class code (from your teacher):', ['0 Back']), end: false };
    case 'joined':
      return { text: screen((s.joinMsg || 'You have joined your class.') + ' Your teacher can now see your progress.', ['0 Main menu']), end: false };
    default:
      return { text: screen('Welcome to K12Plus'), end: true };
  }
}

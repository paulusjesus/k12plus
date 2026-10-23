/**
 * K12Plus bridge - connects the design prototype to the real backend.
 * - window.claude.complete(...) -> Supabase Edge Function `aim` (Claude API)
 * - Offline queue: questions asked offline are answered on reconnect
 * - PWA service worker registration
 */
// The four AI agents, STEM subjects first. Users always see "agent", never "tutor".
window.k12agents = [
  { subject: 'Mathematics', name: 'AI Math Agent', short: 'AIM', ussd: '*141*12*1#' },
  { subject: 'Physical Science', name: 'AI Physical Science Agent', ussd: '*141*12*2#' },
  { subject: 'Biology', name: 'AI Biology Agent', ussd: '*141*12*3#' },
  { subject: 'Business Studies', name: 'AI Business Studies Agent', ussd: '*141*12*4#' }
];
window.k12agentName = function (subject) {
  for (var i = 0; i < window.k12agents.length; i++) {
    if (window.k12agents[i].subject === subject) return window.k12agents[i].name;
  }
  return 'AI Agent';
};
(function () {
  // ---- Data used by the app (2027 pilot) ----
  // Counts the bytes this app downloads and sends on the phone: its own pages and
  // files (as the browser reports them) and every call to the K12Plus server. The
  // total is kept only for learners taking part in the pilot and sent in small
  // records (see k12learn below); for everyone else it is thrown away.
  var dataBytes = 0;
  function addData(n) { if (n > 0) dataBytes += n; }
  try {
    var po = new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (e) {
        if (String(e.name).indexOf('supabase.co') > -1) return; // counted from the calls below
        // Files handed over by the service worker came from the phone or were fetched by
        // the worker, which counts its own downloads (see sw.js); counting them here too
        // would add the full size of files that cost no data.
        if (e.workerStart > 0) return;
        addData(e.transferSize || 0);
      });
    });
    po.observe({ type: 'navigation', buffered: true });
    po.observe({ type: 'resource', buffered: true });
  } catch (e) {}
  if (window.fetch) {
    var realFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var p = realFetch.apply(this, arguments);
      if (String(url).indexOf('supabase.co') < 0) return p;
      var up = 500 + ((init && typeof init.body === 'string') ? init.body.length : 0); // request with its headers
      return p.then(function (res) {
        try {
          var len = parseInt(res.headers.get('content-length') || '', 10);
          if (len >= 0) addData(up + len + 300);
          else res.clone().arrayBuffer().then(function (b) { addData(up + b.byteLength + 300); }, function () { addData(up); });
        } catch (e) { addData(up); }
        return res;
      }, function (err) { addData(up); throw err; });
    };
  }
  window.k12dataUsed = function () { return dataBytes; };
  // asks the service worker how much it downloaded since it was last asked
  window.k12pullWorkerData = function () {
    return new Promise(function (resolve) {
      try {
        var sw = navigator.serviceWorker && navigator.serviceWorker.controller;
        if (!sw || !window.MessageChannel) return resolve(0);
        var ch = new MessageChannel(), done = false;
        ch.port1.onmessage = function (m) {
          if (done) return; done = true;
          var n = (m.data && m.data.bytes) || 0; addData(n); resolve(n);
        };
        sw.postMessage({ type: 'k12-data-used' }, [ch.port2]);
        setTimeout(function () { if (!done) { done = true; resolve(0); } }, 2000);
      } catch (e) { resolve(0); }
    });
  };
  try {
    if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('controllerchange', function () { window.k12pullWorkerData(); });
  } catch (e) {}
  setInterval(function () { window.k12pullWorkerData(); }, 60000);
  window.k12takeData = function () { var n = dataBytes; dataBytes = 0; return n; };

  // AI proxy: Supabase Edge Function (moved from Google Cloud Run on 14 Oct 2026).
  // The public anon key below is the same one used for auth; it lets the
  // Supabase gateway accept the call. The Claude key lives only on the server.
  var PROXY = 'https://uwqbjjzjdnjlbicxrwnp.supabase.co/functions/v1/aim';
  var PROXY_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV3cWJqanpqZG5qbGJpY3hyd25wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4MzIyNzMsImV4cCI6MjEwMTQwODI3M30.A-YBoeeBGi8XD9tZsm3Yllj0TzfKsl9TKsUSySlWd88';
  function proxyHeaders() {
    return { 'Content-Type': 'application/json', apikey: PROXY_ANON, Authorization: 'Bearer ' + PROXY_ANON };
  }

  // Pilot learners send their own sign-in token, so the agent can stay quiet
  // while they sit a pilot test. Everyone else sends exactly what they did before.
  async function withPilotToken(payload) {
    var out = Object.assign({}, payload);
    try {
      if (localStorage.getItem('k12plus-pilot-taking-part') === '1') {
        var sess = await freshSession();
        if (sess && sess.access_token) out.k12token = sess.access_token;
      }
    } catch (e) {}
    return out;
  }

  // ---- AI bridge ----
  window.claude = window.claude || {};
  window.claude.complete = async function (opts) {
    opts = opts || {};
    var hasImage = !!(opts.image && opts.image.data);
    var payload = {
      action: hasImage ? 'chatimg' : 'chat',
      system: String(opts.system || ''),
      // Only what the agent reads is sent: the last 16 messages of a chat, or the question
      // that goes with a photo. Older messages were uploaded on every question and then
      // ignored by the server (backend/index.js), so this saves data and changes no answer.
      messages: (opts.messages || []).slice(hasImage ? -1 : -16).map(function (m) {
        return { role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') };
      }),
    };
    if (hasImage) {
      payload.image = { mime: String(opts.image.mime || 'image/png'), data: String(opts.image.data) };
    }
    // pilot learners: mark agent replies a teacher may review (chat, photo questions, Real-Life Lab)
    try {
      if (opts.feedback && localStorage.getItem('k12plus-pilot-taking-part') === '1') {
        payload.k12feedback = { kind: String(opts.feedback.kind || 'chat'), subject: String(opts.feedback.subject || ''), topic: String(opts.feedback.topic || '') };
      }
    } catch (e) {}
    var OFFLINE_IMAGE = 'You are offline right now, and pictures need a connection to reach the agent. Please try sending your image again once you are back online.';
    var OFFLINE_SAVED = 'You are offline right now. Your question has been saved and the agent will answer it the moment you reconnect. Meanwhile, your saved chats, lessons and quizzes still work.';
    if (!navigator.onLine) {
      if (hasImage) return OFFLINE_IMAGE;
      queueQuestion(payload);
      return OFFLINE_SAVED;
    }
    var res;
    try {
      res = await fetch(PROXY, {
        method: 'POST',
        headers: proxyHeaders(),
        body: JSON.stringify(await withPilotToken(payload)),
      });
    } catch (netErr) {
      // the signal dropped while sending: keep the question and answer it later
      if (hasImage) return OFFLINE_IMAGE;
      queueQuestion(payload);
      return OFFLINE_SAVED;
    }
    var data = null;
    try { data = await res.json(); } catch (e) {}
    if (res.status === 423 && data && data.reply) return data.reply;
    if (!res.ok) {
      var detail = (data && (data.detail || data.error)) || '';
      if (res.status === 503 && /not configured/i.test(String(data && data.error))) {
        return 'The agent is getting a small upgrade and will be back very soon 🛠️ Your question is not lost, please send it again in a little while.';
      }
      if (res.status === 429 || String(detail).indexOf('429') > -1 || /quota/i.test(String(detail))) {
        return 'Wow, a lot of learners are studying right now and the agents are at full capacity 😅 Please try again in a little while. Your question is not lost, just send it again later.';
      }
      throw new Error('agent unavailable (' + res.status + ')');
    }
    return (data && data.reply) || 'Sorry, I could not answer that. Please try again.';
  };

  // ---- questions asked without a signal ----
  // Kept on the phone (up to 20) and sent one at a time when the signal returns. A
  // question leaves the queue only once the agent has answered it (or the server has
  // refused it for good), so a dropped signal never loses one, and only one tab sends
  // at a time, so none is sent twice. The answer is added to the saved chat and the
  // app is told, so it appears on screen straight away.
  var OUTBOX = 'k12plus-outbox';
  function newRef() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); }
  function readOut() {
    var q;
    try { q = JSON.parse(localStorage.getItem(OUTBOX) || '[]'); } catch (e) { q = []; }
    if (!Array.isArray(q)) q = [];
    var fixed = false;
    q.forEach(function (o) { if (o && !o.id) { o.id = newRef(); fixed = true; } }); // saved by an older version of the app
    if (fixed) writeOut(q);
    return q.filter(function (o) { return o && o.payload; });
  }
  function writeOut(q) { try { localStorage.setItem(OUTBOX, JSON.stringify(q.slice(-20))); } catch (e) {} }
  function queueQuestion(payload) { var q = readOut(); q.push({ id: newRef(), payload: payload, at: Date.now() }); writeOut(q); }
  var outFlushing = false;
  window.k12pendingQuestions = function () { return readOut().length; };
  window.k12flushQuestions = async function () {
    if (outFlushing || !navigator.onLine || !readOut().length) return 0;
    var LOCK = 'k12plus-outbox-lock';
    try { if (Date.now() - (parseInt(localStorage.getItem(LOCK) || '0', 10) || 0) < 60000) return 0; localStorage.setItem(LOCK, String(Date.now())); } catch (e) {}
    outFlushing = true;
    var answered = 0;
    try {
      for (var guard = 0; guard < 20; guard++) {
        var q = readOut();
        if (!q.length) break;
        var item = q[0];
        var res;
        try {
          res = await fetch(PROXY, { method: 'POST', headers: proxyHeaders(), body: JSON.stringify(await withPilotToken(item.payload)) });
        } catch (e) { break; } // still no connection: keep it for later
        if (res.status === 423) break; // a test is in progress: answer after the test
        var data = null;
        try { data = await res.json(); } catch (e) {}
        var gone = res.ok || (res.status >= 400 && res.status < 500 && [408, 425, 429].indexOf(res.status) === -1);
        if (!gone) break; // the server is busy: try again later
        writeOut(readOut().filter(function (o) { return o.id !== item.id; }));
        if (res.ok && data && data.reply) {
          answered++;
          try {
            var chat = JSON.parse(localStorage.getItem('k12plus-tutor-chat') || '[]');
            chat.push({ role: 'assistant', text: '(Answer to your offline question) ' + data.reply });
            localStorage.setItem('k12plus-tutor-chat', JSON.stringify(chat.slice(-40)));
          } catch (e) {}
          try { window.dispatchEvent(new CustomEvent('k12-chat-updated')); } catch (e) {}
        }
      }
    } finally {
      outFlushing = false;
      try { localStorage.removeItem(LOCK); } catch (e) {}
    }
    return answered;
  };
  window.addEventListener('online', function () { setTimeout(function () { window.k12flushQuestions(); }, 1000); });
  setTimeout(function () { window.k12flushQuestions(); }, 3000);

  // ---- Supabase auth + data ----
  var SUPA = 'https://uwqbjjzjdnjlbicxrwnp.supabase.co';
  var SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV3cWJqanpqZG5qbGJpY3hyd25wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4MzIyNzMsImV4cCI6MjEwMTQwODI3M30.A-YBoeeBGi8XD9tZsm3Yllj0TzfKsl9TKsUSySlWd88';

  function supaErr(data, fallback) {
    if (!data) return fallback;
    return data.msg || data.message || data.error_description ||
      (typeof data.error === 'string' ? data.error : (data.error && data.error.message)) || fallback;
  }
  function saveSession(token, refresh, userId, name, role, school, grade, classLetter) {
    try {
      localStorage.setItem('k12plus-session', JSON.stringify({ access_token: token, refresh_token: refresh || '', user_id: userId }));
      localStorage.setItem('k12plus-loggedin', '1');
      if (name) localStorage.setItem('k12plus-name', name);
      if (role) localStorage.setItem('k12plus-role', role);
      if (school) localStorage.setItem('k12plus-school', school);
      if (grade) localStorage.setItem('k12plus-grade', String(grade)); else localStorage.removeItem('k12plus-grade');
      if (classLetter) localStorage.setItem('k12plus-class', String(classLetter)); else localStorage.removeItem('k12plus-class');
      if (saveSession._country) localStorage.setItem('k12plus-country', String(saveSession._country));
    } catch (e) {}
  }

  // ---- keep learners signed in: renew the access token with the refresh token ----
  function readSession() {
    try { return JSON.parse(localStorage.getItem('k12plus-session') || 'null'); } catch (e) { return null; }
  }
  function tokenExpiry(token) {
    try {
      var part = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      while (part.length % 4) part += '=';
      return (JSON.parse(atob(part)).exp || 0) * 1000;
    } catch (e) { return 0; }
  }
  var refreshing = null;
  // Returns a session with a valid access token, renewing it when it is within
  // two minutes of expiry. Returns null when signed out or the refresh token was revoked.
  async function freshSession() {
    var sess = readSession();
    if (!sess || !sess.access_token || !sess.user_id) return null;
    if (tokenExpiry(sess.access_token) - Date.now() > 120000) return sess;
    if (!sess.refresh_token) return null;
    if (!navigator.onLine) return null;
    if (!refreshing) {
      refreshing = (async function () {
        try {
          var res = await fetch(SUPA + '/auth/v1/token?grant_type=refresh_token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: SUPA_KEY },
            body: JSON.stringify({ refresh_token: sess.refresh_token }),
          });
          var data = null;
          try { data = await res.json(); } catch (e) {}
          if (res.ok && data && data.access_token) {
            var next = { access_token: data.access_token, refresh_token: data.refresh_token || sess.refresh_token, user_id: sess.user_id };
            localStorage.setItem('k12plus-session', JSON.stringify(next));
            return next;
          }
          if (res.status === 400 || res.status === 401) {
            // refresh token used up or revoked: sign out cleanly so the app asks to log in again
            localStorage.removeItem('k12plus-session');
            localStorage.removeItem('k12plus-loggedin');
          }
          return null;
        } catch (e) {
          return null;
        } finally {
          refreshing = null;
        }
      })();
    }
    return refreshing;
  }
  window.k12session = freshSession;
  // renew on page load and whenever the learner comes back to the tab
  freshSession();
  document.addEventListener('visibilitychange', function () { if (!document.hidden) freshSession(); });

  window.k12auth = {
    signup: async function (opts) {
      opts = opts || {};
      try {
        var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        var code = '';
        for (var i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
        var learnerUid = 'K12-' + (opts.country === 'South Africa' ? 'ZA' : 'NA') + '-' + code;
        // No email given: use a private internal address built from the unique
        // k12plus ID, so learners who share a name or a family phone never clash.
        // They log in with their mobile number or k12plus ID (auth-login function).
        var email = (opts.email && /\S+@\S+\.\S+/.test(opts.email))
          ? opts.email.trim()
          : learnerUid.toLowerCase() + '@learners.k12edu.io';
        var res = await fetch(SUPA + '/auth/v1/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: SUPA_KEY },
          body: JSON.stringify({ email: email, password: opts.password }),
        });
        var data = await res.json();
        if (!res.ok) return { ok: false, error: supaErr(data, 'Sign up failed (' + res.status + ')') };
        var token = data.access_token;
        var user = data.user || {};
        var refresh = data.refresh_token;

        var schoolId = null;
        try {
          var sres = await fetch(SUPA + '/rest/v1/schools?name=eq.' + encodeURIComponent(opts.schoolName || '') + '&select=id', {
            headers: { apikey: SUPA_KEY },
          });
          var srows = await sres.json();
          if (sres.ok && Array.isArray(srows) && srows.length) schoolId = srows[0].id;
        } catch (e) {}

        var profile = {
          id: user.id,
          username: opts.username,
          role: String(opts.role || 'learner').toLowerCase().replace(/ /g, '_'),
          grade: parseInt(String(opts.grade || '').replace(/\D/g, ''), 10) || null,
          country: opts.country || null,
          class_letter: opts.classLetter || null,
          school_id: schoolId,
          phone: opts.phone || null,
          learner_uid: learnerUid,
          linked_children: opts.childUid ? [opts.childUid] : null,
        };
        var pres = await fetch(SUPA + '/rest/v1/profiles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: SUPA_KEY, Authorization: 'Bearer ' + token, Prefer: 'return=minimal' },
          body: JSON.stringify(profile),
        });
        if (!pres.ok) {
          var pdata = null;
          try { pdata = await pres.json(); } catch (e) {}
          return { ok: false, error: supaErr(pdata, 'Could not save your profile (' + pres.status + ')') };
        }
        saveSession._country = opts.country || 'Namibia';
        saveSession(token, refresh, user.id, opts.username, opts.role, opts.schoolName, profile.grade, opts.classLetter);
        return { ok: true, learnerUid: learnerUid };
      } catch (e) {
        return { ok: false, error: 'Could not reach the server. Check your connection and try again.' };
      }
    },
    // identifier: email address, mobile number, k12plus ID, or (older accounts) full name
    login: async function (identifier, password) {
      try {
        var ident = String(identifier || '').trim();
        var res;
        if (ident.indexOf('@') > -1) {
          res = await fetch(SUPA + '/auth/v1/token?grant_type=password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: SUPA_KEY },
            body: JSON.stringify({ email: ident, password: password }),
          });
        } else {
          res = await fetch(SUPA + '/functions/v1/auth-login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY },
            body: JSON.stringify({ identifier: ident, password: password }),
          });
        }
        var data = await res.json();
        if (!res.ok) {
          var msg = supaErr(data, 'Login failed. Check your details and try again.');
          if (/invalid login credentials/i.test(msg)) msg = 'That email and password do not match. Check them and try again.';
          return { ok: false, error: msg };
        }
        var token = data.access_token;
        var userId = data.user && data.user.id;
        var profile = null;
        try {
          var pres = await fetch(SUPA + '/rest/v1/profiles?id=eq.' + userId + '&select=*', {
            headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + token },
          });
          var rows = await pres.json();
          if (pres.ok && Array.isArray(rows) && rows.length) profile = rows[0];
        } catch (e) {}
        var displayRole = profile && profile.role
          ? String(profile.role).replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }).replace(/\bHod\b/, 'HOD')
          : '';
        saveSession._country = (profile && profile.country) || 'Namibia';
        saveSession(token, data.refresh_token, userId,
          (profile && profile.username) || ident,
          displayRole,
          (profile && profile.school) || '',
          profile && profile.grade,
          profile && profile.class_letter);
        return { ok: true, role: profile && profile.role };
      } catch (e) {
        return { ok: false, error: 'Could not reach the server. Check your connection and try again.' };
      }
    },
    // Signing out removes the account's session from this phone at once (important on
    // shared phones) and asks Supabase to cancel it, so it cannot be used again.
    logout: function () {
      var sess = readSession();
      // an unfinished pilot test: send what is saved on the phone, then clear it,
      // so the next person on a shared phone cannot see it
      try {
        var tst = JSON.parse(localStorage.getItem('k12plus-test') || 'null');
        if (tst && sess && sess.access_token && navigator.onLine) {
          fetch(SUPA + '/rest/v1/rpc/' + (tst.submitPending ? 'pilot_submit_test' : 'pilot_save_answers'), {
            method: 'POST', keepalive: true,
            headers: { 'Content-Type': 'application/json', apikey: SUPA_KEY, Authorization: 'Bearer ' + sess.access_token },
            body: JSON.stringify({ p_attempt: tst.attempt_id, p_answers: tst.answers }),
          }).catch(function () {});
        }
        localStorage.removeItem('k12plus-test');
      } catch (e) {}
      try {
        localStorage.removeItem('k12plus-session');
        localStorage.removeItem('k12plus-loggedin');
        localStorage.removeItem('k12plus-pilot-taking-part');
        localStorage.removeItem('k12plus-events');
      } catch (e) {}
      if (sess && sess.access_token && navigator.onLine) {
        try {
          fetch(SUPA + '/auth/v1/logout?scope=local', {
            method: 'POST', keepalive: true,
            headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + sess.access_token },
          }).catch(function () {});
        } catch (e) {}
      }
    },
  };

  // ---- Password reset ----
  // Email accounts: Supabase emails a link; it comes back to the site with a
  // recovery token in the address, which we hand to the "new password" screen.
  (function catchRecoveryLink() {
    try {
      var h = String(window.location.hash || '');
      if (h.indexOf('type=recovery') < 0 || h.indexOf('access_token=') < 0) return;
      var params = {};
      h.replace(/^#/, '').split('&').forEach(function (kv) {
        var i = kv.indexOf('=');
        if (i > 0) params[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
      });
      localStorage.setItem('k12plus-recovery', JSON.stringify({ access_token: params.access_token, refresh_token: params.refresh_token || '', at: Date.now() }));
      window.location.replace('/signup.html#newpass');
    } catch (e) {}
  })();

  window.k12auth.requestReset = async function (email) {
    try {
      var res = await fetch(SUPA + '/auth/v1/recover?redirect_to=' + encodeURIComponent('https://k12plus.app/signup.html'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPA_KEY },
        body: JSON.stringify({ email: String(email || '').trim() }),
      });
      if (res.status === 429) return { ok: false, error: 'Too many reset emails were requested. Please wait an hour and try again.' };
      return { ok: true }; // same answer whether or not the email has an account
    } catch (e) {
      return { ok: false, error: 'Could not reach the server. Check your connection and try again.' };
    }
  };

  window.k12auth.hasRecovery = function () {
    try {
      var r = JSON.parse(localStorage.getItem('k12plus-recovery') || 'null');
      return !!(r && r.access_token && Date.now() - r.at < 3600000);
    } catch (e) { return false; }
  };

  window.k12auth.setNewPassword = async function (password) {
    var r = null;
    try { r = JSON.parse(localStorage.getItem('k12plus-recovery') || 'null'); } catch (e) {}
    if (!r || !r.access_token) return { ok: false, error: 'This reset link has expired. Please ask for a new one.' };
    try {
      var res = await fetch(SUPA + '/auth/v1/user', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', apikey: SUPA_KEY, Authorization: 'Bearer ' + r.access_token },
        body: JSON.stringify({ password: password }),
      });
      var data = null;
      try { data = await res.json(); } catch (e) {}
      if (!res.ok) return { ok: false, error: supaErr(data, 'This reset link has expired. Please ask for a new one.') };
      localStorage.removeItem('k12plus-recovery');
      saveSession(r.access_token, r.refresh_token, data && data.id, data && data.email, '', '', null, null);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: 'Could not reach the server. Check your connection and try again.' };
    }
  };

  // Learners without email: a parent or verified teacher creates a one-time code.
  window.k12reset = {
    issue: async function (learnerId) {
      var sess = await freshSession();
      if (!sess) return { ok: false, error: 'Please log in again, then create the code.' };
      try {
        var res = await fetch(SUPA + '/functions/v1/learner-reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: SUPA_KEY, Authorization: 'Bearer ' + sess.access_token },
          body: JSON.stringify({ action: 'issue', learnerId: String(learnerId || '').trim() }),
        });
        var data = await res.json();
        return res.ok ? { ok: true, code: data.code, learnerName: data.learnerName, minutes: data.expiresInMinutes } : { ok: false, error: data.error };
      } catch (e) {
        return { ok: false, error: 'Could not reach the server. Check your connection and try again.' };
      }
    },
    redeem: async function (identifier, code, password) {
      try {
        var res = await fetch(SUPA + '/functions/v1/learner-reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY },
          body: JSON.stringify({ action: 'redeem', identifier: identifier, code: code, password: password }),
        });
        var data = await res.json();
        return res.ok ? { ok: true } : { ok: false, error: data.error };
      } catch (e) {
        return { ok: false, error: 'Could not reach the server. Check your connection and try again.' };
      }
    },
  };

  // Quiz results are kept on the phone first and sent when there is a connection, so
  // a quiz finished without a signal is not lost. Each result has its own reference
  // and the server stores it once only, however often it is sent. Results wait for
  // the learner who earned them, so a shared phone never sends them as someone else.
  var QZ = 'k12plus-quiz-outbox';
  function readQz() { try { var q = JSON.parse(localStorage.getItem(QZ) || '[]'); return Array.isArray(q) ? q : []; } catch (e) { return []; } }
  function writeQz(q) { try { localStorage.setItem(QZ, JSON.stringify(q.slice(-200))); } catch (e) {} }
  var qzFlushing = false;
  window.k12data = {
    recordQuiz: function (subject, score, total) {
      var sess = readSession();
      if (!sess || !sess.user_id) return Promise.resolve();
      var q = readQz();
      q.push({ client_ref: newRef(), user_id: sess.user_id, subject: String(subject || 'General').slice(0, 60),
               score: Math.max(0, parseInt(score, 10) || 0), total: Math.max(1, parseInt(total, 10) || 1), created_at: new Date().toISOString() });
      writeQz(q);
      return window.k12data.flushQuiz();
    },
    pendingQuiz: function () { return readQz().length; },
    flushQuiz: async function () {
      if (qzFlushing || !navigator.onLine) return;
      var sess = await freshSession();
      if (!sess) return;
      var mine = readQz().filter(function (r) { return r.user_id === sess.user_id; });
      if (!mine.length) return;
      qzFlushing = true;
      try {
        var batch = mine.slice(0, 50);
        var res = await fetch(SUPA + '/rest/v1/quiz_attempts?on_conflict=user_id,client_ref', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: SUPA_KEY, Authorization: 'Bearer ' + sess.access_token, Prefer: 'return=minimal,resolution=ignore-duplicates' },
          body: JSON.stringify(batch),
        });
        if (res.ok) {
          var sent = {};
          batch.forEach(function (r) { sent[r.client_ref] = 1; });
          writeQz(readQz().filter(function (r) { return !sent[r.client_ref]; }));
          if (mine.length > batch.length) setTimeout(function () { window.k12data.flushQuiz(); }, 500);
        }
      } catch (e) {
      } finally { qzFlushing = false; }
    },
    myQuizStats: async function () {
      var sess = await freshSession();
      if (!sess) return null;
      try {
        var res = await fetch(SUPA + '/rest/v1/quiz_attempts?user_id=eq.' + encodeURIComponent(sess.user_id) + '&select=subject,score,total,created_at&order=created_at.desc&limit=100', {
          headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + sess.access_token },
        });
        if (!res.ok) return null;
        var rows = await res.json();
        if (!Array.isArray(rows)) return null;
        var bySubject = {};
        rows.forEach(function (r) {
          var name = r.subject || 'General';
          if (!bySubject[name]) bySubject[name] = { attempts: 0, pctSum: 0 };
          bySubject[name].attempts += 1;
          bySubject[name].pctSum += r.total ? (100 * r.score / r.total) : 0;
        });
        Object.keys(bySubject).forEach(function (k) {
          var b = bySubject[k];
          b.avgPct = Math.round((b.pctSum / b.attempts) * 10) / 10;
          delete b.pctSum;
        });
        return { total: rows.length, bySubject: bySubject };
      } catch (e) {
        return null;
      }
    },
  };

  // ---- Lesson planner (lesson_plan action on the aim Edge Function) ----
  window.k12plan = async function (payload) {
    if (!navigator.onLine) return { error: 'offline' };
    try {
      var res = await fetch(PROXY, {
        method: 'POST',
        headers: proxyHeaders(),
        body: JSON.stringify(payload),
      });
      var data = null;
      try { data = await res.json(); } catch (e) {}
      if (!res.ok) return { error: (data && data.error) || ('server ' + res.status) };
      return data || { error: 'empty reply' };
    } catch (e) {
      return { error: 'network' };
    }
  };

  // ---- Pilot (2027 pilot: regions, schools, classes, champions) ----
  // Every call goes to a pilot_* database function, which checks the caller's role.
  // Results: { ok: true, data } or { ok: false, error } with a message to show.
  async function pilotRpc(name, args) {
    if (!navigator.onLine) return { ok: false, error: 'You are offline. Pilot pages need a connection.' };
    var sess = await freshSession();
    if (!sess) return { ok: false, error: 'Please log in again.' };
    try {
      var res = await fetch(SUPA + '/rest/v1/rpc/' + name, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPA_KEY, Authorization: 'Bearer ' + sess.access_token },
        body: JSON.stringify(args || {}),
      });
      var data = null;
      try { data = await res.json(); } catch (e) {}
      if (!res.ok) return { ok: false, error: (data && data.message) || 'Something went wrong. Please try again.' };
      return { ok: true, data: data };
    } catch (e) {
      return { ok: false, error: 'Could not reach the server. Check your connection and try again.' };
    }
  }
  // ---- CSV and a small ZIP writer (files stored without compression) for the evaluator export ----
  function csvCell(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return String(v);
    var t = String(v);
    return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  }
  function toCsv(columns, rows) {
    return '\ufeff' + [columns.map(csvCell).join(',')].concat((rows || []).map(function (r) { return r.map(csvCell).join(','); })).join('\r\n') + '\r\n';
  }
  var CRC_T = null;
  function crc32(bytes) {
    if (!CRC_T) {
      CRC_T = [];
      for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c >>> 0; }
    }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) crc = CRC_T[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function makeZip(files) {
    var enc = new TextEncoder();
    var parts = [], central = [], offset = 0;
    var now = new Date();
    var dtime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    var ddate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    files.forEach(function (f) {
      var name = enc.encode(f.name), data = enc.encode(f.text), crc = crc32(data);
      var h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, dtime, true); h.setUint16(12, ddate, true); h.setUint32(14, crc, true);
      h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), name, data);
      var c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, dtime, true); c.setUint16(14, ddate, true); c.setUint32(16, crc, true);
      c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true);
      c.setUint16(30, 0, true); c.setUint16(32, 0, true); c.setUint16(34, 0, true); c.setUint16(36, 0, true); c.setUint32(38, 0, true); c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), name);
      offset += 30 + name.length + data.length;
    });
    var csize = central.reduce(function (a, b) { return a + b.length; }, 0);
    var e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(4, 0, true); e.setUint16(6, 0, true);
    e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csize, true); e.setUint32(16, offset, true); e.setUint16(20, 0, true);
    return new Blob(parts.concat(central, [new Uint8Array(e.buffer)]), { type: 'application/zip' });
  }
  function exportReadme(d) {
    var r = d.rates || {};
    var money = function (n) { return 'US$' + Number(n || 0).toFixed(2); };
    return [
      'K12Plus 2027 pilot: data export for the independent evaluator',
      '',
      'Exported on ' + String(d.generated_at).slice(0, 10) + ' by K-Twelve Educational Technologies (K-12 EdTech).',
      'Period: ' + d.from + ' to ' + d.to + '. Learners included: ' + d.learners + '.',
      '',
      'WHAT IS IN THIS EXPORT',
      '* learners.csv: one row for each learner taking part in the pilot.',
      '* test_scores.csv: one row for each submitted start of the year (baseline) or end of the year (endline) test.',
      '* test_items.csv: one row for each learner, test and question: answered or not, right or wrong.',
      '* usage_weekly.csv: one row for each learner and week: activity, sessions, minutes, questions, practice, topics, USSD, data and text messages.',
      '* schools.csv: one row for each pilot school, by code.',
      '* costs_monthly.csv: data, text messages, USSD sessions and costs for each school and month, and for the whole pilot (ALL).',
      '* data_dictionary.csv: every field in every file, with its type and meaning.',
      '',
      'HOW THE FILES LINK',
      '* pilot_id links learners.csv, test_scores.csv, test_items.csv and usage_weekly.csv.',
      '* school_code links learners.csv, schools.csv and costs_monthly.csv.',
      '* test_code and item link test_scores.csv and test_items.csv. Question n of Version A and question n of Version B test the same topic.',
      '',
      'PRIVACY',
      '* Only learners whose school and parent or guardian gave consent, and have not withdrawn it, are included. When consent is withdrawn, the learner\'s pilot data is deleted and does not appear in later exports.',
      '* There are no names, phone numbers, email addresses, K12Plus IDs, account IDs, birth dates or free text (no questions, answers or comments).',
      '* Schools appear as codes. K-12 EdTech keeps the key to the codes separately and does not share it.',
      '* Where fewer than 5 learners take part in a grade at a school, their region, setting, school and class codes are left out (small_group = 1). In schools.csv and costs_monthly.csv, figures that describe between 1 and 4 learners are left blank.',
      '* Please do not try to identify any learner, and do not join this data with other data that could identify learners.',
      '',
      'MEASURES (more in data_dictionary.csv)',
      '* Times are Namibian time (UTC+2). Weeks start on Monday.',
      '* A new session starts after 30 minutes without activity.',
      '* Minutes count active use only: while the app is open and the learner has touched, typed or scrolled in the last minute.',
      '* Data is measured in the app on the learner\'s phone. It covers K12Plus only and can be slightly lower than the mobile network\'s own count.',
      '* Test questions are marked automatically, 1 mark each. Paper tests are typed in by the teacher and marked the same way.',
      '',
      'PRICES USED FOR COSTS (US dollars)',
      '* Data: ' + money(r.data_usd_per_gb) + ' per GB. Text message: ' + money(r.sms_usd) + ' (or the provider\'s actual price). USSD session: ' + money(r.ussd_session_usd) + '.',
      '* Budget: ' + money(r.budget_per_learner_usd) + ' per learner per month.',
      '* The prices in use on the day of the export are applied to the whole period.',
      ''
    ].join('\r\n');
  }
  window.k12zip = { makeZip: makeZip, toCsv: toCsv };

  window.k12pilot = {
    whoami: function () { return pilotRpc('pilot_whoami'); },
    overview: function () { return pilotRpc('pilot_overview'); },
    regionSchools: function (regionId) { return pilotRpc('pilot_region_schools', { p_region: regionId }); },
    regionDetail: function (regionId) { return pilotRpc('pilot_region_detail', { p_region: regionId }); },
    setupRegion: function (regionId, schools) { return pilotRpc('pilot_setup_region', { p_region: regionId, p_schools: schools }); },
    assignTeacher: function (classId, ident) { return pilotRpc('pilot_assign_teacher', { p_class: classId, p_identifier: ident }); },
    removeTeacher: function (classId, teacherId) { return pilotRpc('pilot_remove_teacher', { p_class: classId, p_teacher: teacherId }); },
    setChampion: function (regionId, ident) { return pilotRpc('pilot_set_champion', { p_region: regionId, p_identifier: ident }); },
    myClasses: function () { return pilotRpc('pilot_my_classes'); },
    joinClass: function (code) { return pilotRpc('pilot_join_class', { p_code: code }); },
    addLearner: function (classId, ident) { return pilotRpc('pilot_add_learner', { p_class: classId, p_identifier: ident }); },
    removeLearner: function (classId, learnerId) { return pilotRpc('pilot_remove_learner', { p_class: classId, p_learner: learnerId }); },
    // learner with a basic phone and no account yet: the server creates the account
    newLearner: function (classId, name, phone) {
      return pilotFn({ action: 'new_learner', classId: classId, name: name, phone: phone });
    },
    // consent: opts = { kind: 'guardian'|'school', learnerId|schoolId, givenByName, relation, signedOn, file (base64) }
    recordConsent: function (opts) { return pilotFn(Object.assign({ action: 'record_consent' }, opts)); },
    consentFormUrl: function (consentId) { return pilotFn({ action: 'consent_form_url', consentId: consentId }); },
    withdrawGuardian: function (learnerId, reason) { return pilotRpc('pilot_withdraw_guardian_consent', { p_learner: learnerId, p_reason: reason || '' }); },
    withdrawSchool: function (schoolId, reason) { return pilotRpc('pilot_withdraw_school_consent', { p_school: schoolId, p_reason: reason || '' }); },
    pendingRemovals: function () { return pilotRpc('pilot_pending_removals'); },
    mySummaries: function () { return pilotRpc('pilot_my_summaries'); },
    summaryStatus: function () { return pilotRpc('pilot_summary_status'); },
    // reports (item 8): administrators see every pilot school, a champion their region
    usageReport: function (from, to) { return pilotRpc('pilot_usage_report', { p_from: from, p_to: to }); },
    spendingAlerts: function () { return pilotRpc('pilot_spending_alerts'); },
    dismissAlert: function (id) { return pilotRpc('pilot_dismiss_alert', { p_id: id }); },
    costSettings: function () { return pilotRpc('pilot_cost_settings'); },
    setCostSettings: function (p) { return pilotRpc('pilot_set_cost_settings', { p: p }); },
    addCostEntry: function (p) { return pilotRpc('pilot_add_cost_entry', { p: p }); },
    costEntries: function (from, to) { return pilotRpc('pilot_cost_entries', { p_from: from, p_to: to }); },
    removeCostEntry: function (id) { return pilotRpc('pilot_remove_cost_entry', { p_id: id }); },
    // export for the independent evaluator (item 10): a zip of CSV files with a README and data dictionary
    evaluatorExport: async function (from, to) {
      var r = await pilotRpc('pilot_evaluator_export', { p_from: from || null, p_to: to || null });
      if (!r.ok) return r;
      var d = r.data;
      var files = [{ name: 'README.txt', text: exportReadme(d) },
                   { name: 'data_dictionary.csv', text: toCsv(['file', 'field', 'type', 'description'], d.dictionary || []) }];
      var order = ['learners.csv', 'test_scores.csv', 'test_items.csv', 'usage_weekly.csv', 'schools.csv', 'costs_monthly.csv'];
      order.concat(Object.keys(d.files).filter(function (n) { return order.indexOf(n) < 0; })).forEach(function (n) {
        if (d.files[n]) files.push({ name: n, text: toCsv(d.files[n].columns, d.files[n].rows) });
      });
      var name = 'k12plus-pilot-export-' + d.from + '-to-' + d.to + '.zip';
      return { ok: true, data: { blob: makeZip(files), name: name, learners: d.learners, files: files.map(function (f) { return f.name; }) } };
    },
    schoolKey: function () { return pilotRpc('pilot_school_key'); },
    // teachers' monthly review of the agent's replies (item 9)
    myReview: function () { return pilotRpc('pilot_my_review'); },
    startReview: function (batchId) { return pilotRpc('pilot_start_review', { p_batch: batchId }); },
    reviewItem: function (itemId, verdict, comment) { return pilotRpc('pilot_review_item', { p_item: itemId, p_verdict: verdict, p_comment: comment || '' }); },
    reviewResults: function (month) { return pilotRpc('pilot_review_results', { p_month: month }); },
    prepareReviews: function (month) { return pilotRpc('pilot_prepare_reviews_now', { p_month: month }); },
    pauseLearner: function (learnerId, reason) { return pilotRpc('pilot_pause_learner', { p_learner: learnerId, p_reason: reason || '' }); },
    resumeLearner: function (learnerId) { return pilotRpc('pilot_resume_learner', { p_learner: learnerId }); },
    messagingRules: function () { return pilotRpc('pilot_messaging_rules'); },
    setMessagingRules: function (rules) { return pilotRpc('pilot_set_messaging_rules', { p: rules }); },
    messageStats: function (days) { return pilotRpc('pilot_message_stats', { p_days: days || 7 }); },
    messageSample: function (size, status, random) { return pilotRpc('pilot_message_sample', { p_size: size || 20, p_status: status || null, p_random: random !== false }); },
    myMessages: function () { return pilotRpc('pilot_my_messages'); },
    markMessagesRead: function () { return pilotRpc('pilot_mark_messages_read'); },
    checkWording: async function (text) {
      if (!navigator.onLine) return { ok: false, error: 'You are offline.' };
      var sess = await freshSession();
      if (!sess) return { ok: false, error: 'Please log in again.' };
      try {
        var res = await fetch(SUPA + '/functions/v1/agent-messenger', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: SUPA_KEY, Authorization: 'Bearer ' + sess.access_token },
          body: JSON.stringify({ action: 'check', text: text }),
        });
        var data = null;
        try { data = await res.json(); } catch (e) {}
        if (!res.ok) return { ok: false, error: (data && data.error) || 'Something went wrong. Please try again.' };
        return { ok: true, data: data };
      } catch (e) {
        return { ok: false, error: 'Could not reach the server.' };
      }
    },
    removeData: function (removalId) { return pilotRpc('pilot_remove_data', { p_removal: removalId }); },
    // Photos of forms are shrunk on the phone (longest side 1600 px, JPEG) so uploads stay
    // small on mobile data. PDFs are sent as they are. Resolves to { b64, kb } or { error }.
    prepareForm: function (file) {
      return new Promise(function (resolve) {
        if (!file) return resolve({ error: 'Choose a photo of the signed form.' });
        var reader = new FileReader();
        if (file.type === 'application/pdf') {
          if (file.size > 3 * 1024 * 1024) return resolve({ error: 'The PDF is too large (over 3 MB).' });
          reader.onload = function () { var b = String(reader.result).split(',')[1]; resolve({ b64: b, kb: Math.round(file.size / 1024) }); };
          reader.onerror = function () { resolve({ error: 'Could not read the file.' }); };
          return reader.readAsDataURL(file);
        }
        if (!/^image\//.test(file.type)) return resolve({ error: 'Choose a photo or a PDF of the signed form.' });
        reader.onload = function () {
          var img = new Image();
          img.onload = function () {
            var max = 1600, w = img.width, h = img.height, k = Math.min(1, max / Math.max(w, h));
            var c = document.createElement('canvas');
            c.width = Math.round(w * k); c.height = Math.round(h * k);
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
            var url = c.toDataURL('image/jpeg', 0.72);
            var b = url.split(',')[1];
            resolve({ b64: b, kb: Math.round(b.length * 0.75 / 1024) });
          };
          img.onerror = function () { resolve({ error: 'That photo could not be opened. Try taking it again.' }); };
          img.src = reader.result;
        };
        reader.onerror = function () { resolve({ error: 'Could not read the photo.' }); };
        reader.readAsDataURL(file);
      });
    },
  };
  async function pilotFn(body) {
    if (!navigator.onLine) return { ok: false, error: 'You are offline. This needs a connection.' };
    var sess = await freshSession();
    if (!sess) return { ok: false, error: 'Please log in again.' };
    try {
      var res = await fetch(SUPA + '/functions/v1/pilot-admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPA_KEY, Authorization: 'Bearer ' + sess.access_token },
        body: JSON.stringify(body),
      });
      var data = null;
      try { data = await res.json(); } catch (e) {}
      if (!res.ok) return { ok: false, error: (data && data.error) || 'Something went wrong. Please try again.' };
      return { ok: true, data: data };
    } catch (e) {
      return { ok: false, error: 'Could not reach the server. Check your connection and try again.' };
    }
  }

  window.addEventListener('online', function () { setTimeout(function () { window.k12data.flushQuiz(); }, 1200); });
  setTimeout(function () { window.k12data.flushQuiz(); }, 3500);

  // ---- Learning record (2027 pilot) ----
  // Only for learners the server has confirmed take part in the pilot (enrolled, with
  // school and parent or guardian consent): the app then keeps a small queue of
  // records on the phone and sends them in batches when there is a connection.
  // Nothing is recorded for anyone else. Each record has its own reference, so a
  // record that is sent twice is stored once.
  var EVQ = 'k12plus-events';
  var PILOT_FLAG = 'k12plus-pilot-taking-part';
  function learnOn() { try { return localStorage.getItem(PILOT_FLAG) === '1'; } catch (e) { return false; } }
  function readQ() { try { return JSON.parse(localStorage.getItem(EVQ) || '[]'); } catch (e) { return []; } }
  function writeQ(q) { try { localStorage.setItem(EVQ, JSON.stringify(q.slice(-500))); } catch (e) {} }
  var flushing = false, flushTimer = null;
  window.k12learn = {
    setTakingPart: function (yes) {
      try {
        if (yes) localStorage.setItem(PILOT_FLAG, '1');
        else { localStorage.removeItem(PILOT_FLAG); localStorage.removeItem(EVQ); }
      } catch (e) {}
      if (yes) window.k12learn.flush();
    },
    pending: function () { return learnOn() ? readQ().length : 0; },
    record: function (ev) {
      if (!learnOn() || !ev || !ev.kind) return;
      var q = readQ();
      q.push({
        client_ref: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10),
        occurred_at: new Date().toISOString(), offline: !navigator.onLine,
        kind: ev.kind, subject: ev.subject || null, topic: ev.topic || null,
        correct: ev.correct == null ? null : ev.correct, attempted: ev.attempted == null ? null : ev.attempted,
        duration_seconds: ev.duration_seconds == null ? null : ev.duration_seconds,
        bytes: ev.bytes == null ? null : ev.bytes,
      });
      writeQ(q);
      clearTimeout(flushTimer);
      flushTimer = setTimeout(function () { window.k12learn.flush(); }, 15000);
    },
    flush: async function () {
      if (flushing || !learnOn() || !navigator.onLine) return;
      var q = readQ();
      if (!q.length) return;
      var sess = await freshSession();
      if (!sess) return;
      flushing = true;
      try {
        var batch = q.slice(0, 50);
        var res = await fetch(SUPA + '/rest/v1/rpc/pilot_record_events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: SUPA_KEY, Authorization: 'Bearer ' + sess.access_token },
          body: JSON.stringify({ p_events: batch }),
        });
        if (!res.ok) return;
        var data = await res.json();
        if (data && data.taking_part === false) { window.k12learn.setTakingPart(false); return; }
        var sent = {};
        batch.forEach(function (e) { sent[e.client_ref] = 1; });
        var rest = readQ().filter(function (e) { return !sent[e.client_ref]; });
        writeQ(rest);
        if (rest.length) setTimeout(function () { window.k12learn.flush(); }, 1000);
      } catch (e) {
      } finally {
        flushing = false;
      }
    },
  };
  // minutes of real use: counted only while the page is visible and the learner has
  // touched, typed or scrolled in the last minute; sent in blocks of about 5 minutes
  (function () {
    var lastInput = 0, activeSec = 0;
    ['click', 'keydown', 'touchstart', 'scroll'].forEach(function (t) {
      window.addEventListener(t, function () { lastInput = Date.now(); }, { passive: true, capture: true });
    });
    // data used: one small record about every 5 minutes, or when the app is put away
    function bankData() {
      var n = window.k12takeData();
      if (!learnOn() || n < 1) return;
      while (n > 0) { var part = Math.min(n, 50000000); window.k12learn.record({ kind: 'data', bytes: part }); n -= part; }
    }
    window.k12learn.bankData = bankData;
    function bank(min) {
      if (activeSec >= min) { window.k12learn.record({ kind: 'active', duration_seconds: activeSec }); activeSec = 0; }
    }
    setInterval(function () {
      if (!learnOn() || document.hidden) return;
      if (Date.now() - lastInput < 60000) activeSec += 30;
      bank(300);
    }, 30000);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { bank(30); bankData(); window.k12pullWorkerData().then(function (n) { if (n > 0) bankData(); }); }
    });
    window.addEventListener('pagehide', bankData);
    setInterval(function () { window.k12pullWorkerData().then(bankData); }, 300000);
    window.addEventListener('online', function () { window.k12learn.flush(); });
    setTimeout(function () { window.k12learn.flush(); }, 4000);
  })();

  // ---- Pilot tests: start of the year and end of the year tests (2027 pilot) ----
  // A learner needs a connection to open the test. After that every answer is kept
  // on the phone first and sent when there is a connection, so a weak signal or a
  // flat battery does not lose work. The questions come without answers: marking
  // happens on the server.
  var TKEY = 'k12plus-test';
  function readTest() { try { return JSON.parse(localStorage.getItem(TKEY) || 'null'); } catch (e) { return null; } }
  function writeTest(t) { try { if (t) localStorage.setItem(TKEY, JSON.stringify(t)); else localStorage.removeItem(TKEY); } catch (e) {} }
  var testTimer = null, testSyncing = false;
  window.k12tests = {
    mine: function () { return pilotRpc('pilot_my_tests'); },
    current: function () { return readTest(); },
    start: async function (testId) {
      var r = await pilotRpc('pilot_start_test', { p_test: testId });
      if (!r.ok) return r;
      var d = r.data || {};
      var old = readTest();
      var answers = Object.assign({}, d.saved || {});
      var dirty = {};
      if (old && old.attempt_id === d.attempt_id) {
        Object.keys(old.dirty || {}).forEach(function (k) { answers[k] = old.answers[k]; dirty[k] = 1; });
      }
      var t = { attempt_id: d.attempt_id, test_id: testId, title: d.title, purpose: d.purpose, minutes: d.minutes,
                closes_at: d.closes_at, items: d.items || [], answers: answers, dirty: dirty, submitPending: false,
                at: (old && old.attempt_id === d.attempt_id && old.at) || 0 };
      writeTest(t);
      return { ok: true, data: t };
    },
    answer: function (itemId, value) {
      var t = readTest();
      if (!t) return null;
      t.answers[String(itemId)] = String(value == null ? '' : value).slice(0, 200);
      t.dirty[String(itemId)] = 1;
      writeTest(t);
      clearTimeout(testTimer);
      testTimer = setTimeout(function () { window.k12tests.sync(); }, 4000);
      return t;
    },
    goTo: function (index) {
      var t = readTest();
      if (t) { t.at = index; writeTest(t); }
    },
    sync: async function () {
      var t = readTest();
      if (!t || testSyncing || !navigator.onLine) return { ok: false };
      if (t.submitPending) return window.k12tests.submit();
      var keys = Object.keys(t.dirty || {});
      if (!keys.length) return { ok: true };
      testSyncing = true;
      try {
        var send = {};
        keys.forEach(function (k) { send[k] = t.answers[k]; });
        var r = await pilotRpc('pilot_save_answers', { p_attempt: t.attempt_id, p_answers: send });
        if (r.ok) {
          var now = readTest();
          if (now && now.attempt_id === t.attempt_id) {
            keys.forEach(function (k) { if (now.answers[k] === send[k]) delete now.dirty[k]; });
            writeTest(now);
          }
        } else if (/closed|already submitted|not found/i.test(r.error || '')) {
          writeTest(null);
        }
        return r;
      } finally { testSyncing = false; }
    },
    // submit: if there is no connection now, it is sent automatically later
    submit: async function () {
      var t = readTest();
      if (!t) return { ok: true, data: { submitted: true } };
      t.submitPending = true;
      writeTest(t);
      if (!navigator.onLine) return { ok: true, queued: true };
      var r = await pilotRpc('pilot_submit_test', { p_attempt: t.attempt_id, p_answers: t.answers });
      if (r.ok || /already submitted/i.test(r.error || '')) { writeTest(null); return { ok: true, data: { submitted: true } }; }
      if (/closed|not found/i.test(r.error || '')) { writeTest(null); return r; }
      return { ok: true, queued: true };
    },
    // teachers
    classTests: function (classId) { return pilotRpc('pilot_class_tests', { p_class: classId }); },
    paperVersion: function (testId) { return pilotRpc('pilot_paper_version', { p_test: testId }); },
    enterPaper: function (testId, learnerId, answers) { return pilotRpc('pilot_enter_paper', { p_test: testId, p_learner: learnerId, p_answers: answers }); },
    // K-12 EdTech administrators
    all: function () { return pilotRpc('pilot_tests_admin'); },
    preview: function (testId) { return pilotRpc('pilot_test_preview', { p_test: testId }); },
    approve: function (testId) { return pilotRpc('pilot_approve_test', { p_test: testId }); },
    setWindow: function (testId, schoolId, opens, closes) {
      return pilotRpc('pilot_set_test_window', { p_test: testId, p_school: schoolId || null, p_opens: opens, p_closes: closes });
    },
    scores: function (testId) { return pilotRpc('pilot_test_scores', { p_test: testId }); },
  };
  window.addEventListener('online', function () { setTimeout(function () { window.k12tests.sync(); }, 1500); });
  setTimeout(function () { if (readTest()) window.k12tests.sync(); }, 5000);

  // ---- Offline lessons (2027 pilot, item 12) ----
  // Lesson packs (lessons/<id>.json) hold an explanation, two worked examples and
  // practice questions. A learner can save a pack on the phone ("Download for
  // offline"); after that it opens and marks answers with no signal at all. Progress
  // is kept on the phone, the next question or topic is suggested from the learner's
  // own answers, and for pilot learners each first answer is added to the learning
  // record, which is sent when there is a connection (stored once only).
  // Learners see a pack only after a teacher has checked it (see pilot_check_lesson).
  var LCACHE = 'k12plus-lessons';
  var LSAVED = 'k12plus-lessons-saved';
  var LPROG = 'k12plus-lesson-progress';
  var LCHECKS = 'k12plus-lesson-checks';
  var LINDEX = 'k12plus-lessons-index';
  function jget(k, d) { try { var v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } }
  function jset(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function packUrl(id) { return '/lessons/' + encodeURIComponent(id) + '.json'; }
  // reads a typed answer as a number: 3/4, -1.25, 2,82 (decimal comma), 1 200,
  // N$ 90, 37.5%, x = 7 and 20 m are all understood. Returns the possible values.
  function numbersIn(raw) {
    var t = String(raw == null ? '' : raw).trim().toLowerCase()
      .replace(/[−–—]/g, '-').replace(/^[a-z]\s*=\s*/, '').replace(/^n\$\s*/, '')
      .replace(/(\d)\s+(?=\d{3}\b)/g, '$1').replace(/\s*(%|°|degrees|cm²|cm2|cm|mm|km|kg|m²|m|s|n\$)\s*$/, '').trim();
    var out = [];
    var frac = t.match(/^(-?\d+(?:[.,]\d+)?)\s*\/\s*(-?\d+(?:[.,]\d+)?)$/);
    if (frac) {
      var a = parseFloat(frac[1].replace(',', '.')), b = parseFloat(frac[2].replace(',', '.'));
      if (b !== 0 && isFinite(a) && isFinite(b)) out.push(a / b);
      return out;
    }
    if (/^-?\d+([.,]\d+)?$/.test(t)) out.push(parseFloat(t.replace(',', '.')));     // 2,82 read as 2.82
    if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) out.push(parseFloat(t.replace(/,/g, ''))); // 1,200 read as 1200
    return out;
  }
  function closeTo(a, b) { return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)); }
  function markAnswer(item, value) {
    if (!item) return false;
    if (item.type === 'choice') return String(value || '').trim().toUpperCase() === item.answer;
    var targets = [item.answer].concat(item.accept || []);
    var got = numbersIn(value);
    for (var i = 0; i < targets.length; i++) {
      var want = numbersIn(targets[i]);
      for (var j = 0; j < got.length; j++) for (var k2 = 0; k2 < want.length; k2++) if (closeTo(got[j], want[k2])) return true;
    }
    return false;
  }
  function today() { try { return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Windhoek' }); } catch (e) { return new Date().toISOString().slice(0, 10); } }
  window.k12lessons = {
    mark: markAnswer,
    numbersIn: numbersIn,
    // the list of packs; works offline from the saved copy
    index: async function () {
      try {
        var r = await fetch('/lessons/index.json', { cache: 'no-cache' });
        if (r.ok) { var d = await r.json(); if (d && Array.isArray(d.packs)) { jset(LINDEX, d); return d; } }
      } catch (e) {}
      try { var hit = window.caches && await caches.match('/lessons/index.json'); if (hit) return await hit.json(); } catch (e) {}
      return jget(LINDEX, { packs: [] });
    },
    // which pack versions a teacher has checked; the last known list is used offline
    checks: async function () {
      if (navigator.onLine) {
        try {
          var sess = await freshSession();
          var res = await fetch(SUPA + '/rest/v1/rpc/pilot_lesson_checks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: SUPA_KEY, Authorization: 'Bearer ' + (sess ? sess.access_token : SUPA_KEY) },
            body: '{}',
          });
          if (res.ok) { var list = await res.json(); if (Array.isArray(list)) { jset(LCHECKS, list); return list; } }
        } catch (e) {}
      }
      return jget(LCHECKS, []);
    },
    isChecked: function (entry, checks) {
      return (checks || jget(LCHECKS, [])).some(function (c) { return c.pack_id === entry.id && c.version === entry.version; });
    },
    check: function (entry, yes, note) {
      return pilotRpc('pilot_check_lesson', { p_pack: entry.id, p_version: entry.version, p_checked: !!yes, p_note: note || null })
        .then(function (r) { if (r.ok && Array.isArray(r.data)) jset(LCHECKS, r.data); return r; });
    },
    saved: function () { return jget(LSAVED, {}); },
    // "Download for offline": keeps the pack in the phone's storage
    download: async function (entry) {
      if (!navigator.onLine) return { ok: false, error: 'You are offline. Connect to the internet to download this lesson.' };
      try {
        var res = await fetch(packUrl(entry.id), { cache: 'no-cache' });
        if (!res.ok) return { ok: false, error: 'This lesson could not be downloaded. Please try again.' };
        var copy = res.clone();
        var pack = await res.json();
        if (!pack || pack.id !== entry.id || !Array.isArray(pack.practice)) return { ok: false, error: 'This lesson could not be downloaded. Please try again.' };
        if (window.caches) { var c = await caches.open(LCACHE); await c.put(packUrl(entry.id), copy); }
        jset('k12plus-lesson-' + entry.id, pack); // second copy, for phones without the storage above
        var sv = jget(LSAVED, {}); sv[entry.id] = { version: pack.version, at: Date.now(), bytes: entry.bytes || null }; jset(LSAVED, sv);
        return { ok: true, data: pack };
      } catch (e) { return { ok: false, error: 'This lesson could not be downloaded. Please try again.' }; }
    },
    remove: async function (id) {
      try { if (window.caches) { var c = await caches.open(LCACHE); await c.delete(packUrl(id)); } } catch (e) {}
      try { localStorage.removeItem('k12plus-lesson-' + id); } catch (e) {}
      var sv = jget(LSAVED, {}); delete sv[id]; jset(LSAVED, sv);
    },
    // opens a pack: the saved copy first (works offline), otherwise from the internet
    pack: async function (id) {
      try {
        if (window.caches) { var c = await caches.open(LCACHE); var hit = await c.match(packUrl(id)); if (hit) return await hit.json(); }
      } catch (e) {}
      var local = jget('k12plus-lesson-' + id, null);
      if (local) return local;
      if (!navigator.onLine) return null;
      try { var res = await fetch(packUrl(id)); if (res.ok) return await res.json(); } catch (e) {}
      return null;
    },
    progress: function (id) { return (jget(LPROG, {})[id]) || { items: {} }; },
    opened: function (pack) {
      var all = jget(LPROG, {});
      var p = all[pack.id] || { version: pack.version, items: {} };
      if (p.version !== pack.version) p = { version: pack.version, items: {} }; // the pack changed: start again
      var day = today();
      if (p.openedOn !== day) {
        p.openedOn = day;
        try { if (window.k12learn) window.k12learn.record({ kind: 'lesson', subject: pack.subject, topic: pack.topic }); } catch (e) {}
      }
      all[pack.id] = p; jset(LPROG, all);
      return p;
    },
    // marks an answer on the phone; the first answer to each question is what counts
    answer: function (pack, item, value) {
      var right = markAnswer(item, value);
      var all = jget(LPROG, {});
      var p = all[pack.id] || { version: pack.version, items: {} };
      var rec = p.items[item.id] || { tries: 0 };
      var first = rec.tries === 0;
      rec.tries += 1; rec.last = right; rec.at = Date.now();
      if (first) {
        rec.firstRight = right;
        try { if (window.k12learn) window.k12learn.record({ kind: 'practice', subject: pack.subject, topic: pack.topic, correct: right ? 1 : 0, attempted: 1 }); } catch (e) {}
      }
      if (right) rec.solved = true;
      p.items[item.id] = rec; all[pack.id] = p; jset(LPROG, all);
      return { right: right, first: first, tries: rec.tries };
    },
    summary: function (pack) {
      var p = window.k12lessons.progress(pack.id);
      var items = pack.practice || [];
      var done = 0, firstRight = 0, solved = 0;
      items.forEach(function (it) { var r = p.items[it.id]; if (r) { done++; if (r.firstRight) firstRight++; if (r.solved) solved++; } });
      return { total: items.length, done: done, firstRight: firstRight, solved: solved };
    },
    // the next question: one not tried yet, then one not yet answered correctly
    nextItem: function (pack, afterId) {
      var p = window.k12lessons.progress(pack.id);
      var items = pack.practice || [];
      var start = 0;
      if (afterId) { for (var i = 0; i < items.length; i++) if (items[i].id === afterId) start = i + 1; }
      var order = items.slice(start).concat(items.slice(0, start));
      for (var a = 0; a < order.length; a++) if (!p.items[order[a].id]) return order[a];
      for (var b = 0; b < order.length; b++) if (!p.items[order[b].id].solved) return order[b];
      return null;
    },
    // study recommendation from the learner's own answers (no AI and no signal needed)
    recommend: function (entries) {
      var all = jget(LPROG, {});
      var saved = jget(LSAVED, {});
      var list = entries || [];
      var stat = function (e) {
        var p = all[e.id]; var done = 0, fr = 0, solved = 0;
        if (p && p.items) Object.keys(p.items).forEach(function (k) { done++; if (p.items[k].firstRight) fr++; if (p.items[k].solved) solved++; });
        return { done: done, fr: fr, solved: solved, total: e.items || 0, started: !!(p && (done || p.openedOn)) };
      };
      var withStats = list.map(function (e) { return { e: e, s: stat(e) }; });
      var going = withStats.filter(function (x) { return x.s.started && x.s.solved < x.s.total; })
        .sort(function (a, b) { return (b.s.done / Math.max(1, b.s.total)) - (a.s.done / Math.max(1, a.s.total)); })[0];
      if (going) {
        var left = going.s.total - going.s.solved;
        return { id: going.e.id, title: going.e.title, reason: 'Carry on: ' + left + (left === 1 ? ' question' : ' questions') + ' still to get right.' };
      }
      var weak = withStats.filter(function (x) { return x.s.done >= x.s.total && x.s.total && x.s.fr / x.s.total < 0.7; })
        .sort(function (a, b) { return (a.s.fr / a.s.total) - (b.s.fr / b.s.total); })[0];
      if (weak) return { id: weak.e.id, title: weak.e.title, reason: 'Worth another look: you got ' + weak.s.fr + ' of ' + weak.s.total + ' right first time. Read the examples again, then try the questions.' };
      var fresh = withStats.filter(function (x) { return !x.s.started; });
      var savedFresh = fresh.filter(function (x) { return saved[x.e.id]; })[0];
      if (savedFresh) return { id: savedFresh.e.id, title: savedFresh.e.title, reason: 'Next topic, already saved on this phone.' };
      if (fresh[0]) return { id: fresh[0].e.id, title: fresh[0].e.title, reason: 'Next topic to start.' };
      return list.length ? { id: null, title: '', reason: 'Well done: you have worked through every lesson here.' } : null;
    },
    // starts again on a pack, for a learner who wants to practise it once more
    reset: function (id) { var all = jget(LPROG, {}); delete all[id]; jset(LPROG, all); },
  };

  // ---- PWA ----
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () {});
    });
  }
})();

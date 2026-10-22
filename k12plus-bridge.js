/**
 * K12Plus bridge - connects the design prototype to the real backend.
 * - window.claude.complete(...) -> Supabase Edge Function `aim` (Claude API)
 * - Offline queue: questions asked offline are answered on reconnect
 * - PWA service worker registration
 */
(function () {
  // AI proxy: Supabase Edge Function (moved from Google Cloud Run on 14 Oct 2026).
  // The public anon key below is the same one used for auth; it lets the
  // Supabase gateway accept the call. The Claude key lives only on the server.
  var PROXY = 'https://uwqbjjzjdnjlbicxrwnp.supabase.co/functions/v1/aim';
  var PROXY_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV3cWJqanpqZG5qbGJpY3hyd25wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4MzIyNzMsImV4cCI6MjEwMTQwODI3M30.A-YBoeeBGi8XD9tZsm3Yllj0TzfKsl9TKsUSySlWd88';
  function proxyHeaders() {
    return { 'Content-Type': 'application/json', apikey: PROXY_ANON, Authorization: 'Bearer ' + PROXY_ANON };
  }

  // ---- AI bridge ----
  window.claude = window.claude || {};
  window.claude.complete = async function (opts) {
    opts = opts || {};
    var hasImage = !!(opts.image && opts.image.data);
    var payload = {
      action: hasImage ? 'chatimg' : 'chat',
      system: String(opts.system || ''),
      messages: (opts.messages || []).map(function (m) {
        return { role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') };
      }),
    };
    if (hasImage) {
      payload.image = { mime: String(opts.image.mime || 'image/png'), data: String(opts.image.data) };
    }
    if (!navigator.onLine) {
      if (hasImage) {
        return 'You are offline right now, and pictures need a connection to reach the tutor. Please try sending your image again once you are back online.';
      }
      try {
        var q = JSON.parse(localStorage.getItem('k12plus-outbox') || '[]');
        q.push({ payload: payload, at: Date.now() });
        localStorage.setItem('k12plus-outbox', JSON.stringify(q.slice(-20)));
      } catch (e) {}
      return 'You are offline right now. Your question has been saved and the tutor will answer it the moment you reconnect. Meanwhile, your saved chats and quizzes still work.';
    }
    var res = await fetch(PROXY, {
      method: 'POST',
      headers: proxyHeaders(),
      body: JSON.stringify(payload),
    });
    var data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      var detail = (data && (data.detail || data.error)) || '';
      if (res.status === 503 && /not configured/i.test(String(data && data.error))) {
        return 'The tutor is getting a small upgrade and will be back very soon 🛠️ Your question is not lost, please send it again in a little while.';
      }
      if (res.status === 429 || String(detail).indexOf('429') > -1 || /quota/i.test(String(detail))) {
        return 'Wow, a lot of learners are studying right now and the tutor is at full capacity 😅 Please try again in a little while. Your question is not lost, just send it again later.';
      }
      throw new Error('tutor unavailable (' + res.status + ')');
    }
    return (data && data.reply) || 'Sorry, I could not answer that. Please try again.';
  };

  // ---- flush offline outbox on reconnect (answers land in tutor chat storage) ----
  window.addEventListener('online', async function () {
    var q;
    try { q = JSON.parse(localStorage.getItem('k12plus-outbox') || '[]'); } catch (e) { q = []; }
    if (!q.length) return;
    localStorage.setItem('k12plus-outbox', '[]');
    for (var i = 0; i < q.length; i++) {
      try {
        var res = await fetch(PROXY, {
          method: 'POST',
          headers: proxyHeaders(),
          body: JSON.stringify(q[i].payload),
        });
        if (!res.ok) continue;
        var data = await res.json();
        var chat = JSON.parse(localStorage.getItem('k12plus-tutor-chat') || '[]');
        chat.push({ role: 'assistant', text: '(Answer to your offline question) ' + (data.reply || '') });
        localStorage.setItem('k12plus-tutor-chat', JSON.stringify(chat.slice(-40)));
      } catch (e) {}
    }
  });

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
    logout: function () {
      try {
        localStorage.removeItem('k12plus-session');
        localStorage.removeItem('k12plus-loggedin');
      } catch (e) {}
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

  window.k12data = {
    recordQuiz: async function (subject, score, total) {
      var sess = await freshSession();
      if (!sess) return;
      try {
        await fetch(SUPA + '/rest/v1/quiz_attempts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: SUPA_KEY, Authorization: 'Bearer ' + sess.access_token, Prefer: 'return=minimal' },
          body: JSON.stringify({ user_id: sess.user_id, subject: subject, score: score, total: total }),
        });
      } catch (e) {}
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

  // ---- PWA ----
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () {});
    });
  }
})();

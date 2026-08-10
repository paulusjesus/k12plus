/**
 * K12Plus bridge - connects the design prototype to the real backend.
 * - window.claude.complete(...) -> Google Cloud Run proxy (Gemini, XPRIZE compliant)
 * - Offline queue: questions asked offline are answered on reconnect
 * - PWA service worker registration
 */
(function () {
  var PROXY = 'https://aim-269148997291.europe-west1.run.app';

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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('tutor unavailable (' + res.status + ')');
    var data = await res.json();
    return data.reply || 'Sorry, I could not answer that. Please try again.';
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
          headers: { 'Content-Type': 'application/json' },
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

  function supaEmail(username, email) {
    if (email && /\S+@\S+\.\S+/.test(email)) return email.trim();
    if (username && username.indexOf('@') > -1) return username.trim();
    return String(username || '').toLowerCase().replace(/[^a-z0-9_]/g, '') + '@learners.k12edu.io';
  }
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
    } catch (e) {}
  }

  window.k12auth = {
    signup: async function (opts) {
      opts = opts || {};
      try {
        var email = supaEmail(opts.username, opts.email);
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

        var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        var code = '';
        for (var i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
        var learnerUid = 'K12-' + (opts.country === 'South Africa' ? 'ZA' : 'NA') + '-' + code;

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
        saveSession(token, refresh, user.id, opts.username, opts.role, opts.schoolName, profile.grade, opts.classLetter);
        return { ok: true, learnerUid: learnerUid };
      } catch (e) {
        return { ok: false, error: 'Could not reach the server. Check your connection and try again.' };
      }
    },
    login: async function (username, password) {
      try {
        var email = supaEmail(username);
        var res = await fetch(SUPA + '/auth/v1/token?grant_type=password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: SUPA_KEY },
          body: JSON.stringify({ email: email, password: password }),
        });
        var data = await res.json();
        if (!res.ok) return { ok: false, error: supaErr(data, 'Login failed. Check your details and try again.') };
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
        saveSession(token, data.refresh_token, userId,
          (profile && profile.username) || username,
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

  window.k12data = {
    recordQuiz: async function (subject, score, total) {
      var sess = null;
      try { sess = JSON.parse(localStorage.getItem('k12plus-session') || 'null'); } catch (e) {}
      if (!sess || !sess.access_token || !sess.user_id) return;
      try {
        await fetch(SUPA + '/rest/v1/quiz_attempts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: SUPA_KEY, Authorization: 'Bearer ' + sess.access_token, Prefer: 'return=minimal' },
          body: JSON.stringify({ user_id: sess.user_id, subject: subject, score: score, total: total }),
        });
      } catch (e) {}
    },
    myQuizStats: async function () {
      var sess = null;
      try { sess = JSON.parse(localStorage.getItem('k12plus-session') || 'null'); } catch (e) {}
      if (!sess || !sess.access_token || !sess.user_id) return null;
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

  // ---- PWA ----
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () {});
    });
  }
})();

/* K12Plus Monitor
 * Progress and registrations for a learner, a class, a school, a region and Namibia,
 * plus account management for the people who look after each of those.
 *
 * Every rule about who may see or change what lives in the database (the monitor_*
 * and account_* functions). This page only shows what the database returns, so a
 * person who edits the page still cannot see more than they are allowed to.
 */
(function () {
  'use strict';
  var SUPA = 'https://uwqbjjzjdnjlbicxrwnp.supabase.co';
  var KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV3cWJqanpqZG5qbGJpY3hyd25wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4MzIyNzMsImV4cCI6MjEwMTQwODI3M30.A-YBoeeBGi8XD9tZsm3Yllj0TzfKsl9TKsUSySlWd88';
  var SKEY = 'k12monitor-session';
  var C = window.K12Charts;
  var app = document.getElementById('app');
  var whoEl = document.getElementById('who');
  var me = null;
  var grain = 'week';
  try { grain = localStorage.getItem('k12monitor-grain') || 'week'; } catch (e) {}
  var last = null; // what is on screen, for the CSV

  var GRAINS = [['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly'], ['quarter', 'Quarterly'], ['year', 'Yearly']];
  var GRAIN_TEXT = { day: 'the last 30 days', week: 'the last 12 weeks', month: 'the last 12 months', quarter: 'the last 8 quarters', year: 'the last 5 years' };
  var PER = { day: 'per day', week: 'per week', month: 'per month', quarter: 'per quarter', year: 'per year' };
  var ROLE = { learner: 'Learner', educator: 'Teacher', principal: 'Principal', hod: 'Head of department', school_admin: 'School administrator', parent: 'Parent', ministry: 'Ministry official', admin: 'K-12 EdTech' };
  var SCOPE = { class: 'Class', school: 'School', region: 'Region', country: 'Namibia' };
  var RANK = { class: 1, school: 2, region: 3, country: 4 };

  // ---------- small helpers ----------
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function num(n) { return n == null ? 'none' : Number(n).toLocaleString('en-GB'); }
  function pct(n) { return n == null ? 'none yet' : n + '%'; }
  function share(a, b) { return b ? Math.round(100 * a / b) : null; }
  function count(n, one, many) { return num(n) + ' ' + (n === 1 ? one : many); }
  function asDate(d) { return new Date(String(d).length === 10 ? d + 'T12:00:00' : d); }
  function dayLong(d) { return d ? asDate(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : 'not yet'; }
  function dayShort(d) { return d ? asDate(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : 'not yet'; }
  function accClass(a) { return a == null ? '' : a >= 60 ? 'good' : a < 40 ? 'warn' : ''; }
  function $(sel) { return document.querySelector(sel); }
  function on(sel, ev, fn) { var el = typeof sel === 'string' ? $(sel) : sel; if (el) el.addEventListener(ev, fn); }
  function each(sel, fn) { Array.prototype.forEach.call(document.querySelectorAll(sel), fn); }

  // A label for one period on an axis, and a fuller one for the tooltip.
  function periodLabel(d, full) {
    var x = asDate(d);
    if (grain === 'day') return full ? x.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) : x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    if (grain === 'week') return full ? 'Week of ' + dayLong(d) : x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    if (grain === 'month') return full ? x.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) : x.toLocaleDateString('en-GB', { month: 'short' });
    if (grain === 'quarter') { var q = Math.floor(x.getMonth() / 3) + 1; return full ? 'Quarter ' + q + ', ' + x.getFullYear() : 'Q' + q + ' ' + String(x.getFullYear()).slice(2); }
    return String(x.getFullYear());
  }

  // ---------- session ----------
  function readSession() { try { return JSON.parse(localStorage.getItem(SKEY) || 'null'); } catch (e) { return null; } }
  function saveSession(s) { try { localStorage.setItem(SKEY, JSON.stringify(s)); } catch (e) {} }
  function clearSession() { try { localStorage.removeItem(SKEY); } catch (e) {} }
  function expiry(t) {
    try { var p = String(t).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); while (p.length % 4) p += '='; return (JSON.parse(atob(p)).exp || 0) * 1000; } catch (e) { return 0; }
  }
  var refreshing = null;
  function token() {
    var s = readSession();
    if (!s || !s.access_token) return Promise.resolve(null);
    if (expiry(s.access_token) - Date.now() > 120000) return Promise.resolve(s.access_token);
    if (!s.refresh_token) return Promise.resolve(null);
    if (!refreshing) {
      refreshing = fetch(SUPA + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST', headers: { 'Content-Type': 'application/json', apikey: KEY }, body: JSON.stringify({ refresh_token: s.refresh_token })
      }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, d: d }; }); })
        .then(function (x) {
          if (x.ok && x.d.access_token) { saveSession({ access_token: x.d.access_token, refresh_token: x.d.refresh_token || s.refresh_token }); return x.d.access_token; }
          if (x.status === 400 || x.status === 401) clearSession();
          return null;
        }).catch(function () { return null; }).finally(function () { refreshing = null; });
    }
    return refreshing;
  }
  function signedOut() { var e = new Error('signed_out'); e.signedOut = true; return e; }
  function call(url, args) {
    return token().then(function (t) {
      if (!t) throw signedOut();
      return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: 'Bearer ' + t }, body: JSON.stringify(args || {}) });
    }).then(function (r) {
      return r.text().then(function (txt) {
        var d = null; try { d = JSON.parse(txt); } catch (e) {}
        if (r.status === 401 && !(d && d.error)) { clearSession(); throw signedOut(); }
        if (!r.ok) throw new Error((d && (d.message || d.error)) || 'Something went wrong. Please try again.');
        return d;
      });
    });
  }
  function rpc(name, args) { return call(SUPA + '/rest/v1/rpc/' + name, args); }
  function service(action, args) { args = args || {}; args.action = action; return call(SUPA + '/functions/v1/account-admin', args); }

  function signIn(ident, password) {
    ident = String(ident || '').trim();
    var req = ident.indexOf('@') > -1
      ? fetch(SUPA + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: KEY }, body: JSON.stringify({ email: ident, password: password }) })
      : fetch(SUPA + '/functions/v1/auth-login', { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: 'Bearer ' + KEY }, body: JSON.stringify({ identifier: ident, password: password }) });
    return req.then(function (r) { return r.json().then(function (d) {
      if (!r.ok || !d.access_token) {
        var m = d && (d.error_description || d.msg || d.message || (typeof d.error === 'string' ? d.error : '')) || '';
        if (/invalid login credentials/i.test(m) || !m) m = 'Those details do not match a k12plus account. Check them and try again.';
        if (/banned/i.test(m)) m = 'This account has been switched off. Ask your teacher, school or K-Twelve Educational Technologies.';
        throw new Error(m);
      }
      saveSession({ access_token: d.access_token, refresh_token: d.refresh_token });
      return d.user && d.user.app_metadata && d.user.app_metadata.must_change_password;
    }); }, function () { throw new Error('Could not reach the server. Check your connection and try again.'); });
  }
  function signOut() {
    var s = readSession();
    clearSession(); me = null;
    if (s && s.access_token) fetch(SUPA + '/auth/v1/logout', { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + s.access_token } }).catch(function () {});
    location.hash = '';
    route();
  }

  // ---------- dialogs ----------
  function dialog(title, body, submitText, onSubmit) {
    var d = document.createElement('dialog');
    d.className = 'dlg';
    d.innerHTML = '<form method="dialog"><h2>' + esc(title) + '</h2>' + body +
      '<div class="err" data-err></div><div class="dlg-actions">' +
      (submitText ? '<button class="btn primary" value="ok" type="submit">' + esc(submitText) + '</button>' : '') +
      '<button class="btn" value="cancel" type="button" data-close>' + (submitText ? 'Cancel' : 'Close') + '</button></div></form>';
    document.body.appendChild(d);
    var form = d.querySelector('form');
    d.querySelector('[data-close]').onclick = function () { d.close(); };
    d.addEventListener('close', function () { d.remove(); });
    form.onsubmit = function (ev) {
      ev.preventDefault();
      if (!onSubmit) { d.close(); return; }
      var btn = form.querySelector('button[type=submit]'), err = form.querySelector('[data-err]');
      btn.disabled = true; err.textContent = '';
      Promise.resolve().then(function () { return onSubmit(form, d); }).then(function (keep) { if (!keep) d.close(); })
        .catch(function (e) { err.textContent = e.message; }).finally(function () { btn.disabled = false; });
    };
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
    var first = d.querySelector('input:not([type=hidden]), select'); if (first) first.focus();
    return d;
  }
  function notice(title, html) { dialog(title, '<div class="dlg-body">' + html + '</div>', null, null); }

  // Temporary passwords that are easy to read out over the phone.
  var WORDS = ['Kudu', 'Oryx', 'Eland', 'Baobab', 'Mopane', 'Etosha', 'Okavango', 'Zambezi', 'Kunene', 'Swakop', 'Namib', 'Welwitschia', 'Springbok', 'Hornbill'];
  function suggestPassword() {
    var r = new Uint32Array(3); (window.crypto || window.msCrypto).getRandomValues(r);
    return WORDS[r[0] % WORDS.length] + WORDS[r[1] % WORDS.length] + String(1000 + r[2] % 9000);
  }

  function changeOwnPassword(temporary) {
    return new Promise(function (resolve) {
      var dlg = dialog('Choose your own password',
        '<p class="note">You signed in with a temporary password. Choose a new one that only you know: at least 8 characters with a letter and a number.</p>' +
        '<label for="np1">New password</label><input id="np1" type="password" autocomplete="new-password" required>' +
        '<label for="np2">Type it again</label><input id="np2" type="password" autocomplete="new-password" required>',
        'Save my password', function (f) {
          var a = f.querySelector('#np1').value, b = f.querySelector('#np2').value;
          if (a !== b) throw new Error('The two passwords are not the same.');
          return service('change_own_password', { new_password: a, temporary_password: temporary }).then(function () { resolve(true); });
        });
      dlg.addEventListener('close', function () { resolve(false); });
    });
  }

  // ---------- sign in ----------
  function showSignIn(msg) {
    whoEl.innerHTML = '';
    app.innerHTML =
      '<div class="card signin"><img class="signin-logo" src="logo.png" alt="k12plus"><h1>Sign in to K12Plus Monitor</h1>' +
      '<p>See how learners are progressing and how many people have registered, for your class, your school, your region or the whole country. Use the same details as on k12plus.app.</p>' +
      '<form id="f"><label for="u">Email, mobile number or k12plus ID</label><input id="u" type="text" autocomplete="username" required>' +
      '<label for="p">Password</label><input id="p" type="password" autocomplete="current-password" required>' +
      '<div class="err" id="e">' + esc(msg || '') + '</div>' +
      '<button class="btn primary wide" type="submit">Sign in</button></form>' +
      '<p class="note" style="margin:14px 0 0">Forgot your password? Your teacher or school can give you a temporary one, or reset it on <a href="https://k12plus.app/app.html">k12plus.app</a>. Ministry and regional officials receive access from K-Twelve Educational Technologies after signing up at k12plus.app.</p></div>';
    on('#f', 'submit', function (ev) {
      ev.preventDefault();
      var b = ev.target.querySelector('button'), pw = $('#p').value;
      b.disabled = true; b.textContent = 'Signing in…';
      signIn($('#u').value, pw).then(function (mustChange) {
        if (!mustChange) { me = null; route(); return; }
        changeOwnPassword(pw).then(function (changed) {
          if (changed) { me = null; route(); return; }
          clearSession(); showSignIn('Choose your own password to finish signing in.');
        });
      }).catch(function (e) { $('#e').textContent = e.message; b.disabled = false; b.textContent = 'Sign in'; });
    });
  }

  function header() {
    var flogo = me.funder && me.funder.logo ? '<img class="funder-logo" src="' + esc(me.funder.logo) + '" alt="' + esc(me.funder.name) + '">' : '';
    whoEl.innerHTML = flogo + '<span class="nm">' + esc(me.name) + (me.title ? ' · ' + esc(me.title) : '') + '</span><button class="btn small" id="so">Sign out</button>';
    on('#so', 'click', signOut);
  }

  // ---------- navigation ----------
  function viewHash(v) { return v.kind === 'learner' ? '#me' : v.kind === 'country' ? '#country' : '#' + v.kind + '/' + v.id; }
  function topNav(active) {
    var vs = (me.views || []).slice();
    var chips = vs.map(function (v) {
      var h = viewHash(v);
      var label = v.kind === 'class' ? v.name + ' · ' + v.school : v.kind === 'region' ? v.name + ' Region' : v.name;
      return '<button class="chip' + (h === active ? ' on' : '') + '" data-h="' + esc(h) + '">' + esc(label) + '</button>';
    });
    if ((me.manage || []).length) chips.push('<button class="chip acc' + (active.indexOf('#accounts') === 0 ? ' on' : '') + '" data-h="#accounts">Accounts</button>');
    if (me.funds) chips.push('<button class="chip acc' + (active === '#funds' ? ' on' : '') + '" data-h="#funds">Funds</button>');
    if (me.admin) chips.push('<button class="chip acc' + (active === '#officials' ? ' on' : '') + '" data-h="#officials">Officials</button>');
    return chips.length > 1 ? '<nav class="views" aria-label="Views">' + chips.join('') + '</nav>' : '';
  }
  function bindNav() { each('[data-h]', function (b) { b.onclick = function () { location.hash = b.getAttribute('data-h'); }; }); }
  function canSee(kind, id) { return (me.views || []).some(function (v) { return v.kind === 'country' || (v.kind === kind && String(v.id) === String(id)); }); }
  function crumbs(list) {
    if (list.length < 2) return '';
    return '<div class="crumbs">' + list.map(function (c, i) {
      return (c.h ? '<a href="' + esc(c.h) + '">' + esc(c.t) + '</a>' : '<span>' + esc(c.t) + '</span>') + (i < list.length - 1 ? ' <span aria-hidden="true">›</span>' : '');
    }).join(' ') + '</div>';
  }
  function grainPicker() {
    return '<div class="seg" role="group" aria-label="Period">' + GRAINS.map(function (g) {
      return '<button type="button" data-grain="' + g[0] + '" class="' + (g[0] === grain ? 'on' : '') + '" aria-pressed="' + (g[0] === grain) + '">' + g[1] + '</button>';
    }).join('') + '</div>';
  }
  function bindTools() {
    each('[data-grain]', function (b) { b.onclick = function () { grain = b.getAttribute('data-grain'); try { localStorage.setItem('k12monitor-grain', grain); } catch (e) {} route(); }; });
    on('#pr', 'click', function () { window.print(); });
    on('#csv', 'click', downloadCsv);
  }

  // ---------- pieces of a page ----------
  function tile(k, v, s) { return '<div class="tile"><div class="k">' + k + '</div><div class="v">' + v + '</div><div class="s">' + esc(s || '') + '</div></div>'; }
  function card(title, inner, cls) { return '<section class="card ' + (cls || '') + '"><h2>' + title + '</h2>' + inner + '</section>'; }
  function slot(id, cls) { return '<div class="chart ' + (cls || '') + '" id="' + id + '"></div>'; }

  function registrationsBlock(reg, kind, childLabel) {
    if (!reg) return '';
    if (reg.too_few) return card('Registrations', '<p class="note">Fewer than five accounts are registered here, so the numbers are hidden.</p>');
    var h = '<div class="tiles">' +
      tile('Registered accounts', num(reg.total), num(reg.new_period) + ' new in ' + GRAIN_TEXT[grain]) +
      tile('Learners', num(reg.learners), num(reg.by_grade ? reg.by_grade['11'] + reg.by_grade['12'] : 0) + ' in Grades 11 and 12') +
      tile('Teachers', num(reg.teachers), 'and ' + count(reg.leaders, 'school leader', 'school leaders')) +
      tile('Parents', num(reg.parents), kind === 'country' && last && last.d.no_school ? count(last.d.no_school, 'learner has', 'learners have') + ' not chosen a school' : 'with a k12plus account') + '</div>';
    h += '<div class="grid2">' +
      card('Accounts over time', slot('c-reg-total') + '<p class="note">All accounts registered by the end of each period.</p>') +
      card('New accounts ' + PER[grain], slot('c-reg-new')) + '</div>';
    h += '<div class="grid2">' +
      card('Who has registered', slot('c-reg-roles')) +
      card('Learners by grade', slot('c-reg-grades')) + '</div>';
    if (childLabel) h += card('Registered ' + childLabel, slot('c-reg-children'), 'wide');
    return '<h2 class="section">Registrations</h2>' + h;
  }

  function drawRegistrations(reg, children) {
    if (!reg || reg.too_few) return;
    var s = reg.series || [];
    C.line($('#c-reg-total'), { labels: s.map(function (x) { return periodLabel(x.start); }), tipLabels: s.map(function (x) { return periodLabel(x.start, true); }),
      series: [{ name: 'Registered accounts', values: s.map(function (x) { return x.total; }) }], label: 'Registered accounts over time' });
    C.columns($('#c-reg-new'), { labels: s.map(function (x) { return periodLabel(x.start); }), tipLabels: s.map(function (x) { return periodLabel(x.start, true); }),
      values: s.map(function (x) { return x.new; }), name: 'New accounts', cls: 's2' });
    C.parts($('#c-reg-roles'), { label: 'Accounts by role', parts: [
      { label: 'Learners', value: reg.learners }, { label: 'Teachers', value: reg.teachers },
      { label: 'School leaders', value: reg.leaders }, { label: 'Parents', value: reg.parents }] });
    var g = reg.by_grade || {};
    C.columns($('#c-reg-grades'), { labels: ['8', '9', '10', '11', '12', 'Not given'], tipLabels: ['Grade 8', 'Grade 9', 'Grade 10', 'Grade 11', 'Grade 12', 'Grade not given'],
      values: [g['8'], g['9'], g['10'], g['11'], g['12'], g.none], name: 'Learners', cls: 's3' });
    if (children && $('#c-reg-children')) C.bars($('#c-reg-children'), { rows: children, cls: 's1', empty: 'Nobody has registered here yet.' });
  }

  function learningBlock(d, kind) {
    var h = '<h2 class="section">Learning' + (kind === 'learner' ? '' : ' <span class="note">(learners taking part with consent)</span>') + '</h2>';
    if (d.too_few) return h + '<div class="card empty"><b>' + (d.learners ? 'Fewer than five learners are taking part here' : 'No learners are taking part here yet') + '</b>Learning figures appear once at least five learners with parent or guardian and school consent are using K12Plus, so that nobody can be picked out.</div>';
    if (!d.learners && kind !== 'learner') return h + '<div class="card empty"><b>No learners are taking part yet</b>Learning figures appear here as soon as learners with parent or guardian and school consent start using K12Plus.</div>';
    var t = d.tests || {}, b = t.baseline, e = t.endline, self = kind === 'learner';
    var tiles = [];
    if (!self) tiles.push(tile('Learners taking part', num(d.learners), 'with consent'));
    tiles.push(tile('Practice accuracy', pct(d.accuracy), num(d.correct) + ' of ' + num(d.attempted) + ' answers correct'));
    tiles.push(tile('Time learning', num(d.minutes) + ' min', self ? 'in ' + GRAIN_TEXT[grain] : d.learners ? Math.round((d.minutes || 0) / d.learners) + ' min per learner' : ''));
    tiles.push(tile('Questions to the agents', num(d.questions), num(d.lessons) + ' lessons opened'));
    if (self) tiles.push(tile('Topics practised', num(d.topics_practised), 'last active ' + dayLong(d.last_active)));
    if (b || e) tiles.push(tile('Test average', (b ? pct(b.average) : 'none') + (e ? ' → ' + pct(e.average) : ''), (b ? 'start of year' + (self ? '' : ', ' + b.sat + ' sat') : '') + (e ? ' · end of year' + (self ? '' : ', ' + e.sat + ' sat') : '')));
    h += '<div class="tiles">' + tiles.join('') + '</div>';
    h += '<div class="grid2">' +
      card(self ? 'Minutes learning ' + PER[grain] : 'Active learners ' + PER[grain], slot('c-active')) +
      card('Practice accuracy ' + PER[grain], slot('c-acc') + '<p class="note">Share of practice, quiz and game answers that were correct.</p>') + '</div>';
    h += '<div class="grid2">' +
      card(self ? 'Topics, weakest first' : 'Topics that need attention', slot('c-topics')) +
      (self ? card('Questions to the agents ' + PER[grain], slot('c-q')) : card('Taking part this week', slot('c-meter') + '<h2 class="mt">Questions to the agents ' + PER[grain] + '</h2>' + slot('c-q'))) + '</div>';
    return h;
  }

  function drawLearning(d, kind) {
    if (d.too_few || (!d.learners && kind !== 'learner')) return;
    var s = d.series || [], self = kind === 'learner';
    var labels = s.map(function (x) { return periodLabel(x.start); }), tips = s.map(function (x) { return periodLabel(x.start, true); });
    C.columns($('#c-active'), { labels: labels, tipLabels: tips, values: s.map(function (x) { return self ? x.minutes : x.active; }), name: self ? 'Minutes' : 'Active learners', cls: 's1' });
    C.line($('#c-acc'), { labels: labels, tipLabels: tips, series: [{ name: 'Accuracy', values: s.map(function (x) { return x.accuracy; }), cls: 's3' }], unit: '%', max: 100, label: 'Practice accuracy' });
    var topics = (d.topics || []).slice(0, self ? 20 : 8);
    C.bars($('#c-topics'), { max: 100, unit: '%', empty: 'No practice recorded in ' + GRAIN_TEXT[grain] + '.',
      rows: topics.map(function (x) { return { label: x.topic, note: self ? x.subject : x.subject + ', ' + x.learners + ' learner' + (x.learners === 1 ? '' : 's'), value: x.accuracy, cls: x.accuracy >= 60 ? 'good' : x.accuracy < 40 ? 'warn' : 's1' }; }) });
    if ($('#c-meter')) C.meter($('#c-meter'), { value: d.active_week || 0, max: d.learners || 0, label: 'Active in the last 7 days', note: num(d.active_week) + ' of ' + num(d.learners) + ' learners' });
    C.columns($('#c-q'), { labels: labels, tipLabels: tips, values: s.map(function (x) { return x.questions; }), name: 'Questions to the agents', cls: 's2' });
  }

  function settingsBlock(d) {
    if (!d.settings) return '';
    return card('Rural and urban schools', slot('c-setting') + '<p class="note">Practice accuracy, and the share of learners active in the last 7 days.</p>');
  }
  function drawSettings(d) {
    if (!d.settings || !$('#c-setting')) return;
    var r = d.settings.rural, u = d.settings.urban, rows = [];
    [['Rural', r], ['Urban', u]].forEach(function (x) {
      if (!x[1] || x[1].too_few) { rows.push({ label: x[0] + ', accuracy', value: 0, hidden: x[1] && x[1].learners ? 'fewer than five learners' : 'no learners yet' }); return; }
      rows.push({ label: x[0] + ', accuracy', value: x[1].accuracy || 0, cls: 's1' });
      rows.push({ label: x[0] + ', active this week', value: share(x[1].active_week, x[1].learners) || 0, cls: 's2' });
    });
    C.bars($('#c-setting'), { rows: rows, max: 100, unit: '%' });
  }

  function learningTable(rows, kind, named) {
    var label = { region: 'Region', school: 'School', class: 'Class', learner: 'Learner' }[kind];
    if (!rows || !rows.length) return '';
    var h = '<div class="tbl-wrap"><table><thead><tr><th>' + label + '</th>' + (kind !== 'learner' ? '<th class="num">Learners</th>' : '') +
      '<th class="num">Active this week</th><th class="num">Accuracy</th><th class="num">Minutes' + (kind !== 'learner' ? ' each' : '') + '</th><th class="num">Questions</th><th class="num">Start of year</th><th class="num">End of year</th>' +
      (kind === 'learner' ? '<th>Last active</th>' : '') + '</tr></thead><tbody>';
    rows.forEach(function (r) {
      var go = kind === 'learner' ? '#learner/' + r.id : '#' + kind + '/' + r.id;
      var name = esc(r.name) + (r.setting ? ' <span class="pill">' + esc(r.setting) + '</span>' : '');
      var t = r.tests || {};
      if (r.too_few) {
        h += '<tr class="go" data-go="' + esc(go) + '"><td><span class="name">' + name + '</span></td><td class="num">' + num(r.learners) + '</td><td colspan="6" class="note">' +
             (r.learners ? 'fewer than five learners, so figures are hidden' : 'no learners taking part yet') + '</td></tr>';
        return;
      }
      h += '<tr class="go" data-go="' + esc(go) + '"><td><span class="name">' + name + '</span></td>' + (kind !== 'learner' ? '<td class="num">' + num(r.learners) + '</td>' : '') +
        '<td class="num">' + (kind === 'learner' ? (r.active_week ? '<span class="pill good">yes</span>' : '<span class="pill warn">no</span>') : num(r.active_week) + ' <span class="note">(' + pct(share(r.active_week, r.learners)) + ')</span>') + '</td>' +
        '<td class="num"><span class="pill ' + accClass(r.accuracy) + '">' + pct(r.accuracy) + '</span></td>' +
        '<td class="num">' + num(kind === 'learner' ? r.minutes : (r.learners ? Math.round(r.minutes / r.learners) : 0)) + '</td><td class="num">' + num(r.questions) + '</td>' +
        '<td class="num">' + (t.baseline ? pct(t.baseline.average) : 'none') + '</td><td class="num">' + (t.endline ? pct(t.endline.average) : 'none') + '</td>' +
        (kind === 'learner' ? '<td>' + (r.last_active ? dayShort(r.last_active) : 'not yet') + '</td>' : '') + '</tr>';
    });
    h += '</tbody></table></div>';
    if (!named && kind !== 'learner') h += '<p class="note">Learner names are never shown here. Groups of fewer than five learners show their number only.</p>';
    return card(kind === 'learner' ? 'Learners' : 'Learning by ' + label.toLowerCase(), h, 'wide');
  }

  function pageHead(opts) {
    var logo = opts.logo ? '<img class="school-logo" src="' + esc(opts.logo) + '" alt="' + esc(opts.title) + ' logo">' : '';
    return topNav(opts.active) + crumbs(opts.crumbs || []) +
      '<div class="head">' + logo + '<div class="head-text"><h1>' + esc(opts.title) + '</h1><div class="sub">' + esc(opts.sub || '') + '</div></div>' +
      '<div class="tools noprint">' + grainPicker() + '<button class="btn small" id="csv">CSV</button><button class="btn small" id="pr">Print</button></div></div>';
  }

  function finishPage(title) {
    app.insertAdjacentHTML('beforeend', '<p class="foot">Registrations count every k12plus account (numbers only). Learning figures cover ' + GRAIN_TEXT[grain] +
      ', in Namibian time, and only learners taking part with parent or guardian and school consent.</p>');
    bindNav(); bindTools();
    each('tr.go[data-go]', function (tr) { tr.onclick = function () { location.hash = tr.getAttribute('data-go'); }; });
    document.title = title + ' · K12Plus Monitor';
  }

  function regRows(children, kind) {
    return (children || []).filter(function (c) { return c.registered && (c.registered.too_few || c.registered.total > 0); })
      .sort(function (a, b) { return (b.registered.total || 0) - (a.registered.total || 0); })
      .map(function (c) {
        return { label: c.name, value: c.registered.total || 0, href: '#' + kind + '/' + c.id, hidden: c.registered.too_few ? 'fewer than five' : null,
                 note: c.registered.too_few ? '' : count(c.registered.learners, 'learner', 'learners') + ', ' + count(c.registered.teachers, 'teacher', 'teachers') };
      });
  }

  // ---------- views ----------
  function showCountry() {
    return rpc('monitor_country', { p_grain: grain }).then(function (d) {
      var schools = (d.children || []).reduce(function (a, r) { return a + (r.schools || 0); }, 0);
      last = { title: 'Namibia', d: d, rows: d.children, reg: d.registrations };
      app.innerHTML = pageHead({ active: '#country', title: 'Namibia', sub: schools + ' pilot schools · all 14 regions' }) +
        registrationsBlock(d.registrations, 'country', 'per region') + learningBlock(d, 'country') + attentionSlot() + settingsBlock(d) + learningTable(d.children, 'region', false);
      drawRegistrations(d.registrations, regRows(d.children, 'region'));
      drawLearning(d, 'country'); drawSettings(d);
      finishPage('Namibia');
      loadAttention('country', null, d);
    });
  }
  function showRegion(id) {
    return rpc('monitor_region', { p_region: Number(id), p_grain: grain }).then(function (d) {
      var title = d.name + ' Region';
      last = { title: title, d: d, rows: d.children, reg: d.registrations };
      app.innerHTML = pageHead({ active: '#region/' + id, title: title, sub: (d.children || []).filter(function (s) { return s.in_pilot; }).length + ' pilot schools, ' + (d.children || []).length + ' schools with accounts',
                                 crumbs: canSee('country') ? [{ t: 'Namibia', h: '#country' }, { t: d.name }] : [] }) +
        registrationsBlock(d.registrations, 'region', 'per school') + learningBlock(d, 'region') + attentionSlot() + settingsBlock(d) +
        learningTable((d.children || []).filter(function (s) { return s.in_pilot; }), 'school', false);
      drawRegistrations(d.registrations, regRows(d.children, 'school'));
      drawLearning(d, 'region'); drawSettings(d);
      finishPage(title);
      loadAttention('region', id, d);
    });
  }
  function showSchool(id) {
    return rpc('monitor_school', { p_school: id, p_grain: grain }).then(function (d) {
      var cr = [];
      if (canSee('country')) cr.push({ t: 'Namibia', h: '#country' });
      if (canSee('region', d.region_id)) cr.push({ t: d.region, h: '#region/' + d.region_id });
      cr.push({ t: d.name });
      last = { title: d.name, d: d, rows: d.children, reg: d.registrations, regClasses: d.reg_classes };
      app.innerHTML = pageHead({ active: '#school/' + id, title: d.name, sub: (d.region ? d.region + ' Region' : '') + (d.setting ? ' · ' + d.setting : ''), logo: d.logo, crumbs: cr }) +
        registrationsBlock(d.registrations, 'school', 'learners per class') + learningBlock(d, 'school') + attentionSlot() + learningTable(d.children, 'class', d.named);
      var classRows = (d.reg_classes || []).map(function (c) {
        return { label: (c.grade ? 'Grade ' + c.grade : 'Grade not given') + (c.letter ? ' ' + c.letter : ''), value: c.learners || 0, hidden: c.too_few ? 'fewer than five' : null };
      });
      drawRegistrations(d.registrations, classRows);
      drawLearning(d, 'school');
      finishPage(d.name);
      loadAttention('school', id, d);
    });
  }
  function showClass(id) {
    return rpc('monitor_class', { p_class: id, p_grain: grain }).then(function (d) {
      var cr = [];
      if (canSee('country')) cr.push({ t: 'Namibia', h: '#country' });
      if (canSee('region', d.region_id)) cr.push({ t: d.region, h: '#region/' + d.region_id });
      if (canSee('school', d.school_id) || canSee('region', d.region_id)) cr.push({ t: d.school, h: '#school/' + d.school_id });
      cr.push({ t: d.name });
      last = { title: d.name + ', ' + d.school, d: d, rows: d.named ? d.learner_rows : null, rowKind: 'learner' };
      var reg = d.registrations || {};
      var regHtml = reg.too_few ? card('Who has joined', '<p class="note">Fewer than five learners have joined, so the numbers are hidden.</p>')
        : card('Who has joined', slot('c-joined') + '<p class="note">' + num(reg.joined) + ' learners joined this class; ' + num(reg.with_consent) + ' of them have parent or guardian and school consent, so their learning is counted.</p>');
      app.innerHTML = pageHead({ active: '#class/' + id, title: d.name, sub: d.school + ' · Grade ' + d.grade, logo: d.logo, crumbs: cr }) +
        '<h2 class="section">Registrations</h2>' + regHtml + learningBlock(d, 'class') + attentionSlot() + (d.named ? learningTable(d.learner_rows, 'learner', true) : '');
      if ($('#c-joined')) C.meter($('#c-joined'), { value: reg.with_consent || 0, max: reg.joined || 0, label: 'Joined learners with consent', note: num(reg.with_consent) + ' of ' + num(reg.joined) + ' learners' });
      drawLearning(d, 'class');
      finishPage(d.name);
      loadAttention('class', id, d);
    });
  }
  function showLearner(id) {
    return rpc('monitor_learner', { p_learner: id || null, p_grain: grain }).then(function (d) {
      if (!d.taking_part) {
        app.innerHTML = topNav('#me') + '<div class="card empty"><b>Your progress will appear here</b>K12Plus keeps a record of your progress once you are in your school\'s K12Plus class and your parent or guardian and your school have given consent. Ask your mathematics teacher about joining.<br><br><a class="btn" href="https://k12plus.app/app.html">Keep learning on k12plus.app</a></div>';
        bindNav(); return;
      }
      var self = !id;
      var tr = (d.test_results || []).map(function (t) {
        return '<tr><td>' + esc(t.title) + '</td><td>' + (t.purpose === 'baseline' ? 'Start of year' : 'End of year') + '</td><td class="num">' + t.score + ' / ' + t.max + '</td><td class="num"><span class="pill ' + accClass(t.percent) + '">' + pct(t.percent) + '</span></td><td>' + dayShort(t.on) + '</td></tr>';
      }).join('');
      last = { title: d.name, d: d };
      app.innerHTML = pageHead({ active: self ? '#me' : '', title: self ? 'My progress' : d.name, sub: (self ? d.name + ' · ' : '') + d.class + ', ' + d.school, logo: d.logo,
                                 crumbs: self ? [] : [{ t: d.school }, { t: d.class, h: d.class_id ? '#class/' + d.class_id : '' }, { t: d.name }] }) +
        learningBlock(d, 'learner') +
        (tr ? card('Tests', '<div class="tbl-wrap"><table><thead><tr><th>Test</th><th>When</th><th class="num">Score</th><th class="num">Percent</th><th>Date</th></tr></thead><tbody>' + tr + '</tbody></table></div>', 'wide') : '');
      drawLearning(d, 'learner');
      finishPage(self ? 'My progress' : d.name);
    });
  }

  // ---------- who needs attention, and what to do about it ----------
  function attentionSlot() { return '<h2 class="section">Needs attention</h2><div id="att"><div class="card"><p class="note">Looking for learners who need attention…</p></div></div>'; }

  var REASON_ORDER = ['not active', 'practice accuracy', 'start of year', 'struggling with'];
  function loadAttention(kind, id, d) {
    var box = $('#att');
    if (!box) return;
    var call = kind === 'class' || kind === 'school' ? rpc('monitor_attention_for', { p_scope: kind, p_id: id, p_grain: grain })
      : rpc('monitor_attention_areas', { p_region: kind === 'region' ? Number(id) : null, p_grain: grain });
    call.then(function (a) {
      if (!$('#att')) return;
      var facts, html, key = [];
      if (kind === 'class' || kind === 'school') {
        if (a.too_few) { box.innerHTML = card('Who needs attention', '<p class="note">Fewer than five learners are taking part here, so this is hidden.</p>'); return; }
        if (a.named) {
          var rows = a.rows || [];
          html = rows.length ? '<p class="note" style="margin-top:0">' + count(a.count, 'learner needs', 'learners need') + ' attention, out of ' + num(a.learners) + '. The reasons come from their practice, activity and the start of year test.</p>' +
            '<ul class="plain attention">' + rows.map(function (r, i) {
              key.push('Learner ' + (i + 1) + ' is ' + r.name);
              return '<li><a href="#learner/' + esc(r.id) + '"><b>' + esc(r.name) + '</b></a>' + (kind === 'school' && r['class'] ? ' <span class="note">' + esc(r['class']) + '</span>' : '') +
                '<div>' + r.reasons.map(function (x) { return '<span class="pill warn">' + esc(x) + '</span>'; }).join(' ') + '</div></li>';
            }).join('') + '</ul>'
            : '<p class="note">Nobody needs extra attention right now: every learner has been active this week and is practising at 40% or better.</p>';
          facts = describe(kind, d) + '\nLearners who need attention (' + rows.length + ' of ' + a.learners + '):\n' + rows.map(function (r, i) {
            return 'Learner ' + (i + 1) + ': ' + r.reasons.join('; ') + (r.accuracy != null ? '; overall practice accuracy ' + r.accuracy + '%' : '');
          }).join('\n');
        } else {
          html = '<p class="note" style="margin-top:0">' + count(a.count, 'learner needs', 'learners need') + ' attention, out of ' + num(a.learners) + '. Names are seen only by their teachers and school.</p>' + slot('c-att-topics');
          facts = describe(kind, d) + '\n' + a.count + ' of ' + a.learners + ' learners need attention. Topics they struggle with: ' +
            (a.topics || []).map(function (t) { return t.topic + ' (' + t.learners + ' learners)'; }).join(', ');
        }
      } else {
        var label = kind === 'region' ? 'school' : 'region';
        html = '<p class="note" style="margin-top:0">' + (kind === 'region' ? 'Pilot schools' : 'Regions') + ' ranked by the share of their learners who need attention: not active for a week, practising below 40%, a low start of year test or a topic they keep getting wrong.</p>' + slot('c-att-areas');
        facts = describe(kind, d) + '\n' + (kind === 'region' ? 'Schools' : 'Regions') + ' by share of learners needing attention:\n' +
          a.map(function (x) { return x.name + (x.setting ? ' (' + x.setting + ')' : '') + ': ' + (x.too_few ? 'fewer than five learners' : x.count + ' of ' + x.learners + ' (' + x.share + '%)'); }).join('\n');
      }
      box.innerHTML = '<section class="card wide"><h2>Who needs attention</h2>' + html +
        '<div class="advice-row"><button class="btn primary" id="advise">Suggest what to do</button><span class="note">The suggestion uses the figures on this page. No names are sent.</span></div>' +
        '<div id="advice"></div></section>';
      if ($('#c-att-topics')) C.bars($('#c-att-topics'), { rows: (a.topics || []).map(function (t) { return { label: t.topic, value: t.learners, cls: 's2' }; }), unit: '', empty: 'No topic stands out yet.' });
      if ($('#c-att-areas')) C.bars($('#c-att-areas'), { max: 100, unit: '%', empty: 'No learners are taking part yet.',
        rows: a.map(function (x) { return { label: x.name, note: x.too_few ? '' : x.count + ' of ' + x.learners + ' learners', value: x.share || 0, hidden: x.too_few ? 'fewer than five' : null, href: '#' + label + '/' + x.id, cls: (x.share || 0) >= 30 ? 'warn' : 's1' }; }) });
      on('#advise', 'click', function () { askAdvice(kind, facts, key); });
    }).catch(function (e) { if ($('#att')) box.innerHTML = card('Who needs attention', '<p class="note">' + esc(e.message) + '</p>'); });
  }

  // a plain summary of the page for the adviser: figures only, never names
  function describe(kind, d) {
    var place = { class: 'One class: ' + d.name + ', Grade ' + d.grade, school: 'One school (' + (d.setting || 'setting not given') + ')', region: d.name + ' Region', country: 'Namibia, the whole pilot' }[kind];
    var lines = [place + '. Period: ' + GRAIN_TEXT[grain] + '.'];
    if (!d.too_few && d.learners) {
      lines.push('Learners taking part: ' + d.learners + '; active in the last 7 days: ' + d.active_week + '; practice accuracy: ' + (d.accuracy == null ? 'no practice yet' : d.accuracy + '%') +
        '; minutes learning: ' + d.minutes + '; questions to the agents: ' + d.questions + '.');
      var t = d.tests || {};
      if (t.baseline) lines.push('Start of year test average: ' + t.baseline.average + '% (' + t.baseline.sat + ' sat).');
      if (t.endline) lines.push('End of year test average: ' + t.endline.average + '%.');
      if ((d.topics || []).length) lines.push('Topics by accuracy, weakest first: ' + d.topics.slice(0, 6).map(function (x) { return x.topic + ' ' + x.accuracy + '%'; }).join(', ') + '.');
      if (d.settings && d.settings.rural && !d.settings.rural.too_few && d.settings.urban && !d.settings.urban.too_few)
        lines.push('Rural schools accuracy ' + d.settings.rural.accuracy + '%, urban ' + d.settings.urban.accuracy + '%.');
    }
    return lines.join('\n');
  }

  function askAdvice(kind, facts, key) {
    var out = $('#advice'), btn = $('#advise');
    btn.disabled = true; btn.textContent = 'Thinking…';
    token().then(function (t) {
      if (!t) throw signedOut();
      return fetch(SUPA + '/functions/v1/aim', { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: 'Bearer ' + t },
        body: JSON.stringify({ action: 'advice', scope: kind, facts: facts, k12token: t }) });
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); }).then(function (x) {
      if (!x.ok) throw new Error(x.d.reply || x.d.error || 'The suggestion could not be made right now.');
      out.innerHTML = '<div class="advice"><h3>Suggested next steps</h3><div class="advice-text">' + esc(x.d.advice).replace(/\n/g, '<br>') + '</div>' +
        (key.length ? '<p class="note">' + esc(key.join('. ')) + '. This key stays on your screen and was not sent.</p>' : '') +
        '<p class="note">Suggestions from the K12Plus agent. Please check them against what you know about your learners.</p></div>';
    }).catch(function (e) { out.innerHTML = '<p class="err">' + esc(e.signedOut ? 'Please sign in again.' : e.message) + '</p>'; })
      .finally(function () { btn.disabled = false; btn.textContent = 'Suggest again'; });
  }

  // ---------- funds: how each grant is used ----------
  function money(n, cur) {
    if (n == null) return 'none';
    var sym = { NAD: 'N$', USD: 'US$', ZAR: 'R', EUR: '€', GBP: '£' }[cur] || cur + ' ';
    return sym + Number(n).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }
  function showFunds() {
    return rpc('funds_overview', { p_grant: null }).then(function (d) {
      var h = topNav('#funds') + '<div class="head"><div class="head-text"><h1>Funds</h1><div class="sub">' +
        (me.funder ? 'How ' + esc(me.funder.name) + '\'s funding is being used in the K12Plus pilot.' : 'Every grant, its budget and what has been spent.') + '</div></div>' +
        (d.admin ? '<div class="tools noprint"><button class="btn small" id="f-funder">Add a funder</button><button class="btn small" id="f-grant">Add a grant</button></div>' : '') + '</div>';
      if (!d.grants.length) h += '<div class="card empty"><b>No grants recorded yet</b>' + (d.admin ? 'Add a funder, then a grant, its budget lines and expenses.' : 'K-Twelve Educational Technologies will add your grant here.') + '</div>';
      d.grants.forEach(function (g, i) {
        h += '<section class="grant"><div class="head grant-head">' + (g.funder_logo ? '<img class="school-logo" src="' + esc(g.funder_logo) + '" alt="' + esc(g.funder) + ' logo">' : '') +
          '<div class="head-text"><h2 class="section" style="margin:0">' + esc(g.title) + '</h2><div class="sub">' + esc(g.funder) + ' · ' + dayLong(g.starts_on) + ' to ' + dayLong(g.ends_on) + '</div></div>' +
          (d.admin ? '<div class="tools noprint"><button class="btn small" data-line="' + g.id + '">Add a budget line</button><button class="btn small primary" data-exp="' + g.id + '">Record an expense</button></div>' : '') + '</div>' +
          '<div class="tiles">' +
            tile('Grant', money(g.amount, g.currency), g.running_costs ? 'also pays the pilot\'s running costs' : '') +
            tile('Spent', money(g.spent, g.currency), g.used_pct + '% of the grant') +
            tile('Remaining', money(g.remaining, g.currency), 'about ' + money(g.per_month, g.currency) + ' spent a month') +
            tile('For each learner', money(g.per_learner, g.currency), count(g.learners, 'learner', 'learners') + ' taking part with consent') + '</div>' +
          '<div class="grid2">' + card('Spent against time', '<div id="f-meter-' + i + '"></div><div id="f-time-' + i + '" class="mt"></div><p class="note">When spending runs well ahead of time, the money may run out before the grant ends.</p>') +
            card('Spending over time', slot('f-line-' + i) + '<p class="note">Running total, month by month, in ' + esc(g.currency) + '.</p>') + '</div>' +
          card('Budget lines: planned and spent', slot('f-lines-' + i), 'wide') +
          card('Expenses', g.expenses.length ? '<div class="tbl-wrap"><table><thead><tr><th>Date</th><th>What</th><th>Budget line</th><th>Reference</th><th class="num">Amount</th>' + (d.admin ? '<th class="noprint"></th>' : '') + '</tr></thead><tbody>' +
            g.expenses.map(function (e) {
              return '<tr><td>' + dayShort(e.on) + '</td><td>' + esc(e.description) + '</td><td>' + esc(e.category || 'not given') + '</td><td>' + esc(e.reference || '') + '</td><td class="num">' + money(e.amount, g.currency) + '</td>' +
                (d.admin ? '<td class="noprint"><button class="link-btn" data-rmexp="' + e.id + '">remove</button></td>' : '') + '</tr>';
            }).join('') + '</tbody></table></div>' : '<p class="note">No expenses recorded yet.</p>', 'wide') + '</section>';
      });
      if (d.admin) h += card('Funders and their people', (d.funders || []).map(function (f) {
        return '<div class="funder-row"><b>' + esc(f.name) + '</b> ' + (f.people.length ? f.people.map(function (p) { return '<span class="pill right">' + esc(p.name) + ' <button class="link-btn" data-rmp="' + p.user_id + '">remove</button></span>'; }).join(' ') : '<span class="note">nobody yet</span>') +
          ' <button class="btn small" data-addp="' + f.id + '">Give someone access</button></div>';
      }).join('') || '<p class="note">No funders yet.</p>', 'wide');
      app.innerHTML = h;
      bindNav();
      d.grants.forEach(function (g, i) {
        C.meter($('#f-meter-' + i), { value: Math.max(0, g.spent), max: g.amount, label: 'Grant spent', note: money(g.spent, g.currency) + ' of ' + money(g.amount, g.currency) });
        C.meter($('#f-time-' + i), { value: g.time_pct, max: 100, label: 'Grant time gone', note: dayLong(g.starts_on) + ' to ' + dayLong(g.ends_on) });
        var m = g.monthly || [];
        C.line($('#f-line-' + i), { labels: m.map(function (x) { return asDate(x.month).toLocaleDateString('en-GB', { month: 'short' }); }), tipLabels: m.map(function (x) { return asDate(x.month).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }); }),
          series: [{ name: 'Spent so far', values: m.map(function (x) { return Number(x.cumulative); }) }], label: 'Spending over time' });
        C.bars($('#f-lines-' + i), { empty: 'No budget lines yet.', rows: g.lines.map(function (l) {
          var pctUsed = l.planned ? Math.round(100 * l.spent / l.planned) : null;
          return { label: l.category, value: Number(l.spent), note: l.planned != null ? 'of ' + money(l.planned, g.currency) + ' planned (' + pctUsed + '%)' : 'worked out from the pilot records',
                   cls: pctUsed != null && pctUsed > 100 ? 'warn' : 's1' };
        }), max: Math.max.apply(null, g.lines.map(function (l) { return Math.max(Number(l.spent), Number(l.planned || 0)); }).concat([1])) });
      });
      if (d.admin) bindFundsAdmin(d);
      document.title = 'Funds · K12Plus Monitor';
    });
  }

  function bindFundsAdmin(d) {
    var save = function (action, p) { return rpc('funds_admin', { p_action: action, p: p }).then(function () { return route(); }); };
    var funderOptions = (d.funders || []).map(function (f) { return '<option value="' + f.id + '">' + esc(f.name) + '</option>'; }).join('');
    on('#f-funder', 'click', function () {
      dialog('Add a funder', '<label for="fn">Name</label><input id="fn" type="text" required maxlength="120"><label for="fw">Website (optional)</label><input id="fw" type="text">' +
        '<label for="fl">Logo address (optional)</label><input id="fl" type="text" placeholder="https://">', 'Add funder', function (f) {
        return save('save_funder', { name: f.querySelector('#fn').value, website: f.querySelector('#fw').value, logo_url: f.querySelector('#fl').value });
      });
    });
    on('#f-grant', 'click', function () {
      if (!funderOptions) { notice('Add a funder first', '<p>Every grant belongs to a funder.</p>'); return; }
      dialog('Add a grant', '<label for="gf">Funder</label><select id="gf">' + funderOptions + '</select><label for="gt">Title</label><input id="gt" type="text" required placeholder="K12Plus pilot 2027">' +
        '<div class="two"><div><label for="ga">Amount</label><input id="ga" type="text" inputmode="decimal" required></div><div><label for="gc">Currency</label><select id="gc"><option>NAD</option><option>USD</option><option>ZAR</option><option>EUR</option><option>GBP</option></select></div></div>' +
        '<label for="gr">Units of this currency for one US dollar</label><input id="gr" type="text" value="18"><p class="note">Used to convert the pilot\'s running costs, which are counted in US dollars.</p>' +
        '<div class="two"><div><label for="gs">Starts</label><input id="gs" type="date" required></div><div><label for="ge">Ends</label><input id="ge" type="date" required></div></div>' +
        '<label class="check"><input type="checkbox" id="gx"> This grant pays the pilot\'s running costs (data, texts and USSD)</label>', 'Add grant', function (f) {
        return save('save_grant', { funder_id: f.querySelector('#gf').value, title: f.querySelector('#gt').value, amount: Number(f.querySelector('#ga').value.replace(/[^\d.]/g, '')),
          currency: f.querySelector('#gc').value, per_usd: Number(f.querySelector('#gr').value) || 1, starts_on: f.querySelector('#gs').value, ends_on: f.querySelector('#ge').value,
          running_costs: f.querySelector('#gx').checked });
      });
      on('#gc', 'change', function () { $('#gr').value = $('#gc').value === 'USD' ? '1' : $('#gc').value === 'NAD' || $('#gc').value === 'ZAR' ? '18' : '0.9'; });
    });
    each('[data-line]', function (b) {
      b.onclick = function () {
        dialog('Add a budget line', '<label for="lc">Category</label><input id="lc" type="text" required placeholder="Teacher training"><label for="lp">Planned amount</label><input id="lp" type="text" inputmode="decimal" required>' +
          '<label for="ln">Note (optional)</label><input id="ln" type="text">', 'Add budget line', function (f) {
          return save('save_line', { grant_id: b.getAttribute('data-line'), category: f.querySelector('#lc').value, planned: Number(f.querySelector('#lp').value.replace(/[^\d.]/g, '')), note: f.querySelector('#ln').value });
        });
      };
    });
    each('[data-exp]', function (b) {
      var g = d.grants.filter(function (x) { return x.id === b.getAttribute('data-exp'); })[0];
      b.onclick = function () {
        dialog('Record an expense', '<label for="ed">Date</label><input id="ed" type="date" required value="' + new Date().toISOString().slice(0, 10) + '">' +
          '<label for="ew">What it was for</label><input id="ew" type="text" required maxlength="240"><div class="two"><div><label for="ea">Amount (' + esc(g.currency) + ')</label><input id="ea" type="text" inputmode="decimal" required></div>' +
          '<div><label for="el2">Budget line</label><select id="el2"><option value="">Not given</option>' + g.lines.filter(function (l) { return l.id; }).map(function (l) { return '<option value="' + l.id + '">' + esc(l.category) + '</option>'; }).join('') + '</select></div></div>' +
          '<label for="er">Invoice or receipt number (optional)</label><input id="er" type="text" maxlength="80">', 'Record expense', function (f) {
          return save('add_expense', { grant_id: g.id, spent_on: f.querySelector('#ed').value, description: f.querySelector('#ew').value, amount: Number(f.querySelector('#ea').value.replace(/[^\d.]/g, '')),
            budget_line_id: f.querySelector('#el2').value ? Number(f.querySelector('#el2').value) : null, reference: f.querySelector('#er').value });
        });
      };
    });
    each('[data-rmexp]', function (b) { b.onclick = function () { b.disabled = true; save('remove_expense', { id: Number(b.getAttribute('data-rmexp')) }); }; });
    each('[data-rmp]', function (b) { b.onclick = function () { b.disabled = true; save('remove_person', { user_id: b.getAttribute('data-rmp') }); }; });
    each('[data-addp]', function (b) {
      b.onclick = function () {
        dialog('Give someone access', '<p class="note">They sign up at k12plus.app first. They will see the whole pilot without learner names, and this funder\'s grants.</p>' +
          '<label for="pi">Their email, mobile number or k12plus ID</label><input id="pi" type="text" required>', 'Give access', function (f) {
          return save('add_person', { identifier: f.querySelector('#pi').value, funder_id: b.getAttribute('data-addp') });
        });
      };
    });
  }

  // ---------- CSV ----------
  function csvCell(v) { v = v == null ? '' : String(v); return /[",\n;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function downloadCsv() {
    if (!last) return;
    var L = [], d = last.d;
    L.push(csvCell(last.title) + ',' + csvCell('Period: ' + GRAIN_TEXT[grain]));
    if (last.reg && !last.reg.too_few) {
      L.push(''); L.push('Registrations,total,learners,teachers,school leaders,parents,new in period');
      L.push([csvCell(last.title), last.reg.total, last.reg.learners, last.reg.teachers, last.reg.leaders, last.reg.parents, last.reg.new_period].join(','));
      (last.rows || []).forEach(function (r) {
        if (!r.registered) return;
        L.push(r.registered.too_few ? csvCell(r.name) + ',fewer than five' : [csvCell(r.name), r.registered.total, r.registered.learners, r.registered.teachers, r.registered.leaders, r.registered.parents, r.registered.new_period].join(','));
      });
      L.push(''); L.push('Period starting,new accounts,registered by then');
      (last.reg.series || []).forEach(function (x) { L.push([x.start, x.new, x.total].join(',')); });
    }
    (last.regClasses || []).forEach(function (c, i) {
      if (i === 0) { L.push(''); L.push('Grade,class,learners registered'); }
      L.push([c.grade || '', c.letter || '', c.too_few ? 'fewer than five' : c.learners].join(','));
    });
    var cols = ['learners', 'active_week', 'active_period', 'accuracy', 'correct', 'attempted', 'minutes', 'questions', 'lessons'];
    L.push(''); L.push(['Learning'].concat(cols, ['start of year average', 'end of year average']).join(','));
    function line(name, r) {
      if (r.too_few) return csvCell(name) + ',' + (r.learners || 0) + ',fewer than five learners';
      var t = r.tests || {};
      return [csvCell(name)].concat(cols.map(function (c) { return r[c] == null ? '' : r[c]; }), [t.baseline ? t.baseline.average : '', t.endline ? t.endline.average : '']).join(',');
    }
    L.push(line(last.title, d));
    (last.rows || []).forEach(function (r) { L.push(line(r.name, r)); });
    if (d.series) { L.push(''); L.push('Period starting,active learners,minutes,questions,answers,accuracy'); d.series.forEach(function (x) { L.push([x.start, x.active, x.minutes, x.questions, x.attempted, x.accuracy == null ? '' : x.accuracy].join(',')); }); }
    if (d.topics && d.topics.length) { L.push(''); L.push('Subject,Topic,Learners,Answers,Correct,Accuracy'); d.topics.forEach(function (t) { L.push([csvCell(t.subject), csvCell(t.topic), t.learners, t.attempted, t.correct, t.accuracy].join(',')); }); }
    var blob = new Blob(['﻿' + L.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'k12plus-' + last.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '') + '-' + grain + '-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  // ---------- accounts ----------
  var acc = { scope: null, id: null, search: '', role: '', page: 0, data: null };

  function scopeHash(m) { return '#accounts/' + m.scope + (m.id ? '/' + m.id : ''); }
  function showAccounts(scope, id) {
    var mine = me.manage || [];
    if (!mine.length) return Promise.resolve(noAccess());
    if (!scope) { location.replace(scopeHash(mine[0])); return Promise.resolve(); }
    if (acc.scope !== scope || acc.id !== (id || null)) { acc = { scope: scope, id: id || null, search: '', role: '', page: 0, data: null }; }
    var here = mine.filter(function (m) { return m.scope === scope && String(m.id || '') === String(id || ''); })[0];
    return Promise.all([
      rpc('account_list', { p_scope: scope, p_id: id || null, p_search: acc.search || null, p_role: acc.role || null, p_page: acc.page }),
      rpc('account_history', { p_scope: scope, p_id: id || null })
    ]).then(function (x) {
      var d = x[0], hist = x[1];
      acc.data = d;
      var title = here ? here.name : (scope === 'country' ? 'Namibia' : SCOPE[scope]);
      var scopes = mine.length > 1 ? '<div class="views sub-views">' + mine.map(function (m) {
        var h = scopeHash(m);
        return '<button class="chip' + (h === '#accounts/' + scope + (id ? '/' + id : '') ? ' on' : '') + '" data-h="' + esc(h) + '">' + esc(SCOPE[m.scope] + ': ' + m.name) + '</button>';
      }).join('') + '</div>' : '';
      var canAddLearner = d.learners_shown, canAddTeacher = d.rank >= 2;
      var h = topNav('#accounts') + scopes +
        '<div class="head"><div class="head-text"><h1>Accounts · ' + esc(title) + '</h1><div class="sub">' +
        num(d.counts.learners) + ' learners and ' + num(d.counts.staff) + ' staff here. Every change is recorded below.</div></div>' +
        '<div class="tools noprint">' + (canAddLearner || canAddTeacher ? '<button class="btn primary" id="add">Add an account</button>' : '') + '</div></div>';
      if (!d.learners_shown) h += '<div class="card soft"><p class="note" style="margin:0">Learner accounts are looked after by their teachers and school, so only staff accounts are listed here.</p></div>';
      if (scope === 'school' && d.rank >= 2) h += logoCard();
      h += '<section class="card wide"><div class="filters"><input type="search" id="q" placeholder="Search by name, k12plus ID or mobile number" value="' + esc(acc.search) + '">' +
        '<select id="rf" aria-label="Role"><option value="">Everyone</option>' + (d.learners_shown ? '<option value="learner">Learners</option><option value="parent">Parents</option>' : '') +
        '<option value="educator">Teachers</option><option value="leader">School leaders</option><option value="ministry">Ministry officials</option></select></div>' +
        usersTable(d) + pager(d) + '</section>';
      h += '<div class="grid2">' + card('People with rights here', managersList(d) + (d.grant_rank >= RANK[scope] ? '<button class="btn" id="give">Give rights</button>' : '<p class="note">You can manage accounts here, but you cannot give rights to others.</p>')) +
        card('History', historyList(hist)) + '</div>';
      app.innerHTML = h;
      $('#rf').value = acc.role;
      bindNav();
      var timer = null;
      on('#q', 'input', function (ev) { clearTimeout(timer); timer = setTimeout(function () { acc.search = ev.target.value.trim(); acc.page = 0; route(); }, 400); });
      on('#rf', 'change', function (ev) { acc.role = ev.target.value; acc.page = 0; route(); });
      on('#prev', 'click', function () { acc.page--; route(); });
      on('#next', 'click', function () { acc.page++; route(); });
      on('#add', 'click', function () { addAccount(d); });
      on('#give', 'click', function () { giveRights(d); });
      each('[data-act]', function (b) { b.onclick = function () { rowAction(b.getAttribute('data-act'), b.getAttribute('data-id')); }; });
      each('[data-revoke]', function (b) {
        b.onclick = function () {
          b.disabled = true;
          rpc('account_revoke', { p_right: Number(b.getAttribute('data-revoke')) }).then(refreshMe).catch(function (e) { b.disabled = false; notice('That did not work', esc(e.message)); });
        };
      });
      bindLogo();
      if ($('#q') && acc.search) { var q = $('#q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
      document.title = 'Accounts · K12Plus Monitor';
    });
  }

  function usersTable(d) {
    if (!d.rows.length) return '<p class="note">No accounts match.</p>';
    return '<div class="tbl-wrap"><table class="users"><thead><tr><th>Name</th><th>Role</th><th>School and class</th><th>Signs in with</th><th>Last signed in</th><th>Status</th><th class="noprint"></th></tr></thead><tbody>' +
      d.rows.map(function (u) {
        var place = (u.school || 'no school') + (u.grade ? ', Grade ' + u.grade + (u.class_letter || '') : '') + (u.class ? ' · ' + u.class : '');
        var status = u.disabled ? '<span class="pill warn">switched off</span>' : u.temporary_password ? '<span class="pill">temporary password</span>' : '<span class="pill good">active</span>';
        var rights = (u.rights || []).map(function (r) { return '<span class="pill right">' + esc(SCOPE[r.scope]) + ': ' + esc(r.name || '') + '</span>'; }).join(' ');
        var actions = u.can_manage ? '<div class="row-actions">' +
          '<button class="btn small" data-act="edit" data-id="' + u.id + '">Edit</button>' +
          '<button class="btn small" data-act="reset" data-id="' + u.id + '">Temporary password</button>' +
          '<button class="btn small" data-act="' + (u.disabled ? 'enable' : 'disable') + '" data-id="' + u.id + '">' + (u.disabled ? 'Switch on' : 'Switch off') + '</button></div>' : '<span class="note">managed above you</span>';
        return '<tr><td><span class="name">' + esc(u.name) + '</span>' + (rights ? '<div>' + rights + '</div>' : '') + '</td><td>' + esc(ROLE[u.role] || u.role) + '</td><td>' + esc(place) + '</td>' +
          '<td>' + esc(u.email || u.k12_id || '') + (u.phone ? '<div class="note">' + esc(u.phone) + '</div>' : '') + '</td>' +
          '<td>' + (u.last_sign_in ? dayShort(u.last_sign_in) : '<span class="note">never</span>') + '</td><td>' + status + '</td><td class="noprint">' + actions + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function pager(d) {
    if (d.total <= 50) return '<p class="note">' + num(d.total) + ' account' + (d.total === 1 ? '' : 's') + '.</p>';
    var pages = Math.ceil(d.total / 50);
    return '<div class="pager"><button class="btn small" id="prev"' + (d.page ? '' : ' disabled') + '>Previous</button><span class="note">Page ' + (d.page + 1) + ' of ' + pages + ', ' + num(d.total) + ' accounts</span>' +
      '<button class="btn small" id="next"' + (d.page + 1 < pages ? '' : ' disabled') + '>Next</button></div>';
  }
  function managersList(d) {
    var people = d.rows.filter(function (u) { return (u.rights || []).length; });
    if (!people.length) return '<p class="note">Nobody on this page holds rights here yet.</p>';
    return '<ul class="plain">' + people.map(function (u) {
      return '<li><b>' + esc(u.name) + '</b> ' + u.rights.map(function (r) {
        var src = r.source === 'given' ? (r.can_grant ? 'may also give rights' : 'given') : r.source;
        var canRemove = r.source === 'given' && r.id && d.grant_rank >= RANK[r.scope] && (!r.can_grant || d.grant_rank > RANK[r.scope]);
        return '<span class="pill right">' + esc(SCOPE[r.scope] + ': ' + (r.name || '')) + ' · ' + esc(src) + '</span>' +
          (canRemove ? ' <button class="link-btn" data-revoke="' + r.id + '">remove</button>' : '');
      }).join(' ') + '</li>';
    }).join('') + '</ul>';
  }
  var ACTION = { create: 'added', edit: 'edited', reset_password: 'gave a temporary password to', disable: 'switched off', enable: 'switched on', grant: 'gave rights to', revoke: 'removed rights from', logo: 'changed the school logo' };
  function historyList(h) {
    if (!h || !h.length) return '<p class="note">No changes yet.</p>';
    return '<ul class="plain history">' + h.slice(0, 40).map(function (a) {
      var extra = (a.action === 'grant' || a.action === 'revoke') && a.scope ? ' (' + esc(SCOPE[a.scope] || '') + ')'
        : a.action === 'edit' && a.fields ? ' (' + esc(a.fields.join(', ').replace('class_letter', 'class letter').replace('school', 'moved school')) + ')' : '';
      return '<li><span class="note">' + dayShort(a.at) + ' ' + asDate(a.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + '</span> ' +
        esc(a.by || 'Someone') + ' ' + ACTION[a.action] + ' ' + esc(a.target || '') + extra + (a.status === 'failed' ? ' <span class="pill warn">did not finish</span>' : '') + '</li>';
    }).join('') + '</ul>';
  }

  function refreshMe() { me = null; return route(); }
  function findUser(id) { return (acc.data.rows || []).filter(function (u) { return u.id === id; })[0]; }

  function rowAction(act, id) {
    var u = findUser(id);
    if (!u) return;
    if (act === 'reset') {
      var sug = suggestPassword();
      dialog('Temporary password for ' + u.name,
        '<p class="note">' + esc(u.name) + ' signs in with this once, then chooses their own. Tell them in person or by phone; it is not shown again.</p>' +
        '<label for="tp">Temporary password</label><div class="inline"><input id="tp" type="text" value="' + sug + '" required autocomplete="off"><button type="button" class="btn small" id="sug">Another</button></div>' +
        '<p class="note">Signs in with: <b>' + esc(u.email || u.k12_id || u.phone || '') + '</b></p>',
        'Set temporary password', function (f) {
          var pw = f.querySelector('#tp').value;
          return service('reset_password', { user_id: id, temp_password: pw }).then(function () {
            notice('Temporary password set', '<p>' + esc(u.name) + ' can now sign in with <b>' + esc(u.email || u.k12_id || '') + '</b> and the temporary password <b class="mono">' + esc(pw) + '</b>.</p><p class="note">They will be asked to choose their own password straight away.</p>');
            return route();
          });
        });
      on('#sug', 'click', function () { $('#tp').value = suggestPassword(); });
      return;
    }
    if (act === 'disable' || act === 'enable') {
      dialog((act === 'disable' ? 'Switch off ' : 'Switch on ') + u.name + '?',
        '<p>' + (act === 'disable' ? esc(u.name) + ' will not be able to sign in until the account is switched on again. Nothing is deleted.' : esc(u.name) + ' will be able to sign in again.') + '</p>',
        act === 'disable' ? 'Switch off' : 'Switch on', function () { return service(act, { user_id: id }).then(route); });
      return;
    }
    if (act === 'edit') {
      var staff = ['learner', 'parent'].indexOf(u.role) < 0;
      var roles = ['educator', 'hod', 'principal', 'school_admin'];
      dialog('Edit ' + u.name,
        '<label for="en">Name</label><input id="en" type="text" value="' + esc(u.name) + '" required maxlength="80">' +
        (u.role === 'learner' ? '<div class="two"><div><label for="eg">Grade</label><select id="eg"><option value="">Not given</option>' + [8, 9, 10, 11, 12].map(function (g) { return '<option' + (u.grade === g ? ' selected' : '') + '>' + g + '</option>'; }).join('') + '</select></div>' +
          '<div><label for="el">Class letter</label><select id="el"><option value="">Not given</option>' + 'ABCDEFGHIJKL'.split('').map(function (l) { return '<option' + (u.class_letter === l ? ' selected' : '') + '>' + l + '</option>'; }).join('') + '</select></div></div>' : '') +
        '<label for="ep">Mobile number</label><input id="ep" type="tel" value="' + esc(u.phone || '') + '" placeholder="081 234 5678">' +
        (staff ? '<label for="er">Role</label><select id="er">' + roles.map(function (r) { return '<option value="' + r + '"' + (u.role === r ? ' selected' : '') + '>' + ROLE[r] + '</option>'; }).join('') + '</select>' +
          (acc.data.rank >= 3 ? '<label for="es">School</label><div class="inline"><input id="ess" type="search" placeholder="Search for a school"><button type="button" class="btn small" id="esb">Find</button></div><select id="es"><option value="' + esc(u.school_id || '') + '">' + esc(u.school || 'No school') + '</option></select>' : '') : ''),
        'Save', function (f) {
          var p = { name: f.querySelector('#en').value, phone: f.querySelector('#ep').value || null };
          if (u.role === 'learner') { p.grade = f.querySelector('#eg').value ? Number(f.querySelector('#eg').value) : null; p.class_letter = f.querySelector('#el').value || null; }
          if (staff) { p.role = f.querySelector('#er').value; if (f.querySelector('#es') && f.querySelector('#es').value) p.school_id = f.querySelector('#es').value; }
          return rpc('account_update', { p_user: id, p: p }).then(route);
        });
      on('#esb', 'click', function () { schoolSearch($('#ess').value, $('#es')); });
    }
  }

  function schoolSearch(text, select, onDone) {
    return rpc('account_schools', { p_scope: acc.scope, p_id: acc.id, p_search: text || null }).then(function (list) {
      select.innerHTML = list.length ? list.map(function (s) { return '<option value="' + s.id + '">' + esc(s.name + (s.region ? ', ' + s.region : '')) + '</option>'; }).join('') : '<option value="">No school found</option>';
      select._schools = list;
      if (onDone) onDone(list);
    });
  }

  function addAccount(d) {
    var scope = acc.scope, fixedSchool = scope === 'school' || scope === 'class';
    var roles = (d.learners_shown ? '<option value="learner">Learner</option>' : '') + (d.rank >= 2 ? '<option value="educator">Teacher</option>' : '');
    dialog('Add an account',
      '<label for="ar">Kind of account</label><select id="ar">' + roles + '</select>' +
      '<label for="an">Full name</label><input id="an" type="text" required maxlength="80">' +
      (fixedSchool ? '' : '<label for="ass">School</label><div class="inline"><input id="ass" type="search" placeholder="Search for a school"><button type="button" class="btn small" id="asb">Find</button></div>') +
      '<select id="as" ' + (fixedSchool ? 'hidden' : '') + '></select>' +
      '<div data-learner><label for="ac">K12Plus class <span class="note">(pilot classes)</span></label><select id="ac"></select>' +
      '<div class="two"><div><label for="ag">Grade</label><select id="ag"><option value="">Not given</option><option>8</option><option>9</option><option>10</option><option>11</option><option>12</option></select></div>' +
      '<div><label for="al">Class letter</label><select id="al"><option value="">Not given</option>' + 'ABCDEFGHIJKL'.split('').map(function (l) { return '<option>' + l + '</option>'; }).join('') + '</select></div></div></div>' +
      '<label for="ap">Mobile number <span class="note">(optional)</span></label><input id="ap" type="tel" placeholder="081 234 5678">' +
      '<div data-teacher hidden><label for="ae">Email address <span class="note">(optional; without one they sign in with their k12plus ID or mobile number)</span></label><input id="ae" type="email"></div>' +
      '<label for="at">Temporary password</label><div class="inline"><input id="at" type="text" required value="' + suggestPassword() + '" autocomplete="off"><button type="button" class="btn small" id="atg">Another</button></div>' +
      '<p class="note">They choose their own password the first time they sign in.</p>',
      'Add account', function (f) {
        var role = f.querySelector('#ar').value, sel = f.querySelector('#as');
        var body = { role: role, name: f.querySelector('#an').value, school_id: sel.value, temp_password: f.querySelector('#at').value, phone: f.querySelector('#ap').value || null };
        if (!body.school_id) throw new Error('Choose the school first.');
        if (role === 'learner') {
          body.class_id = f.querySelector('#ac').value || (scope === 'class' ? acc.id : null);
          body.grade = f.querySelector('#ag').value || null; body.class_letter = f.querySelector('#al').value || null;
        } else body.email = f.querySelector('#ae').value || null;
        return service('create', body).then(function (r) {
          notice('Account added', '<p><b>' + esc(r.name) + '</b> can now sign in with <b>' + esc(r.signs_in_with) + '</b> and the temporary password <b class="mono">' + esc(body.temp_password) + '</b>.</p>' +
            '<p class="note">Their k12plus ID is ' + esc(r.k12_id) + '. They will choose their own password at first sign-in.</p>');
          return route();
        });
      });
    var sel = $('#as'), cls = $('#ac');
    function fillClasses() {
      var s = (sel._schools || []).filter(function (x) { return x.id === sel.value; })[0];
      var list = s ? s.classes : [];
      cls.innerHTML = (scope === 'class' ? '' : '<option value="">No pilot class</option>') + list.filter(function (c) { return scope !== 'class' || c.id === acc.id; }).map(function (c) { return '<option value="' + c.id + '">' + esc(c.name) + '</option>'; }).join('');
    }
    function roleChanged() {
      var learner = $('#ar').value === 'learner';
      $('[data-learner]').hidden = !learner; $('[data-teacher]').hidden = learner;
    }
    on('#ar', 'change', roleChanged); roleChanged();
    on(sel, 'change', fillClasses);
    on('#atg', 'click', function () { $('#at').value = suggestPassword(); });
    on('#asb', 'click', function () { schoolSearch($('#ass').value, sel, fillClasses); });
    if (fixedSchool) schoolSearch(null, sel, fillClasses);
  }

  function giveRights(d) {
    var scope = acc.scope, levels = [];
    if (scope === 'country') levels = [['country', 'All of Namibia'], ['region', 'A region']];
    if (scope === 'region') levels = [['region', 'This region'], ['school', 'A school in this region']];
    if (scope === 'school') levels = [['school', 'This school'], ['class', 'A K12Plus class at this school']];
    if (scope === 'class') levels = [['class', 'This class']];
    levels = levels.filter(function (l) { return d.grant_rank >= RANK[l[0]]; });
    dialog('Give rights',
      '<p class="note">Rights let a member of staff manage accounts and see figures for an area. They must already have a k12plus account.</p>' +
      '<label for="gi">Their email address, mobile number or k12plus ID</label><input id="gi" type="text" required>' +
      '<label for="gl">For</label><select id="gl">' + levels.map(function (l) { return '<option value="' + l[0] + '">' + esc(l[1]) + '</option>'; }).join('') + '</select>' +
      '<div id="gpick"></div>' +
      '<label class="check"><input type="checkbox" id="gg"> They may also give rights to others in that area</label><p class="note" id="ggn"></p>',
      'Give rights', function (f) {
        var lvl = f.querySelector('#gl').value, area = acc.id, pick = f.querySelector('#gp');
        if (lvl !== scope) { if (!pick || !pick.value) throw new Error('Choose where.'); area = pick.value; }
        if (lvl === 'country') area = null;
        return rpc('account_grant', { p_identifier: f.querySelector('#gi').value, p_scope: lvl, p_id: area, p_can_grant: f.querySelector('#gg').checked }).then(refreshMe);
      });
    function levelChanged() {
      var lvl = $('#gl').value, box = $('#gpick'), gg = $('#gg');
      gg.disabled = !(d.grant_rank > RANK[lvl]); if (gg.disabled) gg.checked = false;
      $('#ggn').textContent = gg.disabled ? 'Only someone above this level can let others give rights here.' : '';
      box.innerHTML = '';
      if (lvl === scope || lvl === 'country') return;
      if (lvl === 'region') {
        fetch(SUPA + '/rest/v1/regions?select=id,name&order=name', { headers: { apikey: KEY } }).then(function (r) { return r.json(); }).then(function (rs) {
          box.innerHTML = '<label for="gp">Region</label><select id="gp">' + rs.map(function (r) { return '<option value="' + r.id + '">' + esc(r.name) + '</option>'; }).join('') + '</select>';
        });
      } else if (lvl === 'school') {
        box.innerHTML = '<label for="gps">School</label><div class="inline"><input id="gps" type="search" placeholder="Search for a school"><button type="button" class="btn small" id="gpb">Find</button></div><select id="gp"></select>';
        on('#gpb', 'click', function () { schoolSearch($('#gps').value, $('#gp')); });
        schoolSearch(null, $('#gp'));
      } else if (lvl === 'class') {
        box.innerHTML = '<label for="gp">Class</label><select id="gp"></select>';
        schoolSearch(null, $('#gp'), function (list) {
          var classes = list.length ? list[0].classes : [];
          $('#gp').innerHTML = classes.length ? classes.map(function (c) { return '<option value="' + c.id + '">' + esc(c.name) + '</option>'; }).join('') : '<option value="">This school has no K12Plus classes yet</option>';
        });
      }
    }
    on('#gl', 'change', levelChanged); levelChanged();
  }

  // school logo: shown on the school and class pages
  function logoCard() {
    var school = (me.views || []).filter(function (v) { return v.kind === 'school' && String(v.id) === String(acc.id); })[0] || {};
    return '<section class="card soft logo-card"><div class="logo-row">' +
      (school.logo ? '<img class="school-logo" src="' + esc(school.logo) + '" alt="School logo">' : '<div class="logo-empty">No logo yet</div>') +
      '<div><h2>School logo</h2><p class="note">A PNG, JPG or WebP picture smaller than 300 KB. It appears on the school and class pages.</p>' +
      '<label class="btn small file-btn">Choose a picture<input type="file" id="logo" accept="image/png,image/jpeg,image/webp" hidden></label> <span class="note" id="logomsg"></span></div></div></section>';
  }
  function bindLogo() {
    on('#logo', 'change', function (ev) {
      var file = ev.target.files[0], msg = $('#logomsg');
      if (!file) return;
      if (file.size > 300 * 1024) { msg.textContent = 'That picture is larger than 300 KB.'; return; }
      msg.textContent = 'Uploading…';
      var reader = new FileReader();
      reader.onload = function () {
        var data = String(reader.result).split(',')[1];
        service('logo', { school_id: acc.id, data: data }).then(function () { msg.textContent = 'Saved.'; return refreshMe(); })
          .catch(function (e) { msg.textContent = e.message; });
      };
      reader.readAsDataURL(file);
    });
  }

  // ---------- administrators: officials ----------
  function showOfficials() {
    return Promise.all([rpc('monitor_officials_list'), fetch(SUPA + '/rest/v1/regions?select=id,name&order=name', { headers: { apikey: KEY } }).then(function (r) { return r.json(); })]).then(function (x) {
      var list = x[0] || [], regions = x[1] || [];
      app.innerHTML = topNav('#officials') + '<div class="head"><div class="head-text"><h1>Officials</h1><div class="sub">Ministry and regional officials who can open K12Plus Monitor. They see figures for schools and classes, never learner names. To let an official manage staff accounts too, give them rights on the Accounts page.</div></div></div>' +
        card('Give access', '<form id="af" class="form-row">' +
          '<div><label for="ai">Their email, mobile number or k12plus ID</label><input id="ai" type="text" required></div>' +
          '<div><label for="ar2">Access</label><select id="ar2"><option value="">National</option>' + regions.map(function (r) { return '<option value="' + r.id + '">' + esc(r.name) + ' Region</option>'; }).join('') + '</select></div>' +
          '<div><label for="at2">Title (optional)</label><input id="at2" type="text" maxlength="120" placeholder="Regional Director of Education"></div>' +
          '<div><button class="btn primary" type="submit">Give access</button></div></form><div class="err" id="ae"></div>') +
        card('People with access', list.length ? '<div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Title</th><th>Access</th><th>Since</th><th></th></tr></thead><tbody>' + list.map(function (o) {
          return '<tr><td>' + esc(o.name) + '</td><td>' + esc(o.title || '') + '</td><td>' + esc(o.region) + '</td><td>' + dayShort(o.added_at) + '</td><td><button class="btn small" data-rm="' + esc(o.user_id) + '">Remove</button></td></tr>';
        }).join('') + '</tbody></table></div>' : '<p class="note">Nobody yet.</p>', 'wide');
      bindNav();
      on('#af', 'submit', function (ev) {
        ev.preventDefault();
        var reg = $('#ar2').value;
        rpc('monitor_add_official', { p_identifier: $('#ai').value, p_region: reg ? Number(reg) : null, p_title: $('#at2').value })
          .then(function () { route(); }).catch(function (e) { $('#ae').textContent = e.message; });
      });
      each('[data-rm]', function (b) { b.onclick = function () { b.disabled = true; rpc('monitor_remove_official', { p_user: b.getAttribute('data-rm') }).then(function () { route(); }); }; });
      document.title = 'Officials · K12Plus Monitor';
    });
  }

  function noAccess() {
    app.innerHTML = '<div class="card empty"><b>There is nothing to show for this account yet</b>Learners see their own progress, teachers see the K12Plus classes they teach, principals see their school, and ministry and regional officials see their region or the country once K-Twelve Educational Technologies has given them access. If you think you should see something, write to <a href="mailto:paulus@k12plus.app">paulus@k12plus.app</a>.</div>';
  }

  // ---------- routing ----------
  function route() {
    C.hideTip();
    if (!readSession()) { showSignIn(); return Promise.resolve(); }
    var go = function () {
      header();
      var h = location.hash.replace(/^#/, ''), parts = h.split('/');
      var views = me.views || [];
      if (!h) {
        if (!views.length) { if ((me.manage || []).length) { location.replace('#accounts'); return; } if (me.admin) { location.replace('#officials'); return; } noAccess(); return; }
        location.replace(viewHash(views.filter(function (v) { return v.kind !== 'learner'; })[0] || views[0])); return;
      }
      if (!app.querySelector('.head')) app.innerHTML = topNav('#' + h) + '<div class="loading">Loading…</div>';
      app.classList.add('busy');
      var p = parts[0] === 'me' ? showLearner(null)
        : parts[0] === 'learner' ? showLearner(parts[1])
        : parts[0] === 'class' ? showClass(parts[1])
        : parts[0] === 'school' ? showSchool(parts[1])
        : parts[0] === 'region' ? showRegion(parts[1])
        : parts[0] === 'country' ? showCountry()
        : parts[0] === 'accounts' ? showAccounts(parts[1], parts[2])
        : parts[0] === 'officials' && me.admin ? showOfficials()
        : parts[0] === 'funds' && me.funds ? showFunds()
        : Promise.resolve(noAccess());
      return p.catch(function (e) {
        if (e.signedOut) { showSignIn('Please sign in again.'); return; }
        app.innerHTML = topNav('') + '<div class="card empty"><b>This could not be opened</b>' + esc(navigator.onLine ? e.message : 'You are offline. Connect to the internet and try again.') + '<br><br><a class="btn" href="#">Back to the start</a></div>';
        bindNav();
      }).finally(function () { app.classList.remove('busy'); window.scrollTo && h !== (route._last || h) && window.scrollTo(0, 0); route._last = h; });
    };
    if (me) return Promise.resolve(go());
    return rpc('monitor_whoami').then(function (w) {
      if (!w || !w.signed_in) { clearSession(); showSignIn(); return; }
      me = w; return go();
    }).catch(function (e) {
      if (e.signedOut) { showSignIn(); return; }
      app.innerHTML = '<div class="card empty"><b>K12Plus Monitor could not load</b>' + esc(navigator.onLine ? e.message : 'You are offline. Connect to the internet and try again.') + '</div>';
    });
  }

  window.addEventListener('hashchange', route);
  route();
})();

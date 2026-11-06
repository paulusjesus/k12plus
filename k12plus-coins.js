/**
 * K12Plus coins and the Game Center.
 *
 * Learners earn coins by learning: practice games and surprise challenges (10 to 60 coins
 * a correct answer), quizzes (once a day for each subject) and finished pilot tests.
 * They spend coins in the Game Center on reward games. Practice itself is never locked.
 *
 * Coins are kept on the phone, one purse per account, so they work offline and on shared
 * phones each learner keeps their own. Nothing about coins is sent to the server.
 *
 *   window.k12coins.balance()                 coins in this learner's purse
 *   window.k12coins.earn(amount, why, once)   add coins; "once" stops the same reward twice
 *   window.k12coins.spend(amount, why)        take coins, or return false if there are too few
 *   window.k12gameCenter.open(ways)           show the Game Center; ways = { quiz, practice, test }
 */
(function () {
  'use strict';

  // ---------- the purse ----------
  var DAILY_PRACTICE_CAP = 300; // coins a day from practice answers, so quizzes and tests still matter

  function who() {
    try { var s = JSON.parse(localStorage.getItem('k12plus-session') || 'null'); return (s && s.user_id) || 'guest'; } catch (e) { return 'guest'; }
  }
  function key() { return 'k12plus-coins:' + who(); }
  function today() { var d = new Date(Date.now() + 2 * 3600e3); return d.toISOString().slice(0, 10); } // Namibian date
  function read() {
    var p = null;
    try { p = JSON.parse(localStorage.getItem(key()) || 'null'); } catch (e) {}
    if (!p) {
      // the first time: points earned before coins existed become coins
      var old = 0;
      try { if (!localStorage.getItem('k12plus-points-moved')) { old = parseInt(localStorage.getItem('k12plus-points') || '0', 10) || 0; localStorage.setItem('k12plus-points-moved', '1'); } } catch (e) {}
      p = { coins: old, once: {}, day: today(), practiceToday: 0, log: [] };
      try { localStorage.setItem(key(), JSON.stringify(p)); } catch (e) {}
    }
    if (p.day !== today()) { p.day = today(); p.practiceToday = 0; }
    return p;
  }
  function write(p) {
    try { localStorage.setItem(key(), JSON.stringify(p)); } catch (e) {}
    try { window.dispatchEvent(new CustomEvent('k12coins', { detail: { coins: p.coins } })); } catch (e) {}
  }

  window.k12coins = {
    balance: function () { return read().coins; },
    // returns the coins actually added (0 when already rewarded, or the daily practice limit is reached)
    earn: function (amount, why, once) {
      var p = read();
      amount = Math.max(0, Math.round(amount || 0));
      if (!amount) return 0;
      if (once) { if (p.once[once]) return 0; p.once[once] = 1; }
      if (why === 'practice') {
        amount = Math.min(amount, Math.max(0, DAILY_PRACTICE_CAP - p.practiceToday));
        p.practiceToday += amount;
        if (!amount) { write(p); return 0; }
      }
      p.coins += amount;
      p.log = [{ at: Date.now(), n: amount, why: why || '' }].concat(p.log || []).slice(0, 30);
      write(p);
      return amount;
    },
    spend: function (amount, why) {
      var p = read();
      if (p.coins < amount) return false;
      p.coins -= amount;
      p.log = [{ at: Date.now(), n: -amount, why: why || '' }].concat(p.log || []).slice(0, 30);
      write(p);
      return true;
    },
    practiceLeftToday: function () { var p = read(); return Math.max(0, DAILY_PRACTICE_CAP - p.practiceToday); },
    history: function () { return read().log || []; }
  };

  // ---------- the Game Center ----------
  var GAMES = [
    { id: 'match', name: 'Match Up', cost: 30, icon: '🧩', about: 'Turn over the cards and pair each fraction with its decimal or percentage. Fewer turns, better score.' },
    { id: 'sprint', name: 'Number Sprint', cost: 20, icon: '⚡', about: 'Sixty seconds of quick sums. How many can you get right before the clock runs out?' },
    { id: 'scramble', name: 'Science Scramble', cost: 25, icon: '🔬', about: 'Unscramble science and maths words from your syllabus, with a clue for each one.' }
  ];

  var root = null, ways = {};
  function el(html) { var d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function best(id) { try { return parseInt(localStorage.getItem('k12plus-best:' + id + ':' + who()) || '0', 10) || 0; } catch (e) { return 0; } }
  function setBest(id, v) { if (v > best(id)) try { localStorage.setItem('k12plus-best:' + id + ':' + who(), String(v)); } catch (e) {} }

  var CSS = '' +
    '.k12gc{position:fixed;inset:0;z-index:99990;background:rgba(20,20,35,.55);display:flex;align-items:center;justify-content:center;padding:12px;font-family:Poppins,system-ui,sans-serif;color:#1F2033}' +
    '.k12gc-box{background:#FCFBF8;border-radius:20px;width:100%;max-width:720px;max-height:calc(100vh - 24px);overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)}' +
    '.k12gc-head{display:flex;align-items:center;gap:10px;padding:16px 18px;border-bottom:1px solid #E9E6F2;position:sticky;top:0;background:#FCFBF8;z-index:1}' +
    '.k12gc-head h2{margin:0;font-size:19px}' +
    '.k12gc-coins{margin-left:auto;background:#FFF6DC;border:1px solid #F2E2AE;color:#7A5B00;border-radius:999px;padding:6px 14px;font-weight:700;font-size:14px;white-space:nowrap}' +
    '.k12gc-x{border:0;background:none;font-size:20px;cursor:pointer;color:#6B6E85;padding:4px 8px}' +
    '.k12gc-body{padding:16px 18px 20px}' +
    '.k12gc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}' +
    '.k12gc-card{background:#fff;border:1px solid #E9E6F2;border-radius:16px;padding:14px;display:flex;flex-direction:column;gap:6px}' +
    '.k12gc-card b{font-size:16px}.k12gc-card p{margin:0;font-size:13px;color:#5E6178;flex:1}' +
    '.k12gc-btn{border:0;border-radius:11px;padding:10px 14px;font-size:14px;font-weight:600;cursor:pointer;background:#7C3AED;color:#fff;font-family:inherit}' +
    '.k12gc-btn.light{background:#fff;color:#1F2033;border:1px solid #E9E6F2}' +
    '.k12gc-btn:disabled{opacity:.5;cursor:default}' +
    '.k12gc-ways{display:grid;gap:8px;margin-top:10px}' +
    '.k12gc-way{display:flex;align-items:center;gap:10px;background:#fff;border:1px solid #E9E6F2;border-radius:12px;padding:10px 12px;font-size:14px}' +
    '.k12gc-way span{flex:1}.k12gc-note{font-size:13px;color:#5E6178}' +
    '.k12gc-warn{background:#FFF6DC;border:1px solid #F2E2AE;border-radius:14px;padding:14px;margin-bottom:12px}' +
    '.k12gc-cards{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:12px 0}' +
    '.k12gc-tile{aspect-ratio:1;border-radius:12px;border:0;background:#7C3AED;color:#fff;font-size:17px;font-weight:700;cursor:pointer;font-family:inherit}' +
    '.k12gc-tile.open{background:#fff;color:#1F2033;border:2px solid #7C3AED}.k12gc-tile.done{background:#E3F5EC;color:#14855B;border:2px solid #14855B;cursor:default}' +
    '.k12gc-q{font-size:30px;font-weight:700;text-align:center;margin:18px 0 10px}' +
    '.k12gc-in{width:100%;box-sizing:border-box;font-size:22px;text-align:center;padding:12px;border:2px solid #E9E6F2;border-radius:12px;font-family:inherit}' +
    '.k12gc-bar{height:8px;background:#F5F3FB;border-radius:4px;overflow:hidden;margin:6px 0 4px}.k12gc-bar i{display:block;height:100%;background:#7C3AED}' +
    '@media (max-width:480px){.k12gc-cards{grid-template-columns:repeat(3,1fr)}}';

  function close() {
    if (root) { root.remove(); root = null; }
    document.removeEventListener('keydown', onKey);
    try { window.dispatchEvent(new CustomEvent('k12gamecenter', { detail: { closed: true } })); } catch (e) {}
  }
  function onKey(e) { if (e.key === 'Escape') close(); }

  function shell(title, bodyHtml, back) {
    if (!document.getElementById('k12gc-css')) { var st = document.createElement('style'); st.id = 'k12gc-css'; st.textContent = CSS; document.head.appendChild(st); }
    if (!root) {
      root = el('<div class="k12gc" role="dialog" aria-modal="true" aria-label="Game Center"></div>');
      root.addEventListener('click', function (e) { if (e.target === root) close(); });
      document.body.appendChild(root);
      document.addEventListener('keydown', onKey);
    }
    root.innerHTML = '<div class="k12gc-box"><div class="k12gc-head">' +
      (back ? '<button class="k12gc-x" data-back aria-label="Back">‹</button>' : '') +
      '<h2>' + esc(title) + '</h2><span class="k12gc-coins" data-coins>🪙 ' + window.k12coins.balance() + ' coins</span>' +
      '<button class="k12gc-x" data-close aria-label="Close">✕</button></div><div class="k12gc-body">' + bodyHtml + '</div></div>';
    root.querySelector('[data-close]').onclick = close;
    if (back) root.querySelector('[data-back]').onclick = inline ? close : home;
    return root.querySelector('.k12gc-body');
  }

  function waysHtml() {
    var list = [];
    if (ways.quiz) list.push(['quiz', '📝', 'Take a quiz', 'up to 35 coins, once a day for each subject']);
    if (ways.practice) list.push(['practice', '🎮', 'Answer practice questions', '10 to 30 coins for each right answer']);
    if (ways.test) list.push(['test', '📋', 'Finish your pilot test', '50 coins']);
    if (ways.ask) list.push(['ask', '💡', 'Ask your agent, then answer the surprise challenge', 'double coins']);
    return '<div class="k12gc-ways">' + list.map(function (w) {
      return '<div class="k12gc-way"><span style="font-size:20px">' + w[1] + '</span><span><b>' + w[2] + '</b><br><span class="k12gc-note">' + w[3] + '</span></span>' +
        '<button class="k12gc-btn light" data-way="' + w[0] + '">Go</button></div>';
    }).join('') + '</div>';
  }
  function bindWays(body) {
    Array.prototype.forEach.call(body.querySelectorAll('[data-way]'), function (b) {
      b.onclick = function () { var fn = ways[b.getAttribute('data-way')]; close(); if (fn) fn(); };
    });
  }

  function home() {
    var body = shell('Game Center',
      '<p class="k12gc-note" style="margin:0 0 12px">Earn coins by learning, then spend them here. The practice games in the Game Center are always free.</p>' +
      '<div class="k12gc-grid">' + GAMES.map(function (g) {
        var b = best(g.id);
        return '<div class="k12gc-card"><div style="font-size:30px">' + g.icon + '</div><b>' + esc(g.name) + '</b><p>' + esc(g.about) + '</p>' +
          (b ? '<div class="k12gc-note">Your best: ' + b + '</div>' : '') +
          '<button class="k12gc-btn" data-play="' + g.id + '">Play for ' + g.cost + ' coins</button></div>';
      }).join('') + '</div>' +
      '<h3 style="font-size:16px;margin:20px 0 4px">Ways to earn coins</h3>' + waysHtml());
    Array.prototype.forEach.call(body.querySelectorAll('[data-play]'), function (b) { b.onclick = function () { tryPlay(b.getAttribute('data-play')); }; });
    bindWays(body);
  }

  function tryPlay(id) {
    var g = GAMES.filter(function (x) { return x.id === id; })[0];
    var have = window.k12coins.balance();
    if (have < g.cost) {
      var body = shell(g.name, '<div class="k12gc-warn" data-short><b>You do not have enough coins to play this game.</b><br>' +
        g.name + ' costs ' + g.cost + ' coins and you have ' + have + '. You need ' + (g.cost - have) + ' more. Complete one of these to earn them, then come back:</div>' + waysHtml(), true);
      bindWays(body);
      return;
    }
    window.k12coins.spend(g.cost, g.name);
    ({ match: playMatch, sprint: playSprint, scramble: playScramble })[id](g);
  }

  function finish(g, score, line) {
    var was = best(g.id);
    setBest(g.id, score);
    var body = shell(g.name, '<div style="text-align:center;padding:16px 0"><div style="font-size:44px">' + (score > was ? '🏆' : '🎉') + '</div>' +
      '<h3 style="margin:8px 0">' + esc(line) + '</h3>' + (score > was ? '<p class="k12gc-note">A new personal best!</p>' : '<p class="k12gc-note">Your best is ' + Math.max(was, score) + '.</p>') +
      '<div style="display:flex;gap:8px;justify-content:center;margin-top:14px"><button class="k12gc-btn" data-again>Play again (' + g.cost + ' coins)</button><button class="k12gc-btn light" data-home>' + (inline ? 'Back to the Game Center' : 'All games') + '</button></div></div>', true);
    body.querySelector('[data-again]').onclick = function () { tryPlay(g.id); };
    body.querySelector('[data-home]').onclick = inline ? close : home;
  }

  function shuffle(a) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }

  // Match Up: six pairs of equal values
  function playMatch(g) {
    var bank = [['½', '0.5'], ['¼', '25%'], ['¾', '0.75'], ['⅕', '20%'], ['⅒', '0.1'], ['⅓', '33⅓%'], ['⅖', '0.4'], ['⅛', '12.5%'], ['3⁄5', '60%']];
    var pairs = shuffle(bank.slice()).slice(0, 6), cards = [];
    pairs.forEach(function (p, i) { cards.push({ t: p[0], k: i }, { t: p[1], k: i }); });
    shuffle(cards);
    var open = [], done = 0, turns = 0, lock = false;
    var body = shell(g.name, '<p class="k12gc-note" style="margin:0">Find the pairs that are worth the same.</p><div class="k12gc-cards" data-cards></div><p class="k12gc-note" data-turns>Turns: 0</p>', true);
    var box = body.querySelector('[data-cards]');
    cards.forEach(function (c, i) {
      var b = el('<button class="k12gc-tile" aria-label="Card ' + (i + 1) + '">?</button>');
      b.onclick = function () {
        if (lock || c.open || c.done) return;
        c.open = true; b.textContent = c.t; b.classList.add('open'); open.push([c, b]);
        if (open.length < 2) return;
        turns++; body.querySelector('[data-turns]').textContent = 'Turns: ' + turns;
        var a = open[0], z = open[1]; open = [];
        if (a[0].k === z[0].k) {
          a[0].done = z[0].done = true; a[1].classList.add('done'); z[1].classList.add('done'); done++;
          if (done === pairs.length) setTimeout(function () { finish(g, Math.max(10, 100 - (turns - 6) * 8), 'All pairs in ' + turns + ' turns'); }, 500);
        } else {
          lock = true;
          setTimeout(function () { [a, z].forEach(function (x) { x[0].open = false; x[1].textContent = '?'; x[1].classList.remove('open'); }); lock = false; }, 800);
        }
      };
      box.appendChild(b);
    });
  }

  // Number Sprint: 60 seconds of mental arithmetic
  function playSprint(g) {
    var left = 60, right = 0, q = null, timer = null;
    function next() {
      var kind = Math.floor(Math.random() * 4), a, b;
      if (kind === 0) { a = 12 + Math.floor(Math.random() * 88); b = 5 + Math.floor(Math.random() * 45); q = { t: a + ' + ' + b, a: a + b }; }
      else if (kind === 1) { a = 40 + Math.floor(Math.random() * 60); b = 3 + Math.floor(Math.random() * 37); q = { t: a + ' − ' + b, a: a - b }; }
      else if (kind === 2) { a = 2 + Math.floor(Math.random() * 11); b = 2 + Math.floor(Math.random() * 11); q = { t: a + ' × ' + b, a: a * b }; }
      else { b = 2 + Math.floor(Math.random() * 10); a = b * (2 + Math.floor(Math.random() * 10)); q = { t: a + ' ÷ ' + b, a: a / b }; }
      body.querySelector('[data-q]').textContent = q.t + ' =';
      var inp = body.querySelector('[data-in]'); inp.value = ''; inp.focus();
    }
    var body = shell(g.name, '<div class="k12gc-bar"><i data-bar style="width:100%"></i></div><div class="k12gc-note"><span data-left>60</span> seconds · <span data-right>0</span> right</div>' +
      '<div class="k12gc-q" data-q></div><input class="k12gc-in" data-in inputmode="numeric" autocomplete="off" aria-label="Your answer"><p class="k12gc-note" style="text-align:center">Press Enter after each answer.</p>', true);
    body.querySelector('[data-in]').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      if (Number(e.target.value.trim()) === q.a) { right++; body.querySelector('[data-right]').textContent = right; }
      next();
    });
    next();
    timer = setInterval(function () {
      if (!root || !root.contains(body)) { clearInterval(timer); return; }
      left--; body.querySelector('[data-left]').textContent = left; body.querySelector('[data-bar]').style.width = (left / 60 * 100) + '%';
      if (left <= 0) { clearInterval(timer); finish(g, right, right + ' right in 60 seconds'); }
    }, 1000);
  }

  // Science Scramble: unscramble syllabus words
  function playScramble(g) {
    var words = shuffle([
      ['ENERGY', 'It cannot be created or destroyed'], ['VECTOR', 'Has size and direction'], ['ENZYME', 'A protein that speeds up reactions'],
      ['PARABOLA', 'The shape of a ball\'s flight'], ['OSMOSIS', 'Water moving through a membrane'], ['GRADIENT', 'The steepness of a line'],
      ['MOLECULE', 'Two or more atoms bonded together'], ['FRICTION', 'The force that slows a sliding box'], ['FUNCTION', 'Each input has exactly one output'],
      ['PHOTOSYNTHESIS', 'How plants make food from light']
    ]).slice(0, 5);
    var i = 0, right = 0;
    var body = shell(g.name, '<div class="k12gc-note" data-count></div><div class="k12gc-q" data-q style="letter-spacing:4px"></div><p class="k12gc-note" style="text-align:center" data-clue></p>' +
      '<input class="k12gc-in" data-in autocomplete="off" aria-label="Your word"><div style="display:flex;gap:8px;margin-top:10px"><button class="k12gc-btn" data-ok style="flex:1">Check</button><button class="k12gc-btn light" data-skip>Skip</button></div><p data-msg class="k12gc-note" style="text-align:center;min-height:20px"></p>', true);
    function show() {
      if (i >= words.length) return finish(g, right * 20, right + ' of ' + words.length + ' words');
      var w = words[i][0], mixed = w;
      while (mixed === w) mixed = shuffle(w.split('')).join('');
      body.querySelector('[data-count]').textContent = 'Word ' + (i + 1) + ' of ' + words.length;
      body.querySelector('[data-q]').textContent = mixed;
      body.querySelector('[data-clue]').textContent = 'Clue: ' + words[i][1];
      var inp = body.querySelector('[data-in]'); inp.value = ''; inp.focus();
    }
    function check(skip) {
      var ok = !skip && body.querySelector('[data-in]').value.trim().toUpperCase() === words[i][0];
      if (ok) right++;
      body.querySelector('[data-msg]').textContent = ok ? 'Correct!' : 'It was ' + words[i][0] + '.';
      i++; setTimeout(show, ok ? 500 : 1200);
    }
    body.querySelector('[data-ok]').onclick = function () { check(false); };
    body.querySelector('[data-skip]').onclick = function () { check(true); };
    body.querySelector('[data-in]').addEventListener('keydown', function (e) { if (e.key === 'Enter') check(false); });
    show();
  }

  window.addEventListener('k12coins', function (e) { if (root) { var c = root.querySelector('[data-coins]'); if (c) c.textContent = '🪙 ' + e.detail.coins + ' coins'; } });
  // inline: the game list lives on the app's Game Center page, so the pop-up is only for playing
  var inline = false;
  window.k12gameCenter = {
    open: function (w) { inline = false; ways = w || {}; home(); },
    play: function (id, w) { inline = true; ways = w || {}; tryPlay(id); },
    best: function (id) { return best(id); },
    close: close, games: GAMES
  };
})();

/* K12Plus Monitor charts.
 * Small SVG charts drawn by hand, so the page stays light on mobile data.
 * Every chart has a hover (or tap) tooltip, and every figure in a chart is also
 * in a table or the CSV, so nothing depends on colour alone.
 *
 *   K12Charts.line(el, opts)      change over time (one or two series, one axis)
 *   K12Charts.columns(el, opts)   amounts per period or per group
 *   K12Charts.bars(el, opts)      horizontal bars for comparing named groups; rows can link
 *   K12Charts.parts(el, opts)     one whole split into parts, with a legend
 *   K12Charts.meter(el, opts)     one share of a whole
 */
(function () {
  'use strict';

  var tip = null;
  function tooltip() {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.className = 'kc-tip';
    tip.setAttribute('role', 'status');
    document.body.appendChild(tip);
    return tip;
  }
  function showTip(html, x, y) {
    var t = tooltip();
    t.innerHTML = html;
    t.style.display = 'block';
    var w = t.offsetWidth, h = t.offsetHeight;
    var left = Math.min(Math.max(8, x - w / 2), window.innerWidth - w - 8);
    var top = y - h - 12 < 8 ? y + 16 : y - h - 12;
    t.style.left = left + window.scrollX + 'px';
    t.style.top = top + window.scrollY + 'px';
  }
  function hideTip() { if (tip) tip.style.display = 'none'; }
  document.addEventListener('scroll', hideTip, { passive: true });

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmt(n) { return n == null ? 'none' : Number(n).toLocaleString('en-GB'); }
  function svgEl(w, h, label) { return '<svg viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + esc(label) + '" preserveAspectRatio="xMidYMid meet">'; }
  function narrow(el) { return (el.clientWidth || window.innerWidth) < 520; }

  // A rounded "nice" maximum for the axis, so gridlines land on tidy numbers.
  function niceMax(v) {
    if (!v || v <= 0) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(v))), m = v / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
  }

  // Only some labels on a crowded axis: the first, the last and evenly spaced ones between.
  function labelEvery(n, room) { return Math.max(1, Math.ceil(n / room)); }

  function bindHover(el, sel, html) {
    Array.prototype.forEach.call(el.querySelectorAll(sel), function (node) {
      var i = Number(node.getAttribute('data-i'));
      function on(ev) {
        var p = ev.touches ? ev.touches[0] : ev;
        node.classList.add('on');
        showTip(html(i), p.clientX, p.clientY);
      }
      node.addEventListener('mousemove', on);
      node.addEventListener('touchstart', on, { passive: true });
      node.addEventListener('mouseleave', function () { node.classList.remove('on'); hideTip(); });
    });
  }

  /* Line chart. opts: { labels: [..], series: [{ name, values, cls }], unit, max, label } */
  function line(el, opts) {
    var small = narrow(el);
    var W = small ? 360 : 640, H = small ? 210 : 220, L = 40, R = 14, T = 14, B = 28;
    var iw = W - L - R, ih = H - T - B, n = opts.labels.length;
    var all = [];
    opts.series.forEach(function (s) { s.values.forEach(function (v) { if (v != null) all.push(v); }); });
    var max = opts.max || niceMax(Math.max.apply(null, all.concat([0])));
    var x = function (i) { return L + (n < 2 ? iw / 2 : iw * i / (n - 1)); };
    var y = function (v) { return T + ih - ih * v / max; };
    var s = svgEl(W, H, opts.label || 'Line chart');
    [0, 0.5, 1].forEach(function (g) {
      var yy = T + ih - ih * g;
      s += '<line class="kc-grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + yy + '" y2="' + yy + '"/>' +
           '<text class="kc-axis" x="' + (L - 6) + '" y="' + (yy + 4) + '" text-anchor="end">' + fmt(Math.round(max * g * 10) / 10) + (opts.unit || '') + '</text>';
    });
    var every = labelEvery(n, small ? 4 : 7);
    opts.labels.forEach(function (lb, i) {
      if (i % every === 0 || i === n - 1) s += '<text class="kc-axis" x="' + x(i) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(lb) + '</text>';
    });
    opts.series.forEach(function (ser, k) {
      var pts = [], path = '';
      ser.values.forEach(function (v, i) {
        if (v == null) { path += ' '; return; }
        pts.push([x(i), y(v)]);
        path += (path.trim() === '' || ser.values[i - 1] == null ? 'M' : 'L') + x(i).toFixed(1) + ',' + y(v).toFixed(1) + ' ';
      });
      s += '<path class="kc-line ' + (ser.cls || 's' + (k + 1)) + '" d="' + path.trim() + '"/>';
      if (pts.length <= 31) pts.forEach(function (p) { s += '<circle class="kc-dot ' + (ser.cls || 's' + (k + 1)) + '" cx="' + p[0] + '" cy="' + p[1] + '" r="3.5"/>'; });
    });
    // invisible columns for the crosshair and tooltip
    for (var i = 0; i < n; i++) {
      var cx = x(i), half = n < 2 ? iw / 2 : iw / (n - 1) / 2;
      s += '<g class="kc-hit" data-i="' + i + '"><rect x="' + (cx - half) + '" y="' + T + '" width="' + half * 2 + '" height="' + ih + '" fill="transparent"/>' +
           '<line class="kc-cross" x1="' + cx + '" x2="' + cx + '" y1="' + T + '" y2="' + (T + ih) + '"/></g>';
    }
    s += '</svg>';
    var legend = opts.series.length > 1 ? '<div class="kc-legend">' + opts.series.map(function (ser, k) {
      return '<span><i class="kc-key ' + (ser.cls || 's' + (k + 1)) + '"></i>' + esc(ser.name) + '</span>';
    }).join('') + '</div>' : '';
    el.innerHTML = s + legend;
    bindHover(el, '.kc-hit', function (i) {
      return '<b>' + esc(opts.tipLabels ? opts.tipLabels[i] : opts.labels[i]) + '</b>' + opts.series.map(function (ser) {
        var v = ser.values[i];
        return '<div>' + esc(ser.name) + ': ' + (v == null ? 'no data' : fmt(v) + (opts.unit || '')) + '</div>';
      }).join('');
    });
  }

  /* Column chart. opts: { labels, values, name, unit, cls, onClick(i) } */
  function columns(el, opts) {
    var small = narrow(el);
    var W = small ? 360 : 640, H = small ? 210 : 220, L = 40, R = 10, T = 14, B = 28;
    var iw = W - L - R, ih = H - T - B, n = opts.values.length;
    var max = niceMax(Math.max.apply(null, opts.values.map(function (v) { return v || 0; }).concat([0])));
    var step = iw / Math.max(n, 1), bw = Math.max(3, Math.min(42, step - 2));
    var s = svgEl(W, H, opts.label || opts.name || 'Column chart');
    [0, 0.5, 1].forEach(function (g) {
      var yy = T + ih - ih * g;
      s += '<line class="kc-grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + yy + '" y2="' + yy + '"/>' +
           '<text class="kc-axis" x="' + (L - 6) + '" y="' + (yy + 4) + '" text-anchor="end">' + fmt(Math.round(max * g * 10) / 10) + '</text>';
    });
    var every = labelEvery(n, small ? 5 : 10);
    opts.values.forEach(function (v, i) {
      var cx = L + step * i + step / 2, h = ih * (v || 0) / max, top = T + ih - h, r = Math.min(4, bw / 2, h);
      // a column with rounded top corners, square at the baseline
      var d = h <= 0 ? '' : 'M' + (cx - bw / 2) + ',' + (T + ih) + 'V' + (top + r) + 'Q' + (cx - bw / 2) + ',' + top + ' ' + (cx - bw / 2 + r) + ',' + top +
              'H' + (cx + bw / 2 - r) + 'Q' + (cx + bw / 2) + ',' + top + ' ' + (cx + bw / 2) + ',' + (top + r) + 'V' + (T + ih) + 'Z';
      s += '<g class="kc-hit' + (opts.onClick ? ' kc-link' : '') + '" data-i="' + i + '"><rect x="' + (cx - step / 2) + '" y="' + T + '" width="' + step + '" height="' + ih + '" fill="transparent"/>' +
           (d ? '<path class="kc-col ' + (opts.cls || 's1') + '" d="' + d + '"/>' : '') + '</g>';
      if (i % every === 0 || i === n - 1) s += '<text class="kc-axis" x="' + cx + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(opts.labels[i]) + '</text>';
    });
    s += '</svg>';
    el.innerHTML = s;
    bindHover(el, '.kc-hit', function (i) {
      return '<b>' + esc(opts.tipLabels ? opts.tipLabels[i] : opts.labels[i]) + '</b><div>' + esc(opts.name) + ': ' + fmt(opts.values[i]) + (opts.unit || '') + '</div>';
    });
    if (opts.onClick) Array.prototype.forEach.call(el.querySelectorAll('.kc-hit'), function (g) {
      g.addEventListener('click', function () { hideTip(); opts.onClick(Number(g.getAttribute('data-i'))); });
    });
  }

  /* Horizontal bars. opts: { rows: [{ label, value, note, href, hidden }], unit, max, cls, empty } */
  function bars(el, opts) {
    var rows = opts.rows;
    if (!rows.length) { el.innerHTML = '<p class="note">' + esc(opts.empty || 'Nothing to show yet.') + '</p>'; return; }
    var max = opts.max || Math.max.apply(null, rows.map(function (r) { return r.value || 0; }).concat([1]));
    el.innerHTML = '<div class="kc-bars">' + rows.map(function (r, i) {
      var w = r.hidden ? 0 : Math.max(r.value ? 1.5 : 0, 100 * (r.value || 0) / max);
      var tag = r.href ? 'a href="' + esc(r.href) + '"' : 'div';
      return '<' + tag + ' class="kc-bar' + (r.href ? ' kc-link' : '') + '" data-i="' + i + '">' +
        '<span class="kc-bar-label">' + esc(r.label) + (r.note ? ' <span class="note">' + esc(r.note) + '</span>' : '') + '</span>' +
        '<span class="kc-bar-track"><span class="kc-bar-fill ' + (r.cls || opts.cls || 's1') + '" style="width:' + w + '%"></span></span>' +
        '<span class="kc-bar-value">' + (r.hidden ? '<span class="note">' + esc(r.hidden) + '</span>' : fmt(r.value) + (opts.unit || '')) + '</span>' +
        '</' + (r.href ? 'a' : 'div') + '>';
    }).join('') + '</div>';
  }

  /* One whole in parts. opts: { parts: [{ label, value }], total } */
  function parts(el, opts) {
    var total = opts.total || opts.parts.reduce(function (a, p) { return a + (p.value || 0); }, 0);
    if (!total) { el.innerHTML = '<p class="note">' + esc(opts.empty || 'Nothing to show yet.') + '</p>'; return; }
    var seg = opts.parts.filter(function (p) { return p.value > 0; });
    el.innerHTML = '<div class="kc-parts" role="img" aria-label="' + esc(opts.label || 'Parts of a whole') + '">' + seg.map(function (p) {
      var k = opts.parts.indexOf(p);
      return '<span class="kc-part s' + (k + 1) + '" data-i="' + k + '" style="flex:' + p.value + '"></span>';
    }).join('') + '</div><div class="kc-legend">' + opts.parts.map(function (p, k) {
      return '<span><i class="kc-key s' + (k + 1) + '"></i>' + esc(p.label) + ' <b>' + fmt(p.value) + '</b> <span class="note">(' + Math.round(100 * (p.value || 0) / total) + '%)</span></span>';
    }).join('') + '</div>';
    bindHover(el, '.kc-part', function (i) {
      var p = opts.parts[i];
      return '<b>' + esc(p.label) + '</b><div>' + fmt(p.value) + ' of ' + fmt(total) + ' (' + Math.round(100 * p.value / total) + '%)</div>';
    });
  }

  /* A meter: one share of a whole. opts: { value, max, label, note } */
  function meter(el, opts) {
    var pct = opts.max ? Math.round(100 * opts.value / opts.max) : 0;
    el.innerHTML = '<div class="kc-meter-head"><span>' + esc(opts.label) + '</span><b>' + pct + '%</b></div>' +
      '<div class="kc-meter" role="meter" aria-valuemin="0" aria-valuemax="' + opts.max + '" aria-valuenow="' + opts.value + '" aria-label="' + esc(opts.label) + '">' +
      '<span style="width:' + pct + '%"></span></div><div class="note">' + esc(opts.note || (fmt(opts.value) + ' of ' + fmt(opts.max))) + '</div>';
  }

  window.K12Charts = { line: line, columns: columns, bars: bars, parts: parts, meter: meter, hideTip: hideTip };
})();

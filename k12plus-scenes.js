/**
 * K12Plus Scenes - animated canvas graphics for games and real-world stories.
 * Each syllabus topic maps to an animated scene with an equation chip and caption bar.
 * Pure canvas 2D, loops forever, no dependencies, works offline.
 */
(function () {
  var W = 640, H = 240, CAP = 30;

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function chip(ctx, text, x, y) {
    ctx.font = '600 15px Georgia, serif';
    var w = ctx.measureText(text).width + 22;
    ctx.fillStyle = 'rgba(31,32,51,.82)';
    roundRect(ctx, x - w, y, w, 28, 8);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.fillText(text, x - w + 11, y + 19);
  }

  function caption(ctx, text, tt) {
    ctx.fillStyle = 'rgba(31,32,51,.85)';
    ctx.fillRect(0, H - CAP, W, CAP);
    ctx.fillStyle = '#fff';
    ctx.font = '600 12px Poppins, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(text, W - 14, H - CAP + 19);
    ctx.fillStyle = 'rgba(255,255,255,.25)';
    roundRect(ctx, 34, H - CAP + 12, 300, 5, 3);
    ctx.fill();
    ctx.fillStyle = '#FFC324';
    roundRect(ctx, 34, H - CAP + 12, Math.max(6, 300 * tt), 5, 3);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(16, H - CAP + 9);
    ctx.lineTo(16, H - CAP + 21);
    ctx.lineTo(27, H - CAP + 15);
    ctx.closePath();
    ctx.fill();
    ctx.textAlign = 'left';
  }

  function label(ctx, text, x, y) {
    ctx.font = '600 12.5px Poppins, sans-serif';
    var w = ctx.measureText(text).width + 20;
    ctx.fillStyle = 'rgba(255,255,255,.94)';
    roundRect(ctx, x, y, w, 24, 7);
    ctx.fill();
    ctx.strokeStyle = 'rgba(31,32,51,.12)';
    ctx.stroke();
    ctx.fillStyle = '#1F2033';
    ctx.fillText(text, x + 10, y + 16.5);
  }

  function sky(ctx) {
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#9DC3EE');
    g.addColorStop(1, '#DDEBFA');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#D9C08A';
    ctx.fillRect(0, H - 66, W, 66 - CAP + 36);
  }

  function plain(ctx, top, bottom) {
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  var SCENES = {

    projectile: function (ctx, tt, p) {
      sky(ctx);
      // hoop pole
      ctx.strokeStyle = '#5A5D75';
      ctx.lineWidth = 6;
      ctx.beginPath(); ctx.moveTo(560, 174); ctx.lineTo(560, 70); ctx.stroke();
      ctx.strokeStyle = '#E0432F';
      ctx.lineWidth = 5;
      ctx.beginPath(); ctx.ellipse(560, 62, 26, 9, 0, 0, Math.PI * 2); ctx.stroke();
      // trajectory: from (60,174) apex (310,50) to (560,62)
      var f = Math.min(1, tt * 1.25);
      ctx.setLineDash([3, 7]);
      ctx.strokeStyle = 'rgba(31,32,51,.35)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (var i = 0; i <= 40; i++) {
        var u = i / 40 * f;
        var x = 60 + 500 * u;
        var y = 174 - (492 * u - 468 * u * u);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      var u2 = f;
      var bx = 60 + 500 * u2, by = 174 - (492 * u2 - 468 * u2 * u2);
      var bg = ctx.createRadialGradient(bx - 3, by - 3, 2, bx, by, 12);
      bg.addColorStop(0, '#FFB25E'); bg.addColorStop(1, '#E8762A');
      ctx.fillStyle = bg;
      ctx.beginPath(); ctx.arc(bx, by, 11, 0, Math.PI * 2); ctx.fill();
      label(ctx, p.label || 'Max height 20.4 m · t = 2.0 s', 218, 34);
    },

    bars: function (ctx, tt, p) {
      plain(ctx, '#F6F5FC', '#ECEAF6');
      var vals = p.vals || [50, 100, 200, 400, 800];
      var mx = Math.max.apply(null, vals);
      var bw = 62, gap = 32, x0 = (W - vals.length * (bw + gap)) / 2 + gap / 2;
      ctx.strokeStyle = '#C9C5DC'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(40, H - 56); ctx.lineTo(W - 40, H - 56); ctx.stroke();
      for (var i = 0; i < vals.length; i++) {
        var reveal = Math.min(1, Math.max(0, tt * (vals.length + 1) - i));
        var hgt = (vals[i] / mx) * 130 * reveal;
        var x = x0 + i * (bw + gap);
        var g = ctx.createLinearGradient(0, H - 56 - hgt, 0, H - 56);
        g.addColorStop(0, '#8B5CF6'); g.addColorStop(1, '#5563E0');
        ctx.fillStyle = g;
        roundRect(ctx, x, H - 56 - hgt, bw, hgt, 6);
        ctx.fill();
        if (reveal > 0.9) {
          ctx.fillStyle = '#1F2033';
          ctx.font = '700 13px Poppins, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(String(p.prefix || '') + vals[i], x + bw / 2, H - 62 - hgt);
          ctx.textAlign = 'left';
        }
      }
    },

    linegraph: function (ctx, tt, p) {
      plain(ctx, '#F6F5FC', '#ECEAF6');
      ctx.strokeStyle = '#DBD8EA'; ctx.lineWidth = 1;
      for (var gx = 60; gx < W - 30; gx += 45) { ctx.beginPath(); ctx.moveTo(gx, 20); ctx.lineTo(gx, H - 50); ctx.stroke(); }
      for (var gy = 30; gy < H - 40; gy += 40) { ctx.beginPath(); ctx.moveTo(50, gy); ctx.lineTo(W - 30, gy); ctx.stroke(); }
      var ax = 105, ay = H - 70, bx2 = 465, by2 = 55;
      var f = Math.min(1, tt * 1.3);
      ctx.strokeStyle = '#5563E0'; ctx.lineWidth = 4; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax + (bx2 - ax) * f, ay + (by2 - ay) * f); ctx.stroke();
      ctx.fillStyle = '#7C3AED';
      ctx.beginPath(); ctx.arc(ax, ay, 7, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(ax + (bx2 - ax) * f, ay + (by2 - ay) * f, 9, 0, Math.PI * 2); ctx.fill();
      ctx.font = '15px Poppins, sans-serif';
      ctx.fillText('🚕', ax + (bx2 - ax) * f - 9, ay + (by2 - ay) * f - 14);
      label(ctx, p.a || '(0;0)', ax - 26, ay + 14);
      if (f > 0.97) label(ctx, p.b || '(3;4) · d = 5 km', bx2 - 30, by2 - 34);
    },

    wave: function (ctx, tt, p) {
      plain(ctx, '#1E2440', '#2B2B54');
      ctx.strokeStyle = '#4ADEDE'; ctx.lineWidth = 3.5; ctx.lineCap = 'round';
      ctx.beginPath();
      for (var x = 30; x < W - 30; x += 3) {
        var y = 108 + Math.sin((x / 52) - tt * Math.PI * 4) * 44;
        if (x === 30) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,.4)'; ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 5]);
      ctx.beginPath(); ctx.moveTo(30, 108); ctx.lineTo(W - 30, 108); ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = '#FFC324'; ctx.lineWidth = 2;
      var x1 = 138, x2 = 138 + 2 * Math.PI * 52;
      ctx.beginPath(); ctx.moveTo(x1, 178); ctx.lineTo(x2, 178); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x1, 172); ctx.lineTo(x1, 184); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x2, 172); ctx.lineTo(x2, 184); ctx.stroke();
      ctx.fillStyle = '#FFC324';
      ctx.font = '600 13px Poppins, sans-serif';
      ctx.fillText('λ = one wavelength', x1 + 92, 196);
    },

    circuit: function (ctx, tt, p) {
      plain(ctx, '#1E2440', '#252A4E');
      var x = 120, y = 46, w = 400, h = 130;
      ctx.strokeStyle = '#8A8DA3'; ctx.lineWidth = 4;
      roundRect(ctx, x, y, w, h, 16); ctx.stroke();
      // battery
      ctx.strokeStyle = '#FFC324'; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(x + w / 2 - 14, y + h - 12); ctx.lineTo(x + w / 2 - 14, y + h + 12); ctx.stroke();
      ctx.lineWidth = 9;
      ctx.beginPath(); ctx.moveTo(x + w / 2 + 12, y + h - 7); ctx.lineTo(x + w / 2 + 12, y + h + 7); ctx.stroke();
      // bulb
      var glow = 0.6 + 0.4 * Math.sin(tt * Math.PI * 8);
      var bg = ctx.createRadialGradient(x + w / 2, y, 3, x + w / 2, y, 30);
      bg.addColorStop(0, 'rgba(255,225,120,' + glow + ')');
      bg.addColorStop(1, 'rgba(255,225,120,0)');
      ctx.fillStyle = bg;
      ctx.beginPath(); ctx.arc(x + w / 2, y, 30, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#FFE178';
      ctx.beginPath(); ctx.arc(x + w / 2, y, 12, 0, Math.PI * 2); ctx.fill();
      // electrons
      var per = 2 * (w + h);
      ctx.fillStyle = '#4ADEDE';
      for (var i = 0; i < 14; i++) {
        var d = ((tt * per * 0.6) + i * per / 14) % per;
        var ex, ey;
        if (d < w) { ex = x + d; ey = y; }
        else if (d < w + h) { ex = x + w; ey = y + (d - w); }
        else if (d < 2 * w + h) { ex = x + w - (d - w - h); ey = y + h; }
        else { ex = x; ey = y + h - (d - 2 * w - h); }
        ctx.beginPath(); ctx.arc(ex, ey, 5, 0, Math.PI * 2); ctx.fill();
      }
    },

    particles: function (ctx, tt, p) {
      plain(ctx, '#E8F4FB', '#D6EBF7');
      ctx.strokeStyle = '#5A8DB8'; ctx.lineWidth = 5;
      ctx.setLineDash([16, 13]);
      ctx.beginPath(); ctx.moveTo(W / 2, 16); ctx.lineTo(W / 2, H - CAP - 10); ctx.stroke();
      ctx.setLineDash([]);
      var n = 26;
      for (var i = 0; i < n; i++) {
        var seed = (i * 137.5) % 1;
        var row = (i * 71) % (H - CAP - 50) + 26;
        var prog = ((tt * 0.55) + seed) % 1;
        var px;
        if (i % 3 === 0) px = 60 + prog * (W - 130); // crossing particles
        else if (i % 3 === 1) px = 50 + ((seed * 220) + Math.sin(tt * 4 + i) * 12);
        else px = W / 2 + 40 + ((seed * 200) + Math.cos(tt * 3 + i) * 10) % 200;
        ctx.fillStyle = i % 3 === 0 ? '#2E8DF6' : 'rgba(46,141,246,.5)';
        ctx.beginPath(); ctx.arc(px % (W - 20), row, 6, 0, Math.PI * 2); ctx.fill();
      }
      label(ctx, 'High concentration', 60, 22);
      label(ctx, 'Low', W - 150, 22);
    },

    leaf: function (ctx, tt, p) {
      plain(ctx, '#CBE6F5', '#E7F4EC');
      // sun
      ctx.fillStyle = '#FFC324';
      ctx.beginPath(); ctx.arc(80, 58, 26, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#FFC324'; ctx.lineWidth = 3;
      for (var i = 0; i < 8; i++) {
        var a = tt * 1.5 + i * Math.PI / 4;
        ctx.beginPath();
        ctx.moveTo(80 + Math.cos(a) * 34, 58 + Math.sin(a) * 34);
        ctx.lineTo(80 + Math.cos(a) * 44, 58 + Math.sin(a) * 44);
        ctx.stroke();
      }
      // leaf
      ctx.fillStyle = '#3BB273';
      ctx.beginPath();
      ctx.moveTo(300, 150);
      ctx.quadraticCurveTo(390, 40, 500, 92);
      ctx.quadraticCurveTo(430, 190, 300, 150);
      ctx.fill();
      ctx.strokeStyle = '#1F8A57'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(305, 149); ctx.quadraticCurveTo(400, 105, 495, 94); ctx.stroke();
      // O2 bubbles rising
      for (var b = 0; b < 5; b++) {
        var bp = ((tt * 0.4) + b * 0.2) % 1;
        var bx = 380 + b * 24, by = 90 - bp * 60;
        ctx.fillStyle = 'rgba(255,255,255,' + (1 - bp) + ')';
        ctx.beginPath(); ctx.arc(bx, by, 6 + bp * 3, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(31,32,51,' + (0.7 * (1 - bp)) + ')';
        ctx.font = '600 9px Poppins, sans-serif';
        ctx.fillText('O₂', bx - 6, by + 3);
      }
      label(ctx, 'CO₂ + H₂O in · glucose + O₂ out', 170, H - CAP - 34);
    },

    breathe: function (ctx, tt, p) {
      plain(ctx, '#FDEFF2', '#FBE4EA');
      var s = 1 + 0.12 * Math.sin(tt * Math.PI * 1.4);
      ctx.strokeStyle = '#C86A82'; ctx.lineWidth = 6; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(W / 2, 26); ctx.lineTo(W / 2, 84); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(W / 2, 84); ctx.lineTo(W / 2 - 40, 108); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(W / 2, 84); ctx.lineTo(W / 2 + 40, 108); ctx.stroke();
      var lg = ctx.createLinearGradient(0, 90, 0, 200);
      lg.addColorStop(0, '#F2A0B5'); lg.addColorStop(1, '#E2718F');
      ctx.fillStyle = lg;
      ctx.beginPath(); ctx.ellipse(W / 2 - 62 * s, 148, 52 * s, 62 * s, -0.15, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(W / 2 + 62 * s, 148, 52 * s, 62 * s, 0.15, 0, Math.PI * 2); ctx.fill();
      var breathIn = Math.sin(tt * Math.PI * 1.4) > 0;
      label(ctx, breathIn ? 'Breathe in · O₂ →' : '← CO₂ out · breathe out', W / 2 - 100, 30);
    },

    beaker: function (ctx, tt, p) {
      plain(ctx, '#F6F5FC', '#EDEBF7');
      var phase = (Math.sin(tt * 1.2) + 1) / 2; // 0 acid → 1 alkali
      var r = Math.round(224 - phase * 130), g = Math.round(60 + phase * 120), b = Math.round(60 + phase * 120);
      var x = 240, y = 46, w = 160, h = 140;
      ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
      ctx.fillRect(x + 8, y + 44, w - 16, h - 52);
      for (var i = 0; i < 4; i++) {
        var bp = ((tt * 0.5) + i * 0.25) % 1;
        ctx.fillStyle = 'rgba(255,255,255,' + (0.5 * (1 - bp)) + ')';
        ctx.beginPath(); ctx.arc(x + 34 + i * 30, y + h - 20 - bp * 70, 5, 0, Math.PI * 2); ctx.fill();
      }
      ctx.strokeStyle = '#5A5D75'; ctx.lineWidth = 5; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x, y); ctx.lineTo(x + 4, y + h - 10);
      ctx.quadraticCurveTo(x + 6, y + h, x + 18, y + h);
      ctx.lineTo(x + w - 18, y + h);
      ctx.quadraticCurveTo(x + w - 6, y + h, x + w - 4, y + h - 10);
      ctx.lineTo(x + w, y);
      ctx.stroke();
      // pH scale
      var grad = ctx.createLinearGradient(455, 0, 605, 0);
      grad.addColorStop(0, '#E03C3C'); grad.addColorStop(0.5, '#3BB273'); grad.addColorStop(1, '#6B3AC9');
      ctx.fillStyle = grad;
      roundRect(ctx, 455, 100, 150, 14, 7); ctx.fill();
      ctx.fillStyle = '#1F2033';
      ctx.beginPath(); ctx.arc(455 + phase * 150, 107, 9, 0, Math.PI * 2); ctx.stroke();
      ctx.font = '600 12px Poppins, sans-serif';
      ctx.fillText('pH 0', 455, 132); ctx.fillText('pH 14', 570, 132);
      label(ctx, 'pH ' + (14 * phase).toFixed(1), 505, 62);
    },

    coins: function (ctx, tt, p) {
      sky(ctx);
      // stall
      ctx.fillStyle = '#8A5A2B';
      ctx.fillRect(120, 128, 400, 12);
      ctx.fillRect(150, 140, 12, 48); ctx.fillRect(478, 140, 12, 48);
      ctx.fillStyle = '#E0432F';
      for (var st = 0; st < 8; st++) ctx.fillRect(120 + st * 50, 96, 25, 22);
      ctx.fillStyle = '#fff';
      for (var st2 = 0; st2 < 8; st2++) ctx.fillRect(145 + st2 * 50, 96, 25, 22);
      ctx.font = '26px Poppins, sans-serif';
      ctx.fillText('🍖', 190, 126);
      ctx.fillText('🌽', 250, 126);
      // coins stacking
      var count = Math.floor(tt * 9);
      for (var c = 0; c < count; c++) {
        var col = c % 3, row2 = Math.floor(c / 3);
        var cy = 122 - row2 * 11;
        ctx.fillStyle = '#FFC324';
        ctx.beginPath(); ctx.ellipse(360 + col * 40, cy, 15, 6.5, 0, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#D89E00'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(360 + col * 40, cy, 15, 6.5, 0, 0, Math.PI * 2); ctx.stroke();
      }
      var amount = Math.min(1, tt) * (p.amount || 180);
      label(ctx, (p.moneyLabel || 'Profit: N$') + Math.round(amount), 250, 40);
    },

    crossing: function (ctx, tt, p) {
      plain(ctx, '#F6F5FC', '#ECEAF6');
      ctx.strokeStyle = '#C9C5DC'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(70, 24); ctx.lineTo(70, H - 54); ctx.lineTo(W - 50, H - 54); ctx.stroke();
      var f = Math.min(1, tt * 1.25);
      // costs: starts at fixed cost level
      ctx.strokeStyle = '#E8762A'; ctx.lineWidth = 4; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(70, 132); ctx.lineTo(70 + (W - 130) * f, 132 - 62 * f); ctx.stroke();
      // revenue: from origin, steeper
      ctx.strokeStyle = '#3BB273';
      ctx.beginPath(); ctx.moveTo(70, H - 54); ctx.lineTo(70 + (W - 130) * f, (H - 54) - 148 * f); ctx.stroke();
      ctx.font = '600 12.5px Poppins, sans-serif';
      ctx.fillStyle = '#E8762A'; ctx.fillText('Total costs', 78, 118);
      ctx.fillStyle = '#3BB273'; ctx.fillText('Revenue', 78, H - 64);
      // break-even pulse at intersection (~x=356, y=97)
      if (f > 0.62) {
        var pu = 6 + 3 * Math.sin(tt * 10);
        ctx.strokeStyle = '#7C3AED'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(356, 97, pu + 6, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = '#7C3AED';
        ctx.beginPath(); ctx.arc(356, 97, 5, 0, Math.PI * 2); ctx.fill();
        label(ctx, p.label || 'Break-even point', 370, 66);
      }
    },

    dice: function (ctx, tt, p) {
      plain(ctx, '#1E5E3F', '#17492F');
      var bounce = Math.abs(Math.sin(tt * Math.PI * 1.6));
      var dy = 120 - bounce * 55;
      var rolling = bounce > 0.35;
      var face = rolling ? (Math.floor(tt * 9) % 6) + 1 : (p.face || 6);
      ctx.save();
      ctx.translate(W / 2, dy);
      ctx.rotate(rolling ? Math.sin(tt * 7) * 0.4 : 0);
      ctx.fillStyle = '#fff';
      roundRect(ctx, -38, -38, 76, 76, 14); ctx.fill();
      ctx.fillStyle = '#1F2033';
      var pips = { 1: [[0, 0]], 2: [[-1, -1], [1, 1]], 3: [[-1, -1], [0, 0], [1, 1]], 4: [[-1, -1], [1, -1], [-1, 1], [1, 1]], 5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]], 6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]] };
      (pips[face] || pips[6]).forEach(function (pt) {
        ctx.beginPath(); ctx.arc(pt[0] * 19, pt[1] * 19, 6.5, 0, Math.PI * 2); ctx.fill();
      });
      ctx.restore();
      label(ctx, p.label || 'P(6) = 1/6 every single roll', W / 2 - 110, 24);
    },

    helix: function (ctx, tt, p) {
      plain(ctx, '#1E2440', '#2B2B54');
      var cx = W / 2;
      var colors = ['#4ADEDE', '#FFC324', '#F472B6', '#4ADE80'];
      for (var i = 0; i < 24; i++) {
        var y = 14 + i * 8.2;
        var ph = tt * 2.2 + i * 0.42;
        var x1 = cx + Math.sin(ph) * 88;
        var x2 = cx + Math.sin(ph + Math.PI) * 88;
        var front = Math.cos(ph) > 0;
        ctx.strokeStyle = 'rgba(255,255,255,' + (front ? 0.55 : 0.22) + ')';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
        ctx.fillStyle = colors[i % 4];
        ctx.globalAlpha = front ? 1 : 0.45;
        ctx.beginPath(); ctx.arc(x1, y, 6, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(x2, y, 6, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      }
    },

    triangle: function (ctx, tt, p) {
      sky(ctx);
      var f = Math.min(1, tt * 1.4);
      // wall
      ctx.fillStyle = '#B8B4CC';
      ctx.fillRect(470, 30, 26, 148);
      // ladder
      ctx.strokeStyle = '#8A5A2B'; ctx.lineWidth = 7; ctx.lineCap = 'round';
      var topY = 178 - 108 * f;
      ctx.beginPath(); ctx.moveTo(240, 178); ctx.lineTo(470, topY); ctx.stroke();
      // angle arc
      ctx.strokeStyle = '#7C3AED'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(240, 178, 42, -Math.atan((178 - topY) / 230), 0); ctx.stroke();
      ctx.fillStyle = '#7C3AED';
      ctx.font = '700 14px Poppins, sans-serif';
      ctx.fillText('30°', 292, 170);
      // height brace
      if (f > 0.95) {
        ctx.strokeStyle = '#E0432F'; ctx.lineWidth = 3;
        ctx.setLineDash([6, 5]);
        ctx.beginPath(); ctx.moveTo(505, 178); ctx.lineTo(505, topY); ctx.stroke();
        ctx.setLineDash([]);
        label(ctx, p.label || 'h = 10 × sin 30° = 5 m', 505, 96);
      }
    },

    sunpower: function (ctx, tt, p) {
      sky(ctx);
      ctx.fillStyle = '#FFC324';
      ctx.beginPath(); ctx.arc(90, 52, 24, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#FFC324'; ctx.lineWidth = 3;
      for (var i = 0; i < 8; i++) {
        var a = tt * 1.4 + i * Math.PI / 4;
        ctx.beginPath();
        ctx.moveTo(90 + Math.cos(a) * 31, 52 + Math.sin(a) * 31);
        ctx.lineTo(90 + Math.cos(a) * 40, 52 + Math.sin(a) * 40);
        ctx.stroke();
      }
      // panel
      ctx.save();
      ctx.translate(280, 140); ctx.rotate(-0.32);
      ctx.fillStyle = '#27408B';
      roundRect(ctx, -70, -40, 140, 80, 6); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 2;
      for (var gx2 = -70; gx2 <= 70; gx2 += 35) { ctx.beginPath(); ctx.moveTo(gx2, -40); ctx.lineTo(gx2, 40); ctx.stroke(); }
      ctx.beginPath(); ctx.moveTo(-70, 0); ctx.lineTo(70, 0); ctx.stroke();
      ctx.restore();
      // wire + energy dots
      ctx.strokeStyle = '#5A5D75'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(345, 155); ctx.quadraticCurveTo(430, 175, 510, 130); ctx.stroke();
      ctx.fillStyle = '#FFE178';
      for (var d = 0; d < 4; d++) {
        var dp = ((tt * 0.7) + d * 0.25) % 1;
        var qx = 345 + (510 - 345) * dp;
        var qy = 155 + (130 - 155) * dp + Math.sin(dp * Math.PI) * 22;
        ctx.beginPath(); ctx.arc(qx, qy, 5, 0, Math.PI * 2); ctx.fill();
      }
      // bulb glowing
      var glow = 0.55 + 0.45 * Math.sin(tt * 5);
      var bg = ctx.createRadialGradient(520, 108, 4, 520, 108, 34);
      bg.addColorStop(0, 'rgba(255,225,120,' + glow + ')');
      bg.addColorStop(1, 'rgba(255,225,120,0)');
      ctx.fillStyle = bg;
      ctx.beginPath(); ctx.arc(520, 108, 34, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#FFE178';
      ctx.beginPath(); ctx.arc(520, 108, 13, 0, Math.PI * 2); ctx.fill();
    },

    chain: function (ctx, tt, p) {
      plain(ctx, '#DCEFD8', '#C7E5C1');
      var items = [['🌾', '1000 kJ', 1], ['🦌', '100 kJ', 0.42], ['🦁', '10 kJ', 0.18]];
      var step = Math.min(2.99, tt * 3.6);
      for (var i = 0; i < 3; i++) {
        var x = 110 + i * 190;
        var on = step >= i;
        ctx.globalAlpha = on ? 1 : 0.25;
        ctx.font = '52px Poppins, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(items[i][0], x, 110);
        ctx.textAlign = 'left';
        // energy bar
        ctx.fillStyle = '#E9E5F5';
        roundRect(ctx, x - 45, 132, 90, 12, 6); ctx.fill();
        ctx.fillStyle = '#3BB273';
        roundRect(ctx, x - 45, 132, 90 * items[i][2] * (on ? 1 : 0), 12, 6); ctx.fill();
        ctx.fillStyle = '#1F2033';
        ctx.font = '700 12.5px Poppins, sans-serif';
        ctx.textAlign = 'center';
        if (on) ctx.fillText(items[i][1], x, 164);
        ctx.textAlign = 'left';
        ctx.globalAlpha = 1;
        if (i < 2 && step > i + 0.5) {
          ctx.fillStyle = '#5A5D75';
          ctx.font = '700 22px Poppins, sans-serif';
          ctx.fillText('→', x + 74, 108);
          ctx.font = '600 11px Poppins, sans-serif';
          ctx.fillText('only 10%', x + 58, 84);
        }
      }
    },

    lockkey: function (ctx, tt, p) {
      plain(ctx, '#FDF4E5', '#FAECD4');
      var f = Math.min(1, tt * 1.6);
      var snap = f >= 1;
      // enzyme (big blob with notch)
      ctx.fillStyle = '#7C3AED';
      ctx.beginPath();
      ctx.arc(430, 110, 66, 0.55, Math.PI * 2 - 0.55);
      ctx.lineTo(430 + 66 * Math.cos(0.55), 110 - 30);
      ctx.lineTo(398, 110 - 30);
      ctx.lineTo(398, 110 + 30);
      ctx.lineTo(430 + 66 * Math.cos(0.55), 110 + 30);
      ctx.closePath();
      ctx.fill();
      // substrate (key) sliding in
      var sx = 120 + (398 - 60 - 120) * f;
      ctx.fillStyle = '#FFC324';
      roundRect(ctx, sx, 92, 60, 36, 6); ctx.fill();
      ctx.fillStyle = '#E8A13A';
      ctx.fillRect(sx - 26, 102, 28, 16);
      if (snap) {
        var pu = 3 * Math.sin(tt * 12);
        ctx.strokeStyle = '#3BB273'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(400, 110, 84 + pu, 0, Math.PI * 2); ctx.stroke();
        label(ctx, 'Perfect fit → reaction!', 150, 34);
      } else {
        label(ctx, 'Substrate finding the active site…', 150, 34);
      }
      ctx.fillStyle = '#fff';
      ctx.font = '700 13px Poppins, sans-serif';
      ctx.fillText('enzyme', 432, 114);
    },

    car: function (ctx, tt, p) {
      sky(ctx);
      // road
      ctx.fillStyle = '#5A5D75';
      ctx.fillRect(0, 150, W, 34);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
      ctx.setLineDash([26, 22]);
      ctx.beginPath(); ctx.moveTo(-((tt * 260) % 48), 167); ctx.lineTo(W, 167); ctx.stroke();
      ctx.setLineDash([]);
      var f = Math.min(1, tt / 0.9);
      var speed = Math.round(f * f * 120);
      ctx.font = '46px Poppins, sans-serif';
      ctx.fillText('🚗', 90 + (tt % 1) * 8, 162);
      label(ctx, speed + ' km/h', 108, 92);
      // speedometer arc
      ctx.strokeStyle = '#E9E5F5'; ctx.lineWidth = 9;
      ctx.beginPath(); ctx.arc(520, 92, 40, Math.PI, 2 * Math.PI); ctx.stroke();
      ctx.strokeStyle = '#E0432F';
      ctx.beginPath(); ctx.arc(520, 92, 40, Math.PI, Math.PI + Math.PI * (speed / 160)); ctx.stroke();
      ctx.fillStyle = '#1F2033';
      ctx.font = '700 13px Poppins, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('v = s ÷ t', 520, 88);
      ctx.textAlign = 'left';
    },

    people: function (ctx, tt, p) {
      plain(ctx, '#F6F5FC', '#ECEAF6');
      var groups = [['👤', 'Sole trader', 1], ['👥', 'Partnership', 2], ['🏢', 'Company', 3]];
      var step = Math.min(2.99, tt * 3.4);
      for (var i = 0; i < 3; i++) {
        var x = 120 + i * 200;
        var on = step >= i;
        ctx.globalAlpha = on ? 1 : 0.25;
        ctx.font = '48px Poppins, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(groups[i][0], x, 104);
        ctx.font = '700 14px Poppins, sans-serif';
        ctx.fillStyle = '#1F2033';
        ctx.fillText(groups[i][1], x, 140);
        ctx.font = '600 11.5px Poppins, sans-serif';
        ctx.fillStyle = '#6B6E85';
        ctx.fillText(i === 0 ? 'all profit, all risk' : i === 1 ? 'shared skills, shared risk' : 'limited liability', x, 162);
        ctx.textAlign = 'left';
        ctx.globalAlpha = 1;
      }
    },

    factory: function (ctx, tt, p) {
      plain(ctx, '#F0EFF8', '#E4E2F0');
      // conveyor
      ctx.fillStyle = '#5A5D75';
      ctx.fillRect(60, 140, 520, 14);
      for (var w2 = 0; w2 < 9; w2++) {
        var wx = 70 + ((w2 * 62 + tt * 90) % 510);
        ctx.fillStyle = '#B8B4CC';
        ctx.beginPath(); ctx.arc(wx, 160, 8, 0, Math.PI * 2); ctx.fill();
      }
      // boxes
      var made = 0;
      for (var bx3 = 0; bx3 < 6; bx3++) {
        var pxx = 60 + ((bx3 * 100 + tt * 90) % 520);
        var faulty = bx3 === 4;
        ctx.fillStyle = faulty ? '#E0432F' : '#C98E4A';
        roundRect(ctx, pxx, 106, 40, 34, 4); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = '700 16px Poppins, sans-serif';
        ctx.fillText(faulty ? '✗' : '✓', pxx + 14, 129);
        if (!faulty) made++;
      }
      label(ctx, p.label || 'Quality check: 98% good units', 200, 44);
    }
  };

  // topic name → scene + params
  var MAP = {
    'Quadratic functions': ['projectile', { formula: 'y = −4.9t² + 20t', caption: 'Projectile motion · a netball shot', label: 'Max height 20.4 m · t = 2.0 s' }],
    'Sequences and series': ['bars', { formula: 'Tₙ = 50 × 2ⁿ⁻¹', caption: 'Kapana profit doubling daily', vals: [50, 100, 200, 400, 800], prefix: 'N$' }],
    'Financial mathematics': ['bars', { formula: 'A = P(1 + i)ⁿ', caption: 'N$2000 growing at 10% compound', vals: [2000, 2200, 2420, 2662, 2928], prefix: 'N$' }],
    'Trigonometry': ['triangle', { formula: 'h = 10 × sin 30°', caption: 'The safe ladder angle', label: 'h = 10 × sin 30° = 5 m' }],
    'Coordinate geometry': ['linegraph', { formula: 'd = √(3² + 4²)', caption: 'Shortest taxi route across town', a: '(0;0)', b: '(3;4) · d = 5 km' }],
    'Probability and statistics': ['dice', { formula: 'P(6) = 1/6', caption: 'Every roll, same chance', face: 6 }],
    'Cells and transport': ['particles', { formula: 'high → low concentration', caption: 'Osmosis · water crossing a membrane' }],
    'Enzymes': ['lockkey', { formula: 'enzyme + substrate → product', caption: 'The lock and key model' }],
    'Photosynthesis': ['leaf', { formula: '6CO₂ + 6H₂O → C₆H₁₂O₆ + 6O₂', caption: 'A leaf running on sunlight' }],
    'Human gas exchange and smoking': ['breathe', { formula: '15 × 0.5 ℓ = 7.5 ℓ/min', caption: 'Your lungs on the job' }],
    'Genetics and inheritance': ['helix', { formula: 'Tt × Tt → 1 : 2 : 1', caption: 'DNA · the code of life' }],
    'Ecology and ecosystems': ['chain', { formula: '10% energy rule', caption: 'Grass → springbok → lion' }],
    'Motion and forces': ['car', { formula: 'v = s ÷ t', caption: '120 km/h on the B1' }],
    'Electricity': ['circuit', { formula: 'V = I × R', caption: 'Current lighting the bulb' }],
    'Waves, light and sound': ['wave', { formula: 'v = f × λ', caption: 'Sound travelling at 340 m/s' }],
    'Acids, bases and salts': ['beaker', { formula: 'acid + base → salt + water', caption: 'Universal indicator at work' }],
    'Chemical reactions and moles': ['beaker', { formula: 'CH₄ + 2O₂ → CO₂ + 2H₂O', caption: 'A balanced reaction in the flask' }],
    'Energy': ['sunpower', { formula: 'PE = mgh · KE = ½mv²', caption: 'Desert sun to evening light' }],
    'Entrepreneurship': ['coins', { formula: 'Profit = Revenue − Costs', caption: 'Kapana stall · N$480 − N$300', amount: 180, moneyLabel: 'Profit: N$' }],
    'Marketing': ['coins', { formula: 'Price = Cost + 50%', caption: 'The mark-up that pays the rent', amount: 12, moneyLabel: 'Selling price: N$' }],
    'Financial literacy': ['coins', { formula: '15% VAT', caption: 'Where your N$100 really goes', amount: 800, moneyLabel: 'Saved: N$' }],
    'Break-even and costs': ['crossing', { formula: 'BE = FC ÷ (P − VC)', caption: 'Where revenue meets costs', label: 'Break-even · 250 loaves' }],
    'Business organisation': ['people', { formula: '(Pty) Ltd', caption: 'Three ways to own a business' }],
    'Production and employment': ['factory', { formula: '200 ÷ 4 = 50 per worker', caption: 'Productivity on the line', label: 'Quality check: 490 of 500 good' }]
  };

  var SUBJECT_DEFAULT = {
    'Mathematics': 'Quadratic functions',
    'Biology': 'Photosynthesis',
    'Physical Science': 'Electricity',
    'Business Studies': 'Entrepreneurship'
  };

  window.K12_SCENES = {
    has: function (topic) { return !!MAP[topic]; },
    draw: function (canvas, topic, subject, t) {
      var entry = MAP[topic] || MAP[SUBJECT_DEFAULT[subject] || 'Quadratic functions'];
      if (!entry || !canvas) return;
      var ctx = canvas.getContext('2d');
      if (!ctx) return;
      var scene = SCENES[entry[0]];
      var params = entry[1] || {};
      var PERIOD = 4.2;
      var tt = (t % PERIOD) / PERIOD;
      ctx.clearRect(0, 0, W, H);
      ctx.textAlign = 'left';
      scene(ctx, tt, params);
      if (params.formula) chip(ctx, params.formula, W - 12, 10);
      caption(ctx, params.caption || topic, tt);
    }
  };
})();

/* ZCode Agent Panel - injected widget + standalone preview.
 *
 * Design follows the Antigravity agent panel: an "Agents" card pinned above the
 * chat composer with one Main agent row (tokens burned, context left, time, cost)
 * and one row per working subagent. The main agent wears a captain's hat robot
 * face; every subagent shows its own small character, keyed by profile color.
 *
 * Idempotent: safe to evaluate repeatedly in the same document. A newer VERSION
 * evaluated over a running older copy retires the old one and rebuilds, so the
 * live ZCode windows can be updated without restarting the app (apply-panel.js).
 * Injected mode: the daemon pushes telemetry by calling window.__ZCODE_PANEL_FEED(json).
 * Standalone mode (opened at the daemon URL): it polls /api/telemetry itself.
 */
(function () {
  'use strict';

  // Bump VERSION whenever the widget's markup, CSS or icons change.
  var VERSION = 6;

  if (window.__zcodeAgentPanelInstalled && window.__zcodeAgentPanelVersion === VERSION) {
    try { window.__zcodeAgentPanelEnsure && window.__zcodeAgentPanelEnsure(); } catch (e) {}
    return;
  }
  window.__zcodeAgentPanelInstalled = true;
  window.__zcodeAgentPanelVersion = VERSION;

  var BASE = window.__ZCODE_PANEL_BASE || location.origin;
  var PUSH_ONLY = !!window.__ZCODE_PANEL_PUSH_ONLY;
  var HOST_ID = 'zcode-agent-panel-host-' + VERSION;

  var state = {
    data: null,
    error: null,
    hidden: false,        // user pressed Hide
    pinned: false,        // user toggled with Ctrl+Shift+Z
    showDone: false,      // finished subagents expanded
    anchorEl: null,
    mode: 'float',        // 'embed' | 'float'
    hostRef: null,        // the host element this instance owns
  };

  // ------------------------------------------------------------- helpers ----

  function fmtTokens(n) {
    if (n == null || isNaN(n)) return '-';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k';
    return String(n);
  }
  function fmtDur(ms) {
    if (ms == null || !isFinite(ms) || ms < 0) return '-';
    var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    var pad = function (x) { return x < 10 ? '0' + x : '' + x; };
    return h ? h + ':' + pad(m) + ':' + pad(ss) : pad(m) + ':' + pad(ss);
  }
  function fmtCost(c) {
    if (c == null || !isFinite(c)) return null;
    if (c >= 100) return '≈$' + c.toFixed(0);
    if (c >= 1) return '≈$' + c.toFixed(2);
    if (c > 0) return '≈$' + c.toFixed(3);
    return null;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function agentColor(name) {
    var map = {
      blue: '#4A9FD9', purple: '#A78BFA', green: '#3BB873', orange: '#D99A3B',
      red: '#D9553B', cyan: '#22D3EE', yellow: '#D9C23B', pink: '#E879B9', teal: '#3BB8A0',
    };
    var k = String(name || '').toLowerCase();
    if (map[k]) return map[k];
    var h = 0;
    for (var i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) % 360;
    return 'hsl(' + h + ' 62% 60%)';
  }

  // --------------------------------------------------------- agent icons ----
  // The main agent is a robot in a captain's hat. Each subagent gets its own
  // small character, keyed by the profile color ZCode records in its metadata,
  // so the same profile always shows the same face. Every character shares two
  // CSS animations: the `.eyes` group blinks, the root svg bobs (faster while
  // the agent is running).

  var INK = '#242b3f';       // eye / mouth color
  var BLUSH = '#ff9ec0';

  // One pair of eyes with glints, as a group so the blink animation can squash it.
  function eyePair(x1, x2, y, r) {
    var dx = r * 0.3, gr = r * 0.32;
    return '<g class="eyes">'
      + '<circle cx="' + x1 + '" cy="' + y + '" r="' + r + '" fill="' + INK + '"/>'
      + '<circle cx="' + x2 + '" cy="' + y + '" r="' + r + '" fill="' + INK + '"/>'
      + '<circle cx="' + (x1 + dx) + '" cy="' + (y - dx) + '" r="' + gr + '" fill="#fff"/>'
      + '<circle cx="' + (x2 + dx) + '" cy="' + (y - dx) + '" r="' + gr + '" fill="#fff"/>'
      + '</g>';
  }

  // The main agent: robot in a captain's hat, gold badge, pulsing cap light and
  // (while the panel is running) a sparkle that pops in the top corner.
  var ICON_MAIN = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<defs><linearGradient id="zcapHead" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0" stop-color="#79a4ff"/><stop offset="1" stop-color="#9c7dff"/>'
    + '</linearGradient></defs>'
    + '<path d="M3.6 7.8 C3.8 3.6 7.2 1.6 12 1.6 C16.8 1.6 20.2 3.6 20.4 7.8 Z" fill="#f2f5ff" stroke="rgba(28,36,64,.35)" stroke-width=".5"/>'
    + '<rect x="3.3" y="6.5" width="17.4" height="2.7" rx="1.35" fill="#2c3d6e"/>'
    + '<ellipse cx="12" cy="9.7" rx="8.9" ry="1.8" fill="#22305a"/>'
    + '<circle cx="12" cy="5.3" r="2.05" fill="#f6c453" stroke="#c8902f" stroke-width=".5"/>'
    + '<circle class="caplight" cx="12" cy="5.3" r=".8" fill="#fff6d8"/>'
    + '<circle cx="3.7" cy="15" r="1.7" fill="#6b93f2"/>'
    + '<circle cx="20.3" cy="15" r="1.7" fill="#6b93f2"/>'
    + '<rect x="4.4" y="9.4" width="15.2" height="12.4" rx="4.4" fill="url(#zcapHead)" stroke="rgba(24,32,60,.3)" stroke-width=".6"/>'
    + '<g class="eyes">'
    + '<rect x="7.2" y="12.7" width="3.4" height="3.8" rx="1.7" fill="#fff"/>'
    + '<rect x="13.4" y="12.7" width="3.4" height="3.8" rx="1.7" fill="#fff"/>'
    + '<circle cx="8.9" cy="14.6" r="1.15" fill="' + INK + '"/>'
    + '<circle cx="15.1" cy="14.6" r="1.15" fill="' + INK + '"/>'
    + '<circle cx="9.25" cy="14.2" r=".38" fill="#fff"/>'
    + '<circle cx="15.45" cy="14.2" r=".38" fill="#fff"/>'
    + '</g>'
    + '<circle cx="6.6" cy="17.5" r="1.05" fill="' + BLUSH + '" opacity=".55"/>'
    + '<circle cx="17.4" cy="17.5" r="1.05" fill="' + BLUSH + '" opacity=".55"/>'
    + '<path d="M10.5 17.9 Q12 19.2 13.5 17.9" stroke="' + INK + '" stroke-width=".9" fill="none" stroke-linecap="round"/>'
    + '<path class="sparkle" d="M20.6 2.2 l.55 1.35 1.35 .55 -1.35 .55 -.55 1.35 -.55 -1.35 -1.35 -.55 1.35 -.55 Z" fill="#ffd75e"/>'
    + '</svg>';

  // One character per profile color, drawn on a 20x20 grid with `c` as body color.
  function characterSvg(name, c) {
    var body;
    switch (name) {
      case 'puppy':
        body = '<ellipse cx="4.2" cy="9.2" rx="2.5" ry="3.9" fill="' + c + '" transform="rotate(-24 4.2 9.2)"/>'
          + '<ellipse cx="15.8" cy="9.2" rx="2.5" ry="3.9" fill="' + c + '" transform="rotate(24 15.8 9.2)"/>'
          + '<circle cx="10" cy="10.9" r="6.2" fill="' + c + '"/>'
          + '<ellipse cx="10" cy="13.5" rx="3.5" ry="2.6" fill="#fff" opacity=".92"/>'
          + eyePair(7.2, 12.8, 9, 1.15)
          + '<ellipse cx="10" cy="11.9" rx="1.25" ry=".92" fill="' + INK + '"/>'
          + '<path d="M8.7 13.2 Q10 14.5 11.3 13.2" stroke="' + INK + '" stroke-width=".8" fill="none" stroke-linecap="round"/>';
        break;
      case 'cat':
        body = '<path d="M4.9 7.6 L4.3 2.5 L9 5.5 Z" fill="' + c + '"/>'
          + '<path d="M15.1 7.6 L15.7 2.5 L11 5.5 Z" fill="' + c + '"/>'
          + '<path d="M6 6.6 L5.7 4.4 L8 5.7 Z" fill="#fff" opacity=".32"/>'
          + '<path d="M14 6.6 L14.3 4.4 L12 5.7 Z" fill="#fff" opacity=".32"/>'
          + '<circle cx="10" cy="11" r="6.1" fill="' + c + '"/>'
          + eyePair(7.5, 12.5, 10.1, 1.15)
          + '<path d="M9.3 12.5 h1.4 l-.7 .85 Z" fill="' + INK + '"/>'
          + '<path d="M10 13.35 q-1.3 1.2 -2.2 .15 M10 13.35 q1.3 1.2 2.2 .15" stroke="' + INK + '" stroke-width=".7" fill="none" stroke-linecap="round"/>'
          + '<path d="M3.2 11.1 h2.6 M3.4 12.9 h2.4 M16.8 11.1 h-2.6 M16.6 12.9 h-2.4" stroke="' + INK + '" stroke-width=".5" opacity=".5" stroke-linecap="round"/>';
        break;
      case 'frog':
        body = '<circle cx="6.5" cy="6.7" r="2.6" fill="' + c + '"/>'
          + '<circle cx="13.5" cy="6.7" r="2.6" fill="' + c + '"/>'
          + '<ellipse cx="10" cy="11.6" rx="6.1" ry="5.2" fill="' + c + '"/>'
          + '<circle cx="6.5" cy="6.7" r="1.55" fill="#fff"/>'
          + '<circle cx="13.5" cy="6.7" r="1.55" fill="#fff"/>'
          + eyePair(6.65, 13.35, 6.8, .85)
          + '<path d="M6.7 12.5 Q10 16 13.3 12.5" stroke="' + INK + '" stroke-width=".85" fill="none" stroke-linecap="round"/>'
          + '<circle cx="5.4" cy="11.6" r="1" fill="#fff" opacity=".22"/>'
          + '<circle cx="14.6" cy="11.6" r="1" fill="#fff" opacity=".22"/>';
        break;
      case 'fox':
        body = '<path d="M4 7.8 L4.7 2.3 L9.3 5.5 Z" fill="' + c + '"/>'
          + '<path d="M16 7.8 L15.3 2.3 L10.7 5.5 Z" fill="' + c + '"/>'
          + '<path d="M5.35 6.2 L5.75 4 L7.6 5.45 Z" fill="' + INK + '" opacity=".45"/>'
          + '<path d="M14.65 6.2 L14.25 4 L12.4 5.45 Z" fill="' + INK + '" opacity=".45"/>'
          + '<circle cx="10" cy="11" r="6.1" fill="' + c + '"/>'
          + '<ellipse cx="10" cy="13.6" rx="4" ry="2.7" fill="#fff" opacity=".95"/>'
          + eyePair(7.3, 12.7, 9.4, 1.15)
          + '<ellipse cx="10" cy="12" rx="1.3" ry=".95" fill="' + INK + '"/>'
          + '<path d="M9.1 14.2 q.9 .9 1.8 0" stroke="' + INK + '" stroke-width=".7" fill="none" stroke-linecap="round"/>';
        break;
      case 'crab':
        body = '<path d="M7.4 8.9 L7 6 M12.6 8.9 L13 6" stroke="' + c + '" stroke-width="1.1" stroke-linecap="round"/>'
          + '<circle cx="3.6" cy="10.9" r="2.2" fill="' + c + '"/>'
          + '<circle cx="16.4" cy="10.9" r="2.2" fill="' + c + '"/>'
          + '<path d="M5.5 16 l-1.4 .9 M7.6 16.9 l-.7 1.4 M14.5 16 l1.4 .9 M12.4 16.9 l.7 1.4" stroke="' + INK + '" stroke-width=".7" opacity=".4" stroke-linecap="round"/>'
          + '<ellipse cx="10" cy="12.6" rx="5.7" ry="4.4" fill="' + c + '"/>'
          + '<circle cx="7" cy="5.6" r="1.65" fill="#fff"/>'
          + '<circle cx="13" cy="5.6" r="1.65" fill="#fff"/>'
          + eyePair(7, 13, 5.7, .9)
          + '<path d="M8.3 13.1 Q10 14.7 11.7 13.1" stroke="' + INK + '" stroke-width=".8" fill="none" stroke-linecap="round"/>';
        break;
      case 'fish':
        body = '<path d="M13 10 L18.6 6.2 L18.6 13.8 Z" fill="' + c + '" opacity=".8"/>'
          + '<path d="M6.9 6.5 Q9 3.6 11.4 6 Z" fill="' + c + '" opacity=".8"/>'
          + '<ellipse cx="8.4" cy="10" rx="5.7" ry="4.5" fill="' + c + '"/>'
          + '<circle cx="6.4" cy="9" r="1.9" fill="#fff"/>'
          + '<g class="eyes"><circle cx="6.4" cy="9.1" r=".95" fill="' + INK + '"/>'
          + '<circle cx="6.7" cy="8.8" r=".3" fill="#fff"/></g>'
          + '<path d="M3.4 11.2 q.8 .9 1.8 .8" stroke="' + INK + '" stroke-width=".7" fill="none" stroke-linecap="round"/>'
          + '<circle cx="7.7" cy="11.9" r="1" fill="#fff" opacity=".3"/>';
        break;
      case 'chick':
        body = '<path d="M9.1 5.6 Q9.4 3.5 11 3.3" stroke="' + c + '" stroke-width="1.1" fill="none" stroke-linecap="round"/>'
          + '<path d="M10.7 5.8 Q11.5 4.1 12.9 4.5" stroke="' + c + '" stroke-width="1" fill="none" stroke-linecap="round"/>'
          + '<circle cx="10" cy="11.5" r="6.2" fill="' + c + '"/>'
          + '<ellipse cx="5.6" cy="12.4" rx="1.45" ry="2.45" fill="#000" opacity=".1"/>'
          + '<ellipse cx="14.4" cy="12.4" rx="1.45" ry="2.45" fill="#000" opacity=".1"/>'
          + eyePair(7.5, 12.5, 9.9, 1.1)
          + '<path d="M8.95 12 L11.05 12 L10 13.5 Z" fill="#e8963b"/>'
          + '<circle cx="6.8" cy="13.5" r=".9" fill="' + BLUSH + '" opacity=".5"/>'
          + '<circle cx="13.2" cy="13.5" r=".9" fill="' + BLUSH + '" opacity=".5"/>';
        break;
      case 'bunny':
        body = '<ellipse cx="7.3" cy="4.8" rx="1.65" ry="3.6" fill="' + c + '" transform="rotate(-9 7.3 4.8)"/>'
          + '<ellipse cx="12.7" cy="4.8" rx="1.65" ry="3.6" fill="' + c + '" transform="rotate(9 12.7 4.8)"/>'
          + '<ellipse cx="7.3" cy="5" rx=".72" ry="2.2" fill="#fff" opacity=".5" transform="rotate(-9 7.3 5)"/>'
          + '<ellipse cx="12.7" cy="5" rx=".72" ry="2.2" fill="#fff" opacity=".5" transform="rotate(9 12.7 5)"/>'
          + '<circle cx="10" cy="11.9" r="5.7" fill="' + c + '"/>'
          + eyePair(7.6, 12.4, 10.9, 1.1)
          + '<path d="M9.35 13.2 h1.3 l-.65 .85 Z" fill="' + INK + '"/>'
          + '<path d="M10 14.05 q-.95 .95 -1.75 .1 M10 14.05 q.95 .95 1.75 .1" stroke="' + INK + '" stroke-width=".65" fill="none" stroke-linecap="round"/>'
          + '<circle cx="6.4" cy="13" r=".95" fill="' + BLUSH + '" opacity=".45"/>'
          + '<circle cx="13.6" cy="13" r=".95" fill="' + BLUSH + '" opacity=".45"/>';
        break;
      case 'octopus':
        body = '<circle cx="4.6" cy="13.7" r="1.75" fill="' + c + '"/>'
          + '<circle cx="7.5" cy="14.6" r="1.6" fill="' + c + '"/>'
          + '<circle cx="12.5" cy="14.6" r="1.6" fill="' + c + '"/>'
          + '<circle cx="15.4" cy="13.7" r="1.75" fill="' + c + '"/>'
          + '<path d="M3.9 11.4 a6.1 5.6 0 0 1 12.2 0 v1.4 H3.9 Z" fill="' + c + '"/>'
          + eyePair(7.4, 12.6, 10.2, 1.15)
          + '<path d="M8.6 12.4 Q10 13.5 11.4 12.4" stroke="' + INK + '" stroke-width=".75" fill="none" stroke-linecap="round"/>'
          + '<circle cx="5.6" cy="11.2" r=".95" fill="#fff" opacity=".25"/>'
          + '<circle cx="14.4" cy="11.2" r=".95" fill="#fff" opacity=".25"/>';
        break;
      default: // 'star', the face for subagents with an unknown or missing color
        body = '<path d="M10 2.5 L11.7 7.95 L17.42 7.89 L12.76 11.2 L14.58 16.61 L10 13.2 L5.42 16.61 L7.24 11.2 L2.58 7.89 L8.3 7.95 Z" fill="' + c + '" stroke="rgba(20,26,45,.18)" stroke-width=".5"/>'
          + eyePair(8.4, 11.6, 10.6, .9)
          + '<path d="M9.3 12.3 Q10 13.1 10.7 12.3" stroke="' + INK + '" stroke-width=".7" fill="none" stroke-linecap="round"/>';
    }
    return '<svg viewBox="0 0 20 20" aria-hidden="true">' + body + '</svg>';
  }

  var COLOR_CHARACTER = {
    blue: 'puppy', purple: 'cat', green: 'frog', orange: 'fox', red: 'crab',
    cyan: 'fish', yellow: 'chick', pink: 'bunny', teal: 'octopus',
  };

  function hashText(t) {
    var h = 0;
    t = String(t == null ? '' : t);
    for (var i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
    return h;
  }

  // Known profile color -> its character, so the same profile always shows the
  // same face. An unknown or missing color gets the star instead of a hashed
  // pick, so it can never accidentally clone a named profile's face.
  function characterFor(colorName) {
    return COLOR_CHARACTER[String(colorName || '').toLowerCase()] || 'star';
  }

  function subagentIconMarkup(s) {
    var d = (hashText(s.type) % 22) / 10;        // bob phase, so rows do not move in lockstep
    var e = (hashText(s.type + '~') % 34) / 10;  // blink phase
    return '<span class="subicon" style="--d:' + d + 's;--e:' + e + 's">'
      + characterSvg(characterFor(s.color), agentColor(s.color)) + '</span>';
  }

  // -------------------------------------------------------------- theme ----

  function luminanceOf(css) {
    var m = String(css || '').match(/rgba?\(([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+))?\)/i);
    if (!m) return null;
    var a = m[4] == null ? 1 : parseFloat(m[4]);
    if (a < 0.2) return null;
    return 0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3];
  }
  function detectLight() {
    try {
      var el = document.querySelector('[data-lexical-editor="true"]') || document.body;
      for (var i = 0; i < 7 && el; i++) {
        var lum = luminanceOf(getComputedStyle(el).backgroundColor);
        if (lum != null) return lum > 140;
        el = el.parentElement;
      }
      var bodyLum = luminanceOf(getComputedStyle(document.body).backgroundColor);
      if (bodyLum != null) return bodyLum > 140;
    } catch (e) {}
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
  }

  // -------------------------------------------------------------- styles ----

  var CSS = [
    ':host { all: initial; }',
    '* { box-sizing: border-box; }',
    '.panel {',
    '  --fg:#e9ecf3; --fg2:#c3c9d6; --dim:#8b93a7; --line:rgba(148,158,184,.22); --line2:rgba(148,158,184,.12);',
    '  --bg:rgba(22,25,32,.94); --bg2:rgba(29,33,42,.92); --accent:#5a8cff;',
    '  font:12.5px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; color:var(--fg);',
    '  background:var(--bg); border:1px solid var(--line); border-radius:14px;',
    '  box-shadow:0 10px 30px rgba(0,0,0,.38), inset 0 1px 0 rgba(255,255,255,.045);',
    '  backdrop-filter:blur(16px); -webkit-backdrop-filter:blur(16px);',
    '  overflow:hidden; position:relative;',
    '}',
    '.panel.light { --fg:#1b2030; --fg2:#3c4457; --dim:#6b7386; --line:rgba(96,106,132,.26); --line2:rgba(96,106,132,.13);',
    '  --bg:rgba(253,254,255,.95); --bg2:rgba(246,248,251,.95);',
    '  box-shadow:0 10px 26px rgba(28,38,68,.16), inset 0 1px 0 rgba(255,255,255,.8); }',
    '.strip { position:absolute; top:0; left:0; right:0; height:2px; opacity:0; transition:opacity .3s;',
    '  background:linear-gradient(90deg, transparent, var(--accent), #7ab8ff, var(--accent), transparent);',
    '  background-size:200% 100%; pointer-events:none; }',
    '.panel.running .strip { opacity:.95; animation:shimmer 2.2s linear infinite; }',
    '@keyframes shimmer { from { background-position:0% 0; } to { background-position:200% 0; } }',
    '.head { display:flex; align-items:center; gap:10px; padding:8px 12px 7px; }',
    '.title { font-size:14px; font-weight:650; letter-spacing:.1px; color:var(--fg); }',
    '.htotals { color:var(--dim); font-variant-numeric:tabular-nums; }',
    '.spacer { flex:1 1 auto; }',
    '.usage { display:inline-flex; align-items:center; gap:7px; color:var(--dim); white-space:nowrap; }',
    '.usage .label { font-size:11px; }',
    'button.x { all:unset; cursor:pointer; font-size:11px; color:var(--fg2); border:1px solid var(--line);',
    '  border-radius:8px; padding:2px 9px; white-space:nowrap; }',
    'button.x:hover { background:var(--line2); color:var(--fg); }',
    '.rows { border-top:1px solid var(--line2); }',
    '.row { display:flex; align-items:center; gap:8px; padding:6px 12px; min-height:32px; }',
    '.row + .row { border-top:1px solid var(--line2); }',
    '.row .mark { width:20px; height:20px; flex:none; display:grid; place-items:center; }',
    '.subicon { width:15px; height:15px; flex:none; display:grid; place-items:center; opacity:.75; }',
    '.row.sub.running .subicon { opacity:1; }',
    '.row .mark svg, .subicon svg { display:block; width:100%; height:100%; overflow:visible; }',
    '.row .name { font-weight:650; white-space:nowrap; }',
    '.row .model { color:var(--fg2); opacity:.92; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:210px; }',
    '.row .desc { color:var(--dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
    '.row.sub .type { color:var(--fg2); font-weight:600; white-space:nowrap; max-width:140px; overflow:hidden; text-overflow:ellipsis; }',
    '.chip { font-size:10.5px; padding:1px 6px; border-radius:999px; border:1px solid var(--line); white-space:nowrap; }',
    '.chip.light { color:#2f9d7a; background:rgba(59,184,160,.13); border-color:rgba(59,184,160,.35); }',
    '.chip.medium { color:#4A9FD9; background:rgba(74,159,217,.13); border-color:rgba(74,159,217,.35); }',
    '.chip.heavy { color:#D97A3B; background:rgba(217,122,59,.14); border-color:rgba(217,122,59,.38); }',
    '.chip.off { color:var(--dim); background:var(--line2); }',
    '.metric { display:inline-flex; align-items:center; gap:5px; color:var(--dim); white-space:nowrap; font-variant-numeric:tabular-nums; }',
    '.metric.fg { color:var(--fg2); }',
    '.pctfree { color:var(--dim); }',
    '.bar { width:46px; height:5px; border-radius:999px; background:var(--line2); overflow:hidden; display:inline-block; flex:none; }',
    '.bar i { display:block; height:100%; width:0%; border-radius:999px; background:linear-gradient(90deg,#4A9FD9,#8f6bff); transition:width .5s; }',
    '.bar.warn i { background:linear-gradient(90deg,#D9A03B,#D97A3B); }',
    '.bar.hot i { background:linear-gradient(90deg,#D9553B,#ff6b6b); }',
    '.dot { width:7px; height:7px; border-radius:50%; background:var(--dim); flex:none; opacity:.6; }',
    '.panel.running .dot { background:#3BB873; opacity:1; animation:pulse 1.4s ease-in-out infinite; }',
    '.panel.err .dot { background:#D9553B; opacity:1; }',
    '@keyframes pulse { 0%,100% { box-shadow:0 0 0 0 rgba(59,184,115,.5); } 50% { box-shadow:0 0 0 4px rgba(59,184,115,0); } }',
    '.row .mark svg, .subicon svg { animation:icon-bob 3.2s ease-in-out infinite; animation-delay:calc(-1 * var(--d, 0s)); }',
    '.row .mark svg .eyes, .subicon svg .eyes { transform-box:fill-box; transform-origin:center; animation:icon-blink 5.4s ease-in-out infinite; animation-delay:calc(-1 * var(--e, .6s)); }',
    '.panel.running .row.main .mark svg { animation-duration:1.7s; }',
    '.panel.running .row.main .mark svg .eyes { animation-duration:3.6s; }',
    '.row.sub.running svg { animation-duration:1.5s; }',
    '.row.sub.running svg .eyes { animation-duration:3.4s; }',
    '.sparkle { opacity:0; transform-box:fill-box; transform-origin:center; }',
    '.panel.running .sparkle { animation:icon-sparkle 2.2s ease-in-out infinite; }',
    '.caplight { animation:cap-light 2.8s ease-in-out infinite; }',
    '@keyframes icon-bob { 0%,100% { transform:translateY(0); } 50% { transform:translateY(-1.1px); } }',
    '@keyframes icon-blink { 0%,89%,100% { transform:scaleY(1); } 92%,94% { transform:scaleY(.12); } }',
    '@keyframes icon-sparkle { 0%,55%,100% { opacity:0; transform:scale(.3) rotate(0deg); } 25% { opacity:1; transform:scale(1) rotate(18deg); } 40% { opacity:0; transform:scale(.55) rotate(30deg); } }',
    '@keyframes cap-light { 0%,100% { opacity:.35; } 50% { opacity:1; } }',
    '@media (prefers-reduced-motion:reduce) { .row .mark svg, .subicon svg, .row svg .eyes, .sparkle, .caplight { animation:none !important; } }',
    '.srunning { color:#3BB873; }',
    '.foot { display:flex; align-items:center; gap:10px; padding:6px 12px; border-top:1px solid var(--line2); color:var(--dim); background:var(--bg2); }',
    '.foot.hidden { display:none; }',
    '.empty { padding:8px 12px; color:var(--dim); }',
    '.hidden { display:none !important; }',
    '.panel.narrow1 .n1 { display:none !important; }',
    '.panel.narrow2 .n2 { display:none !important; }',
    '.panel.narrow3 .n3 { display:none !important; }',
    '.panel.narrow3 .model { max-width:120px; }',
    '.panel.narrow4 .bar { display:none !important; }',
  ].join('\n');

  // ----------------------------------------------------------- the widget ----

  // A newer injected copy has to take over from older copies that are still
  // running in the page (their timers and listeners survive re-injection).
  // Rules that keep the copies from fighting, learned the hard way:
  //   - each build marks its host with data-zcode-agent-panel="<VERSION>" and
  //     adopts it by that attribute, never by reading another build's JS
  //     properties. state.hostRef is the primary handle; the attribute lookup is
  //     only a recovery path, and it must scan ALL matches: the first element
  //     with my version may be a dead one from an earlier fight, and adopting a
  //     dead host by mistake means building a replacement every tick;
  //   - hosts from other builds are quarantined: marked data-zcap-retired, which
  //     a document-level `display:none !important` rule hides. A plain inline
  //     `host.style.display = 'block'` from an old copy cannot override that,
  //     and unlike trapping host properties it does not make the old copy build
  //     a replacement host;
  //   - suspected traps on old hosts are disarmed instead: for each host whose
  //     id encodes an older version, the JS properties old copies read
  //     (__zcapMounted and friends) are replaced with plain, sane values for
  //     that version. An old copy then adopts its own hidden host and goes back
  //     to rendering into it invisibly, instead of recreating hosts forever;
  //   - a host of MY version whose properties throw has been quarantined by an
  //     even newer copy: stay dormant and do not replicate.
  var QUARANTINE_ATTR = 'data-zcap-retired';
  var QUARANTINE_CSS_ID = 'zcap-quarantine-css';
  var HOST_VERSION_RE = /^zcode-agent-panel-host(?:-(\d+))?$/;

  function quarantineCss() {
    if (document.getElementById(QUARANTINE_CSS_ID)) return;
    try {
      var st = document.createElement('style');
      st.id = QUARANTINE_CSS_ID;
      st.textContent = '[' + QUARANTINE_ATTR + '] { display: none !important; }';
      (document.head || document.documentElement).appendChild(st);
    } catch (e) {}
  }

  function quarantine(host) {
    quarantineCss();
    try { host.setAttribute(QUARANTINE_ATTR, '1'); } catch (e) {}
    try { host.style.setProperty('display', 'none', 'important'); } catch (e) {}
  }

  function versionOfHostId(id) {
    var m = HOST_VERSION_RE.exec(String(id || ''));
    if (!m) return null;
    return m[1] ? Number(m[1]) : 0;   // the very first build used no suffix
  }

  // Give an older copy's host back the plain properties its owner reads, so the
  // owner stops rebuilding hosts around a value that throws.
  function disarm(host) {
    var v = versionOfHostId(host.id);
    if (v == null || v === VERSION) return;
    try {
      delete host.__zcapMounted;
      delete host.__zcapRefs;
      delete host.__zcapVersion;
    } catch (e) { return; }
    try { host.__zcapVersion = v; host.__zcapMounted = true; } catch (e) {}
  }

  // Run on every mount: hide every foreign host and calm every foreign copy.
  function sweep(keep) {
    var hosts = document.querySelectorAll('[data-zcode-agent-panel]');
    for (var i = 0; i < hosts.length; i++) {
      if (hosts[i] === keep) continue;
      if (!hosts[i].hasAttribute(QUARANTINE_ATTR)) quarantine(hosts[i]);
      disarm(hosts[i]);
    }
  }

  function ownHostState(host) {
    try {
      if (!host || host.__zcapVersion !== VERSION) return 'foreign';
      return host.__zcapMounted === true ? 'live' : 'foreign';
    } catch (e) { return 'retired'; }   // trapped by a newer copy
  }

  function buildHost() {
    if (state.hostRef && !state.hostRef.isConnected) state.hostRef = null;
    if (state.hostRef) {
      var own = ownHostState(state.hostRef);
      if (own === 'live') { sweep(state.hostRef); return state.hostRef; }
      if (own === 'retired') return null;
      state.hostRef = null;
    } else {
      var mine = document.querySelectorAll('[data-zcode-agent-panel="' + VERSION + '"]');
      for (var i = 0; i < mine.length; i++) {
        if (ownHostState(mine[i]) === 'live') {
          state.hostRef = mine[i];
          sweep(state.hostRef);
          return state.hostRef;
        }
      }
    }
    sweep(null);
    var host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-zcode-agent-panel', String(VERSION));
    host.style.cssText = 'display:block; position:relative; z-index:2147483000;';
    var root = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
    var wrap = document.createElement('div');
    wrap.className = 'panel';
    wrap.innerHTML = [
      '<div class="strip"></div>',
      '<div class="head">',
      '  <span class="title">Agents</span>',
      '  <span class="htotals" data-role="htotals"></span>',
      '  <span class="spacer"></span>',
      '  <span class="usage hidden" data-role="usage">',
      '    <span class="label">Context</span>',
      '    <span class="bar" data-role="ctxbar"><i data-role="ctxfill"></i></span>',
      '    <span class="metric fg" data-role="ctxpct"></span>',
      '  </span>',
      '  <button class="x" data-role="hidebtn" title="Hide the panel (Ctrl+Shift+Z shows it again)">Hide</button>',
      '</div>',
      '<div class="rows" data-role="rows"></div>',
      '<div class="foot hidden" data-role="foot">',
      '  <span data-role="donetext"></span>',
      '  <span class="spacer"></span>',
      '  <button class="x" data-role="showbtn">Show</button>',
      '</div>',
      '<div class="rows hidden" data-role="donerows"></div>',
      '<div class="empty hidden" data-role="empty"></div>',
    ].join('');
    root.appendChild(wrap);
    host.__zcapVersion = VERSION;
    host.__zcapMounted = true;
    host.__zcapRefs = {};
    state.hostRef = host;
    root.querySelectorAll('[data-role]').forEach(function (el) { host.__zcapRefs[el.getAttribute('data-role')] = el; });
    var refs = host.__zcapRefs;

    refs.hidebtn.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      state.hidden = true;
      render();
    });
    refs.showbtn.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      state.showDone = !state.showDone;
      render();
    });
    refs.rows.addEventListener('dblclick', function () { state.pinned = !state.pinned; state.hidden = false; render(); });
    // One shortcut handler per build, not per page: an older copy that is still
    // listening would otherwise swallow the shortcut for the retired panel only.
    if (!window['__zcapKeyHook' + VERSION]) {
      window['__zcapKeyHook' + VERSION] = true;
      document.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'Z' || e.key === 'z')) {
          e.preventDefault();
          state.hidden = false;
          state.pinned = !state.pinned;
          render();
        }
      }, true);
    }
    return host;
  }

  function findComposer() {
    var direct = document.querySelector('[data-lexical-editor="true"]');
    if (direct) return direct;
    var editables = document.querySelectorAll('[contenteditable="true"], textarea');
    var best = null, bestBottom = -1;
    for (var i = 0; i < editables.length; i++) {
      var r = editables[i].getBoundingClientRect();
      if (r.width < 160 || r.height < 16) continue;
      if (r.bottom > bestBottom) { bestBottom = r.bottom; best = editables[i]; }
    }
    return best;
  }

  function findComposerBox(composer) {
    var el = composer, vh = window.innerHeight;
    for (var i = 0; i < 6 && el && el.parentElement; i++) {
      var r = el.getBoundingClientRect();
      if (r.width >= 280 && r.height >= 24 && r.height < vh * 0.45) return { el: el, rect: r };
      el = el.parentElement;
    }
    return el ? { el: el, rect: el.getBoundingClientRect() } : null;
  }

  function anchor(host) {
    var composer = findComposer();
    if (!composer) { floatFallback(host); return; }
    var box = findComposerBox(composer);
    if (!box) { floatFallback(host); return; }
    state.anchorEl = box.el;

    var parent = box.el.parentElement;
    if (parent && parent !== host && getComputedStyle(box.el).position !== 'fixed') {
      if (host.parentElement !== parent || host.nextElementSibling !== box.el) {
        try { parent.insertBefore(host, box.el); } catch (e) {}
      }
      state.mode = 'embed';
      host.style.position = 'relative';
      host.style.left = host.style.right = host.style.bottom = host.style.top = 'auto';
      var pr = parent.getBoundingClientRect();
      var padL = parseFloat(getComputedStyle(parent).paddingLeft) || 0;
      var padR = parseFloat(getComputedStyle(parent).paddingRight) || 0;
      var w = box.rect.width, leftOff = box.rect.left - (pr.left + padL);
      var maxW = pr.width - padL - padR;
      host.style.width = Math.max(280, Math.min(w, maxW)) + 'px';
      host.style.marginLeft = Math.max(0, leftOff) + 'px';
      host.style.marginBottom = '8px';
      return;
    }
    floatFallback(host);
  }

  function floatFallback(host) {
    state.mode = 'float';
    var composer = findComposer();
    var r = composer ? findComposerBox(composer) : null;
    var rect = r ? r.rect : null;
    if (host.parentElement !== document.body && host.parentElement !== document.documentElement) {
      try { document.body.appendChild(host); } catch (e) {}
    }
    host.style.position = 'fixed';
    host.style.margin = '0';
    var width = rect ? Math.max(320, Math.min(rect.width, window.innerWidth - 32)) : Math.min(620, window.innerWidth - 32);
    host.style.width = width + 'px';
    host.style.left = rect ? Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)) + 'px' : '50%';
    host.style.transform = rect ? 'none' : 'translateX(-50%)';
    host.style.bottom = rect ? Math.max(8, window.innerHeight - rect.top + 8) + 'px' : '96px';
  }

  // -------------------------------------------------------------- render ----

  function subRowHtml(s, d) {
    var statusText = s.running
      ? 'running ' + fmtDur(d.now - (s.startedAt || d.now))
      : (s.status === 'stale' ? 'no signal' : (s.durationMs != null ? fmtDur(s.durationMs) : 'done'));
    var cost = fmtCost(s.cost);
    var tip = (s.description || s.type) + '\n'
      + (s.model || '') + (s.modelId ? '  (' + s.modelId + ')' : '') + '\n'
      + s.requests + ' requests, ' + s.toolCalls + ' tool calls, '
      + (s.tokens.total || 0).toLocaleString() + ' tokens'
      + (s.durationMs != null ? ', ran ' + fmtDur(s.durationMs) : '');
    return '<div class="row sub ' + (s.running ? 'running' : '') + '" title="' + esc(tip) + '">'
      + subagentIconMarkup(s)
      + '<span class="type">' + esc(s.type) + '</span>'
      + (s.description ? '<span class="desc">' + esc(s.description) + '</span>' : '<span class="desc"></span>')
      + '<span class="spacer"></span>'
      + (s.model ? '<span class="metric n2">' + esc(s.model) + '</span>' : '')
      + '<span class="metric fg">' + fmtTokens(s.tokens.total) + ' used</span>'
      + (s.toolCalls ? '<span class="metric n3">' + s.toolCalls + ' tools</span>' : '')
      + (cost ? '<span class="metric n3">' + cost + '</span>' : '')
      + '<span class="metric ' + (s.running ? 'fg srunning' : '') + '">' + esc(statusText) + '</span>'
      + '</div>';
  }

  function render() {
    var host = state.hostRef;
    if (!host) return;
    try { if (!host.__zcapMounted || host.__zcapVersion !== VERSION) return; } catch (e) { return; }
    var refs = host.__zcapRefs;
    var panel = host.shadowRoot.querySelector('.panel');
    var d = state.data;

    function hideAll() {
      host.style.display = 'none';
      window.__zcodeAgentPanelMounted = true;
    }

    if (!d || !d.ok || !d.main) {
      if (state.hidden || !state.pinned) {
        if (!d || !d.ok) { window.__zcodeAgentPanelMounted = true; return hideAll(); }
      }
      panel.classList.remove('running', 'err');
      refs.htotals.textContent = '';
      refs.usage.classList.add('hidden');
      refs.rows.innerHTML = '';
      refs.foot.classList.add('hidden');
      refs.donerows.classList.add('hidden');
      refs.empty.textContent = state.error ? state.error : 'No model activity in this chat yet. Ask something and the panel wakes up.';
      refs.empty.classList.remove('hidden');
      host.style.display = 'block';
      window.__zcodeAgentPanelMounted = true;
      return;
    }

    refs.empty.classList.add('hidden');
    var running = d.state === 'running';
    var idleFor = d.lastActivityAt ? (d.now - d.lastActivityAt) : Infinity;
    var hideAt = (d.config && d.config.idleHideMs) || 240000;
    var collapseAt = (d.config && d.config.idleCollapseMs) || 20000;

    if (state.hidden || (!running && idleFor > hideAt && !state.pinned)) return hideAll();

    panel.classList.toggle('running', running);
    panel.classList.toggle('err', !!d.main.error);
    panel.classList.toggle('light', detectLight());
    var w = host.clientWidth || window.innerWidth;
    panel.classList.toggle('narrow1', w < 720);
    panel.classList.toggle('narrow2', w < 600);
    panel.classList.toggle('narrow3', w < 500);
    panel.classList.toggle('narrow4', w < 420);
    host.style.display = 'block';

    var m = d.main;
    var t = d.totals || { tokens: m.tokens, subagents: 0, runningSubagents: 0, doneSubagents: 0 };

    // Header: chat totals.
    var hTotals = fmtTokens(t.tokens.total) + ' tokens used';
    var hDur = m.durationMs != null ? fmtDur(m.durationMs) : null;
    if (hDur && hDur !== '-') hTotals += ' · ' + hDur;
    if (t.cost != null) hTotals += ' · ' + fmtCost(t.cost);
    if (t.subagents) hTotals += ' · ' + t.subagents + ' subagent' + (t.subagents > 1 ? 's' : '');
    refs.htotals.textContent = hTotals;
    refs.htotals.title = 'tokens used by the whole chat, main agent + subagents: '
      + (t.tokens.input || 0).toLocaleString() + ' input (' + (t.tokens.cacheRead || 0).toLocaleString() + ' cached) + '
      + (t.tokens.output || 0).toLocaleString() + ' output'
      + (t.tokens.reasoning ? ' (' + t.tokens.reasoning.toLocaleString() + ' reasoning)' : '');

    // Header: context usage (burned vs available).
    if (m.context && m.context.pct != null) {
      var fill = refs.ctxfill;
      var bar = refs.ctxbar;
      fill.style.width = (m.context.overLimit ? 100 : m.context.pct) + '%';
      bar.classList.toggle('warn', !m.context.overLimit && m.context.pct >= 65 && m.context.pct < 85);
      bar.classList.toggle('hot', m.context.overLimit || m.context.pct >= 85);
      var ctxLeft = (m.context.limit != null && m.context.used != null) ? Math.max(0, m.context.limit - m.context.used) : null;
      refs.ctxpct.innerHTML = m.context.overLimit
        ? 'full'
        : Math.round(m.context.pct) + '% used<span class="pctfree">' + (ctxLeft != null ? ' · ' + fmtTokens(ctxLeft) + ' left' : ' · ' + Math.round(m.context.availablePct) + '% free') + '</span>';
      refs.usage.title = m.context.overLimit
        ? 'context window: the last request carried ' + (m.context.used || 0).toLocaleString() + ' tokens, more than the '
          + (m.context.limit || 0).toLocaleString() + ' limit set in panel-config.json, so the percentage cannot be trusted. '
          + 'Largest prompt seen this chat: ' + (m.context.observedMax || 0).toLocaleString() + ' tokens. Raise contextLimits for this model to fix it.'
        : 'context window: ' + (m.context.used || 0).toLocaleString() + ' of ' + (m.context.limit || 0).toLocaleString()
          + ' tokens used (' + m.context.pct + '%), '
          + (ctxLeft != null ? fmtTokens(ctxLeft) + ' tokens left (' + m.context.availablePct + '% free)' : m.context.availablePct + '% still available');
      refs.usage.classList.remove('hidden');
    } else refs.usage.classList.add('hidden');

    // Main agent row.
    var effort = '';
    if (m.effort) {
      effort = '<span class="chip ' + m.effort.key + '" title="reasoning effort">' + esc(m.effort.label) + '</span>';
    }
    var mCost = fmtCost(m.cost);
    var mainDur = (running && m.turn && m.turn.startedAt) ? (d.now - m.turn.startedAt) : m.durationMs;
    var freshIn = Math.max(0, (m.tokens.input || 0) - (m.tokens.cacheRead || 0));
    var mainTitle = (m.modelId || '') + '\n'
      + 'new input ' + freshIn.toLocaleString() + ' · output ' + (m.tokens.output || 0).toLocaleString()
      + ' · cache reads ' + (m.tokens.cacheRead || 0).toLocaleString()
      + (m.tokens.reasoning ? ' · reasoning ' + m.tokens.reasoning.toLocaleString() : '') + '\n'
      + 'session total ' + (m.tokens.total || 0).toLocaleString() + ' tokens used over ' + m.requests + ' requests, '
      + m.toolCalls + ' tool calls'
      + (m.turn ? '\ncurrent turn: ' + m.turn.requests + ' requests, ' + m.turn.toolCalls + ' tools' : '')
      + (m.mode ? '  |  mode ' + m.mode : '');
    refs.rows.innerHTML = '<div class="row main" title="' + esc(mainTitle) + '">'
      + '<span class="mark" style="--d:0s;--e:.7s">' + ICON_MAIN + '</span>'
      + '<span class="name">' + esc(m.label || 'Main agent') + '</span>'
      + effort
      + '<span class="model">' + esc(m.model || 'waiting for the first reply') + '</span>'
      + '<span class="spacer"></span>'
      + (d.runningTools && d.runningTools.length
          ? '<span class="metric fg n2">⚙ ' + esc(d.runningTools.filter(function (x, i, a) { return a.indexOf(x) === i; }).slice(0, 2).join(', ')) + '</span>' : '')
      + '<span class="metric fg">' + fmtTokens(m.tokens.total) + ' used</span>'
      + (mainDur != null ? '<span class="metric">' + fmtDur(mainDur) + '</span>' : '')
      + (mCost ? '<span class="metric fg">' + mCost + '</span>' : '')
      + '<span class="dot" title="' + (running ? 'working' : 'idle') + '"></span>'
      + '</div>';

    // Subagent rows: running first, always visible.
    var subs = d.subagents || [];
    var actives = subs.filter(function (s) { return s.running; });
    var dones = subs.filter(function (s) { return !s.running; });
    var rowsHtml = '';
    for (var i = 0; i < actives.length; i++) rowsHtml += subRowHtml(actives[i], d);
    if (rowsHtml) refs.rows.innerHTML += rowsHtml;

    // Finished subagents: collapsed summary with a Show button.
    if (dones.length) {
      var doneTokens = (t.doneSubagentTokens && t.doneSubagentTokens.total) || 0;
      var doneCost = fmtCost(t.doneSubagentCost);
      refs.donetext.textContent = dones.length + ' done · ' + fmtTokens(doneTokens) + ' used' + (doneCost ? ' · ' + doneCost : '');
      refs.foot.classList.remove('hidden');
      refs.showbtn.textContent = state.showDone ? 'Hide' : 'Show';
      var doneHtml = '';
      if (state.showDone) {
        for (var j = 0; j < dones.length; j++) doneHtml += subRowHtml(dones[j], d);
      }
      refs.donerows.innerHTML = doneHtml;
      refs.donerows.classList.toggle('hidden', !state.showDone);
    } else {
      refs.foot.classList.add('hidden');
      refs.donerows.classList.add('hidden');
    }

    if (running) state.showDone = false;
    else if (idleFor > collapseAt) state.showDone = false;
    window.__zcodeAgentPanelMounted = true;
  }

  // --------------------------------------------------------------- mount ----

  function mount() {
    try {
      var host = buildHost();
      if (!host) return;   // an even newer copy has quarantined this one: stay dormant
      anchor(host);
      render();
    } catch (e) {
      state.error = 'panel error: ' + e.message;
    }
  }

  window.__zcodeAgentPanelEnsure = function () { try { mount(); } catch (e) {} };

  window.__ZCODE_PANEL_FEED = function (data) {
    state.data = data;
    state.error = null;
    try { mount(); } catch (e) {}
  };
  window.__ZCODE_PANEL_ERROR = function (msg) { state.error = msg || 'telemetry unavailable'; try { render(); } catch (e) {} };

  function poll() {
    if (PUSH_ONLY) return;
    fetch(BASE + '/api/telemetry?session=auto', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) { window.__ZCODE_PANEL_FEED(d); })
      .catch(function () { window.__ZCODE_PANEL_ERROR('daemon not reachable at ' + BASE); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { mount(); poll(); });
  else { mount(); poll(); }
  if (!PUSH_ONLY) setInterval(poll, 1000);

  // Watchdog: re-anchor on layout shifts and re-mount if React removed the host.
  setInterval(function () { try { mount(); } catch (e) {} }, 1200);
  window.addEventListener('resize', function () { try { mount(); } catch (e) {} });
  var reprobe = 0;
  setInterval(function () {
    reprobe = (reprobe + 1) % 6;
    if (reprobe === 0 && state.hostRef && state.hostRef.isConnected && state.anchorEl && state.anchorEl.isConnected) {
      try { anchor(state.hostRef); } catch (e) {}
    }
  }, 1000);
})();

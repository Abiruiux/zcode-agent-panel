#!/usr/bin/env node
'use strict';
/**
 * Push the current panel.js into every open ZCode window, right now, without
 * restarting ZCode.
 *
 *   node apply-panel.js              apply + report
 *   node apply-panel.js --probe      report only, change nothing
 *   node apply-panel.js --shot live.png   apply, then save a screenshot of the
 *                                         panel area of every attached window
 *
 * Why this exists: the daemon injects panel.js only once per page load, and
 * leaves a healthy panel alone afterwards. After editing panel.js, the version
 * guard alone cannot help until the file is evaluated again. This script does
 * that over the same DevTools connection the daemon uses, and the guard in
 * panel.js then retires the older instance in place.
 *
 * Restarting the daemon is still worthwhile after editing panel.js: the daemon
 * registers the source it reads at attach time for future page loads, so a
 * fresh ZCode window gets the new build without running this script.
 *
 * No dependencies: Node 22+ (fetch + WebSocket).
 */

const fs = require('fs');
const path = require('path');

const SELF_DIR = __dirname;
const PANEL_JS = path.join(SELF_DIR, 'panel.js');
const RUNTIME_FILE = path.join(SELF_DIR, 'panel-runtime.json');

const argv = process.argv.slice(2);
const PROBE_ONLY = argv.includes('--probe');
const shotAt = argv.indexOf('--shot');
const SHOT = shotAt !== -1 ? argv[shotAt + 1] : null;

function readPort() {
  try { return JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8')).port; } catch { return 4748; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpPort() {
  let health;
  try {
    health = await (await fetch(`http://127.0.0.1:${readPort()}/api/health`)).json();
  } catch (e) {
    throw new Error(`daemon not reachable on port ${readPort()} (is the panel daemon running?)`);
  }
  if (!health.cdpPort) {
    throw new Error('ZCode has no DevTools port right now: quit ZCode from the tray and reopen it from the patched shortcut');
  }
  return health.cdpPort;
}

class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('connect timeout')), 8000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = (e) => { clearTimeout(timer); reject(new Error('websocket error')); };
      ws.onmessage = (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message || 'cdp error')); else res(msg.result);
        }
      };
    });
  }
  send(method, params, timeoutMs = 10000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ' timed out')); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, returnByValue) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: !!returnByValue, awaitPromise: false });
    if (res && res.exceptionDetails) throw new Error(res.exceptionDetails.text || 'page exception');
    return res && res.result ? res.result.value : undefined;
  }
  close() { try { this.ws.close(); } catch {} }
}

const PROBE = `JSON.stringify({
  version: window.__zcodeAgentPanelVersion,
  ready: document.readyState,
  panels: Array.from(document.querySelectorAll('[data-zcode-agent-panel]')).map(function (h) {
    var out = { id: h.id, visible: false, icons: -1, rows: -1, version: null, parent: null };
    out.parent = h.parentElement ? (h.parentElement.tagName + '.' + (h.parentElement.className || '').slice(0, 30)) : null;
    try { out.version = h.__zcapVersion; } catch (e) { out.version = 'RETIRED'; }
    try {
      out.visible = getComputedStyle(h).display !== 'none' && h.getBoundingClientRect().height > 0;
      if (h.shadowRoot) {
        out.icons = h.shadowRoot.querySelectorAll('svg').length;
        out.rows = h.shadowRoot.querySelectorAll('.row').length;
      }
    } catch (e) {}
    return out;
  })
})`;

async function main() {
  const port = await cdpPort();
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const pages = (targets || []).filter((t) => t && t.type === 'page' && t.webSocketDebuggerUrl);
  if (!pages.length) throw new Error('no ZCode window found on the DevTools port');

  const src = fs.readFileSync(PANEL_JS, 'utf8');
  const wrapped = 'window.__ZCODE_PANEL_BASE=' + JSON.stringify('http://127.0.0.1:' + readPort()) + ';\n'
    + 'window.__ZCODE_PANEL_PUSH_ONLY=true;\n' + src;

  for (const t of pages) {
    const label = (t.title || t.url || 'page').slice(0, 60);
    const cdp = new Cdp(t.webSocketDebuggerUrl);
    try {
      await cdp.connect();
      if (!PROBE_ONLY) {
        await cdp.evaluate(wrapped);
        await sleep(350); // let the first render pass run
      }
      const raw = await cdp.evaluate(PROBE, true);
      const state = JSON.parse(raw);
      const live = (state.panels || []).filter((p) => p.visible);
      const zombie = (state.panels || []).filter((p) => !p.visible);
      console.log(`[${label}] panel version ${state.version}`
        + ` | live panel: ${live.map((p) => p.id + ' (' + p.rows + ' rows, ' + p.icons + ' icons)').join(', ') || 'none'}`
        + (zombie.length ? ` | retired: ${zombie.map((p) => p.id).join(', ')}` : ''));

      if (SHOT) {
        const rectRaw = await cdp.evaluate(`(function () {
          var h = Array.from(document.querySelectorAll('[data-zcode-agent-panel]'))
            .filter(function (x) { return x.getBoundingClientRect().height > 0; })[0];
          if (!h) return null;
          var r = h.getBoundingClientRect();
          var pad = 26;
          return JSON.stringify({
            x: Math.max(0, Math.floor(r.x - pad)), y: Math.max(0, Math.floor(r.y - pad)),
            width: Math.ceil(r.width + pad * 2), height: Math.ceil(r.height + pad * 2)
          });
        })()`, true);
        if (rectRaw) {
          const shot = await cdp.send('Page.captureScreenshot', {
            format: 'png', clip: Object.assign(JSON.parse(rectRaw), { scale: 2 }),
          });
          fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
          console.log(`[${label}] screenshot saved to ${SHOT}`);
        } else {
          console.log(`[${label}] no visible panel to screenshot`);
        }
      }
    } catch (e) {
      console.error(`[${label}] failed: ${e.message}`);
    } finally {
      cdp.close();
    }
  }
}

main().catch((e) => { console.error('apply-panel failed:', e.message); process.exit(1); });

#!/usr/bin/env node
'use strict';
/**
 * ZCode Agent Panel daemon.
 *
 * Serves the panel UI and a telemetry API on 127.0.0.1, and injects the panel
 * into the ZCode desktop renderer (above the chat composer) over the Chrome
 * DevTools Protocol, the same technique the Antigravity Agent Panel uses.
 *
 * Telemetry comes from ZCode's own local data, read-only:
 *   - <zcode>/cli/db/db.sqlite            -> model_usage, session (authoritative tokens)
 *   - <zcode>/cli/log/zcode-<date>.jsonl  -> live turn / model / tool events
 *   - <zcode>/cli/agents/<session>/agent_<id>/metadata.json -> subagent registry
 *
 * Zero dependencies. Node >= 22.5 for the built-in node:sqlite; without it the
 * panel still works from the live event log alone.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* optional */ }

// Resilience: never crash on transient errors.
process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});
if (process.stdout && process.stdout.on) process.stdout.on('error', () => {});
if (process.stderr && process.stderr.on) process.stderr.on('error', () => {});

const SELF_DIR = __dirname;
const HOME = os.homedir();
const ZCODE_HOME = process.env.ZCODE_HOME || path.join(HOME, '.zcode');
const DB_PATH = path.join(ZCODE_HOME, 'cli', 'db', 'db.sqlite');
const LOG_DIR = path.join(ZCODE_HOME, 'cli', 'log');
const AGENTS_DIR = path.join(ZCODE_HOME, 'cli', 'agents');
const RUNTIME_FILE = path.join(SELF_DIR, 'panel-runtime.json');
const DAEMON_LOG = path.join(SELF_DIR, 'daemon.log');
const PANEL_JS = path.join(SELF_DIR, 'panel.js');

function appDataDir() {
  if (process.platform === 'win32') return process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
  if (process.platform === 'darwin') return path.join(HOME, 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
}
// Chromium writes DevToolsActivePort into the profile directory. ZCode
// overrides Electron's default paths and keeps its Chromium profile in
// `ZCode/session`, so the file lands there; older or stock layouts put it
// directly in `ZCode/`. Check both, honouring the env override first.
const DEVTOOLS_PORT_FILES = [
  process.env.ZCODE_DEVTOOLS_PORT_FILE,
  path.join(appDataDir(), 'ZCode', 'session', 'DevToolsActivePort'),
  path.join(appDataDir(), 'ZCode', 'DevToolsActivePort'),
].filter(Boolean);

// ---------------------------------------------------------------- config ----

function loadConfig() {
  const defaults = {
    port: 4748,
    refreshMs: 1000,
    idleCollapseMs: 20000,      // collapse the subagent list this long after the last event
    idleHideMs: 240000,         // hide the whole panel this long after the last event
    maxSubagentRows: 6,
    contextLimits: { default: 200000, byModel: {} },
    pricing: { byModel: {} },
    theme: 'auto',
  };
  try {
    const user = JSON.parse(fs.readFileSync(path.join(SELF_DIR, 'panel-config.json'), 'utf8'));
    return {
      ...defaults, ...user,
      contextLimits: { ...defaults.contextLimits, ...(user.contextLimits || {}) },
      pricing: { ...defaults.pricing, ...(user.pricing || {}) },
    };
  } catch { return defaults; }
}

const CONFIG = loadConfig();
if (process.env.ZCODE_PANEL_PORT) CONFIG.port = parseInt(process.env.ZCODE_PANEL_PORT, 10) || CONFIG.port;

// ------------------------------------------------------------------ utils ----

let logCap = 0;
function log(...parts) {
  try {
    const line = `[${new Date().toISOString()}] ${parts.join(' ')}\n`;
    fs.appendFileSync(DAEMON_LOG, line);
    logCap += line.length;
    if (logCap > 512 * 1024) {
      const tail = fs.readFileSync(DAEMON_LOG, 'utf8').split('\n').slice(-400).join('\n');
      fs.writeFileSync(DAEMON_LOG, tail);
      logCap = tail.length;
    }
  } catch {}
}

function nowMs() { return Date.now(); }

const BRANDS = [
  [/deep\s+seek/gi, 'DeepSeek'],
  [/open\s+ai/gi, 'OpenAI'],
  [/z\s+ai/gi, 'Z.ai'],
];

function prettyModel(modelId) {
  if (!modelId) return 'unknown model';
  let s = String(modelId).split('/').pop() || String(modelId);
  s = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [re, to] of BRANDS) s = s.replace(re, to);
  const words = [];
  for (const w of s.split(' ')) {
    if (!w) continue;
    if (words.length && words[words.length - 1].toLowerCase() === w.toLowerCase()) continue;
    words.push(w);
  }
  const out = words.join(' ');
  return out.length > 56 ? out.slice(0, 55) + '…' : out;
}

function effortFromVariant(variant) {
  const v = String(variant || '').toLowerCase();
  if (/^(max|high|heavy|xhigh|uber)$/.test(v)) return { key: 'heavy', label: v === 'max' ? 'max' : v };
  if (/^(off|none|disabled|false|0)$/.test(v)) return { key: 'off', label: 'plain' };
  if (/^(low|light|minimal)$/.test(v)) return { key: 'light', label: v };
  if (/^(medium|enabled|true|on|1|default)$/.test(v) || !v) return { key: 'medium', label: v || 'medium' };
  return { key: 'medium', label: v };
}

function contextLimitFor(modelId) {
  const map = CONFIG.contextLimits.byModel || {};
  if (modelId && map[modelId] != null) return Number(map[modelId]);
  if (modelId) {
    for (const [k, v] of Object.entries(map)) {
      if (k && modelId.toLowerCase().includes(k.toLowerCase())) return Number(v);
    }
  }
  return Number(CONFIG.contextLimits.default) || 200000;
}

function priceFor(modelId) {
  const map = CONFIG.pricing && CONFIG.pricing.byModel ? CONFIG.pricing.byModel : {};
  if (!modelId) return null;
  if (map[modelId]) return map[modelId];
  for (const [k, v] of Object.entries(map)) {
    if (k && modelId.toLowerCase().includes(k.toLowerCase())) return v;
  }
  return null;
}

function costOf(modelId, input, output, cacheRead) {
  const p = priceFor(modelId);
  if (!p || typeof p !== 'object') return null;
  const inRate = Number(p.input) || 0;
  const outRate = Number(p.output) || 0;
  const cacheRate = p.cacheRead != null ? Number(p.cacheRead) : inRate * 0.1;
  const fresh = Math.max(0, (input || 0) - (cacheRead || 0));
  const cost = (fresh * inRate + (cacheRead || 0) * cacheRate + (output || 0) * outRate) / 1e6;
  return Number.isFinite(cost) ? cost : null;
}

function sumTokens(rows) {
  const t = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheCreation: 0, total: 0 };
  for (const r of rows) {
    t.input += r.input_tokens || 0;
    t.output += r.output_tokens || 0;
    t.reasoning += r.reasoning_tokens || 0;
    t.cacheRead += r.cache_read_input_tokens || 0;
    t.cacheCreation += r.cache_creation_input_tokens || 0;
    t.total += (r.computed_total_tokens != null ? r.computed_total_tokens : (r.input_tokens || 0) + (r.output_tokens || 0));
  }
  return t;
}

// ------------------------------------------------------------- log tailer ----

/**
 * Tails the newest ZCode log file (zcode-<date>.jsonl) for live signals:
 * current turn, in-flight model requests and tool calls, subagent activity.
 */
class LogTailer {
  constructor() {
    this.file = null;
    this.offset = 0;
    this.size = 0;
    this.events = [];
    this.lastSessionId = null;
    this.agentActivity = new Map(); // agentId -> { type, lastAt, lastEvent }
    this.currentTurn = new Map();   // sessionId -> { turnId, startedAt }
    this.modelStarts = new Map();   // requestId -> { at, agentId }
    this.toolStarts = new Map();    // tool call id -> { at, agentId, name }
    this.lastEventAt = 0;
    this.errors = 0;
  }

  newestLogFile() {
    try {
      const files = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith('.jsonl'));
      let best = null, bestT = 0;
      for (const f of files) {
        const p = path.join(LOG_DIR, f);
        const st = fs.statSync(p);
        if (st.mtimeMs > bestT) { bestT = st.mtimeMs; best = p; }
      }
      return best;
    } catch { return null; }
  }

  poll() {
    const f = this.newestLogFile();
    if (!f) return;
    if (f !== this.file) { this.file = f; this.offset = 0; this.size = 0; }
    let st;
    try { st = fs.statSync(f); } catch { return; }
    if (st.size < this.size) this.offset = 0;
    this.size = st.size;
    if (st.size <= this.offset) return;
    let fd;
    try {
      fd = fs.openSync(f, 'r');
      const len = Math.min(st.size - this.offset, 512 * 1024);
      const buf = Buffer.alloc(len);
      const read = fs.readSync(fd, buf, 0, len, this.offset);
      this.offset += read;
      const lines = buf.toString('utf8', 0, read).split('\n');
      lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        this.ingest(ev);
      }
    } catch (e) {
      this.errors++;
      if (this.errors % 50 === 1) log('log tail error:', e.message);
    } finally {
      if (fd != null) { try { fs.closeSync(fd); } catch {} }
    }
  }

  ingest(ev) {
    const at = Date.parse(ev.timestamp || '') || nowMs();
    const name = ev.event || ev.type || '';
    const ctx = ev.context || {};
    const sessionId = ev.sessionId || ctx.sessionId || null;
    const agentId = ctx.agentId || null;
    this.lastEventAt = at;

    this.events.push({ at, name, sessionId, agentId, turnId: ev.turnId || ctx.turnId || null });
    if (this.events.length > 400) this.events.splice(0, this.events.length - 400);

    const isSubagentSession = typeof sessionId === 'string' && sessionId.includes('subagent');
    if (sessionId && !isSubagentSession) this.lastSessionId = sessionId;

    if (agentId) {
      const prev = this.agentActivity.get(agentId) || {};
      this.agentActivity.set(agentId, {
        type: ctx.agentType || prev.type || null,
        lastAt: at,
        lastEvent: name,
        lastSessionId: sessionId || prev.lastSessionId || null,
      });
    }

    if (name === 'turn.phase.started' && sessionId) {
      this.currentTurn.set(sessionId, { turnId: ev.turnId || null, startedAt: at, phase: ctx.phase || null });
    } else if (name === 'turn.phase.completed' && sessionId) {
      const cur = this.currentTurn.get(sessionId);
      if (cur && (!ev.turnId || ev.turnId === cur.turnId)) this.currentTurn.set(sessionId, { ...cur, lastPhaseAt: at });
    } else if (name === 'model.request.started') {
      const key = ctx.queryId || ev.requestId || ev.traceId || String(at);
      this.modelStarts.set(key, { at, agentId: agentId || null });
    } else if (name === 'model.request.completed') {
      const key = ctx.queryId || ev.requestId || ev.traceId;
      if (key) this.modelStarts.delete(key);
    } else if (name === 'tool.call.started') {
      const key = ctx.toolCallId || ctx.callId || ctx.toolUseId || (ctx.toolName || 'tool') + '@' + at;
      this.toolStarts.set(key, { at, agentId: agentId || null, name: ctx.toolName || null });
    } else if (name === 'tool.call.completed' || name === 'tool.call.failed') {
      const key = ctx.toolCallId || ctx.callId || ctx.toolUseId;
      if (key) this.toolStarts.delete(key);
      else {
        const nm = ctx.toolName;
        for (const [k, v] of this.toolStarts) { if (!nm || v.name === nm) { this.toolStarts.delete(k); break; } }
      }
    }
  }

  live() {
    const key = this.lastSessionId;
    const turn = key ? this.currentTurn.get(key) : null;
    const cutoff = nowMs() - 5 * 60 * 1000;
    for (const [k, v] of this.toolStarts) if (v.at < cutoff) this.toolStarts.delete(k);
    return {
      sessionId: key,
      turnId: turn ? turn.turnId : null,
      turnStartedAt: turn ? turn.startedAt : null,
      lastEventAt: this.lastEventAt || null,
      inFlightModelRequests: this.modelStarts.size,
      inFlightToolCalls: this.toolStarts.size,
      runningTools: [...this.toolStarts.values()].map((v) => v.name).filter(Boolean),
      agentActivity: this.agentActivity,
    };
  }
}

// --------------------------------------------------------- agents registry ----

function readAgentsRegistry() {
  const out = [];
  let parents = [];
  try { parents = fs.readdirSync(AGENTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return out; }
  for (const parent of parents) {
    const parentDir = path.join(AGENTS_DIR, parent.name);
    let agents = [];
    try { agents = fs.readdirSync(parentDir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { continue; }
    for (const a of agents) {
      const metaPath = path.join(parentDir, a.name, 'metadata.json');
      try {
        const st = fs.statSync(metaPath);
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        out.push({
          agentId: meta.agentId || a.name,
          childSessionId: meta.childSessionId || null,
          parentSessionId: meta.parentSessionId || parent.name,
          type: meta.profileId || (meta.profileSnapshot && meta.profileSnapshot.name) || 'agent',
          color: (meta.profileSnapshot && meta.profileSnapshot.color) || null,
          description: meta.description || '',
          status: meta.status || 'unknown',
          createdAt: Date.parse(meta.createdAt || '') || st.birthtimeMs || st.mtimeMs,
          updatedAt: Date.parse(meta.updatedAt || '') || st.mtimeMs,
          running: /running|active/i.test(String(meta.status || '')),
        });
      } catch { /* unreadable metadata, skip */ }
    }
  }
  return out;
}

// -------------------------------------------------------------------- DB ----

class DbReader {
  constructor() {
    this.db = null;
    this.lastTry = 0;
    this.ok = false;
    this.error = null;
  }

  open() {
    if (this.db || !DatabaseSync) return;
    if (nowMs() - this.lastTry < 5000) return;
    this.lastTry = nowMs();
    try {
      this.db = new DatabaseSync(DB_PATH, { readOnly: true });
      this.db.prepare('SELECT 1').get();
      this.ok = true;
      this.error = null;
      log('db opened');
    } catch (e) {
      this.db = null;
      this.ok = false;
      this.error = e.message;
    }
  }

  q(sql, ...params) {
    this.open();
    if (!this.db) return null;
    try {
      return this.db.prepare(sql).all(...params);
    } catch (e) {
      try { this.db.close(); } catch {}
      this.db = null;
      this.ok = false;
      this.error = e.message;
      return null;
    }
  }

  recentSessions(limit = 12) {
    return this.q(
      `SELECT id, parent_id, title, directory, task_type, time_created, time_updated, last_outcome
       FROM session
       WHERE id NOT LIKE 'sess_subagent%'
       ORDER BY time_updated DESC LIMIT ?`, limit) || [];
  }

  sessionById(id) {
    const rows = this.q(`SELECT id, parent_id, title, directory, task_type, time_created, time_updated FROM session WHERE id = ?`, id);
    return rows && rows[0] || null;
  }

  usageForSession(sessionId) {
    return this.q(`SELECT * FROM model_usage WHERE session_id = ? ORDER BY started_at ASC`, sessionId) || [];
  }

  usageForSubagent(childSessionId) {
    return this.q(`SELECT * FROM model_usage WHERE session_id = ? ORDER BY started_at ASC`, childSessionId) || [];
  }

  usageByQuerySource(sessionId, source) {
    return this.q(`SELECT * FROM model_usage WHERE session_id = ? AND query_source = ? ORDER BY started_at ASC`, sessionId, source) || [];
  }
}

// -------------------------------------------------------------- telemetry ----

const tailer = new LogTailer();
const db = new DbReader();

let lastAgentScan = 0;
let agentCache = [];
function agents() {
  if (nowMs() - lastAgentScan > 3000) {
    lastAgentScan = nowMs();
    agentCache = readAgentsRegistry();
  }
  return agentCache;
}

function activeSessionInfo() {
  const live = tailer.live();
  const sessions = db.recentSessions(12);
  let s = null;
  if (live.sessionId) s = sessions.find((x) => x.id === live.sessionId) || db.sessionById(live.sessionId);
  if (!s) {
    const recent = sessions.find((x) => nowMs() - (x.time_updated || 0) < 30 * 60 * 1000);
    s = recent || sessions[0] || null;
  }
  return { session: s, live, sessions };
}

function buildTelemetry(forcedSessionId) {
  const { session: detected, live, sessions } = activeSessionInfo();
  // Prefer the session the renderer reports it is showing (fresh for 30 s).
  const domPin = (injector.domSessionId && nowMs() - injector.domSessionIdAt < 30000) ? injector.domSessionId : null;
  const pin = (forcedSessionId && forcedSessionId !== 'auto') ? forcedSessionId : domPin;
  let session = detected;
  if (pin) session = db.sessionById(pin) || detected;
  const sessionId = session ? session.id : null;

  const result = {
    ok: true,
    now: nowMs(),
    sources: {
      db: { ok: db.ok, error: db.error, path: DB_PATH },
      log: { file: tailer.file ? path.basename(tailer.file) : null, lastEventAt: live.lastEventAt },
      agents: agents().length,
    },
    config: {
      refreshMs: CONFIG.refreshMs,
      idleHideMs: CONFIG.idleHideMs,
      idleCollapseMs: CONFIG.idleCollapseMs,
      maxSubagentRows: CONFIG.maxSubagentRows,
      theme: CONFIG.theme,
    },
    session: session ? {
      id: session.id,
      title: session.title || '',
      directory: session.directory || '',
      taskType: session.task_type || '',
      startedAt: session.time_created || null,
      updatedAt: session.time_updated || null,
    } : null,
    recentSessions: sessions.map((x) => ({
      id: x.id, title: x.title || '', directory: x.directory || '', updatedAt: x.time_updated || null,
    })),
    state: 'idle',
    main: null,
    subagents: [],
    sidecars: [],
    totals: null,
  };

  if (!sessionId) return result;

  // Split the session's model traffic: main agent, sidecars (title, compaction).
  const mainRows = [];
  const sidecarRows = [];
  if (db.ok) {
    for (const r of db.usageForSession(sessionId)) {
      if (!r.query_source || r.query_source === 'main_turn') mainRows.push(r);
      else if (r.query_source !== 'subagent') sidecarRows.push(r);
    }
  }

  // Subagents: registry (files) first, then child sessions as a fallback.
  const registry = agents().filter((a) => !a.parentSessionId || a.parentSessionId === sessionId || a.parentSessionId === 'unknown');
  if (db.ok && sessionId) {
    const children = db.q('SELECT id, title FROM session WHERE parent_id = ?', sessionId) || [];
    for (const c of children) {
      if (!/^sess_subagent_/.test(c.id)) continue;
      if (registry.some((a) => a.childSessionId === c.id || ('sess_subagent_' + a.agentId) === c.id)) continue;
      registry.push({
        agentId: c.id.replace(/^sess_subagent_/, ''),
        childSessionId: c.id,
        parentSessionId: sessionId,
        type: 'agent',
        color: null,
        description: c.title || 'subagent',
        status: 'unknown',
        createdAt: 0,
        updatedAt: 0,
        running: false,
      });
    }
  }

  const subagents = [];
  for (const a of registry) {
    let rows = [];
    if (db.ok && a.childSessionId) rows = db.usageForSubagent(a.childSessionId);
    if (!rows.length && db.ok) {
      const orphan = db.usageByQuerySource(sessionId, 'subagent');
      rows = orphan.filter((r) => {
        const t = r.started_at || 0;
        return t >= a.createdAt - 15 * 1000 && (!a.updatedAt || t <= a.updatedAt + 60 * 1000 || a.running);
      });
    }
    const activity = live.agentActivity.get(a.agentId);
    const lastActivity = Math.max(a.updatedAt || 0, activity ? activity.lastAt : 0);
    const domRunning = injector.domRunningSubagents.indexOf(a.agentId) !== -1
      || injector.domRunningSubagents.indexOf('sess_subagent_' + a.agentId) !== -1;
    const running = domRunning || (a.running && (nowMs() - lastActivity < 3 * 60 * 1000));
    const latest = rows.length ? rows[rows.length - 1] : null;
    const first = rows.length ? rows[0] : null;
    const tokens = sumTokens(rows);
    subagents.push({
      agentId: a.agentId,
      type: a.type,
      color: a.color,
      description: a.description,
      status: running ? 'running' : (a.running ? 'stale' : (rows.length ? 'done' : 'unknown')),
      running,
      model: latest ? prettyModel(latest.model_id) : null,
      modelId: latest ? latest.model_id : null,
      effort: latest ? effortFromVariant(latest.variant) : null,
      requests: rows.length,
      toolCalls: rows.reduce((n, r) => n + (r.tool_call_count || 0), 0),
      tokens,
      startedAt: a.createdAt || (first ? first.started_at : null),
      lastActivityAt: lastActivity || null,
      durationMs: first && latest ? Math.max(0, (latest.completed_at || lastActivity || latest.started_at) - first.started_at) : null,
      cost: costOf(latest ? latest.model_id : null, tokens.input, tokens.output, tokens.cacheRead),
      error: rows.some((r) => r.status && r.status !== 'completed') || false,
    });
  }
  subagents.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  result.subagents = subagents;

  // Main agent.
  const latestMain = mainRows.length ? mainRows[mainRows.length - 1] : null;
  const tokens = sumTokens(mainRows);
  const limit = contextLimitFor(latestMain && latestMain.model_id);
  const contextOf = (r) => r
    ? (r.computed_total_tokens != null ? r.computed_total_tokens
      : (r.provider_total_tokens != null ? r.provider_total_tokens
        : (r.input_tokens || 0) + (r.output_tokens || 0)))
    : null;
  const contextTokens = contextOf(latestMain);
  // Largest prompt this session has actually carried: a request that succeeded
  // proves the real window is at least this big.
  let observedMax = 0;
  for (const r of mainRows) {
    const c = contextOf(r);
    if (c && c > observedMax) observedMax = c;
  }
  const turnId = latestMain ? latestMain.turn_id : null;
  const turnRows = turnId ? mainRows.filter((r) => r.turn_id === turnId) : [];
  const turnTokens = sumTokens(turnRows);
  const firstStart = mainRows.length ? mainRows[0].started_at : null;
  const lastEnd = mainRows.length ? mainRows[mainRows.length - 1].completed_at : null;
  const fresh = live.lastEventAt && nowMs() - live.lastEventAt < Math.max(6000, CONFIG.idleCollapseMs);
  const runningSubs = subagents.filter((s) => s.running).length;
  const busy = live.inFlightModelRequests > 0 || live.inFlightToolCalls > 0 || runningSubs > 0;

  result.main = {
    label: 'Main agent',
    model: latestMain ? prettyModel(latestMain.model_id) : null,
    modelId: latestMain ? latestMain.model_id : null,
    providerId: latestMain ? latestMain.provider_id : null,
    mode: latestMain ? latestMain.mode : null,
    agent: latestMain ? latestMain.agent : null,
    effort: latestMain ? effortFromVariant(latestMain.variant) : null,
    context: contextTokens != null ? {
      used: contextTokens,
      limit,
      pct: limit ? Math.min(100, Math.round((contextTokens / limit) * 1000) / 10) : null,
      availablePct: limit ? Math.max(0, Math.round((1 - contextTokens / limit) * 1000) / 10) : null,
      observedMax,
      overLimit: limit ? contextTokens > limit : false,
    } : null,
    tokens,
    turn: turnId ? {
      id: turnId,
      requests: turnRows.length,
      toolCalls: turnRows.reduce((n, r) => n + (r.tool_call_count || 0), 0),
      tokens: turnTokens,
      startedAt: turnRows.length ? turnRows[0].started_at : null,
    } : null,
    requests: mainRows.length,
    toolCalls: mainRows.reduce((n, r) => n + (r.tool_call_count || 0), 0),
    startedAt: firstStart,
    lastCompletedAt: lastEnd,
    durationMs: firstStart && lastEnd ? Math.max(0, lastEnd - firstStart) : null,
    cost: costOf(latestMain && latestMain.model_id, tokens.input, tokens.output, tokens.cacheRead),
    error: mainRows.some((r) => r.status && r.status !== 'completed') || false,
  };

  // Whole-chat totals (main + subagents) for the header line.
  const activeSubs = subagents.filter((s) => s.running);
  const doneSubs = subagents.filter((s) => !s.running);
  const totalsTokens = {
    input: tokens.input + subagents.reduce((n, s) => n + s.tokens.input, 0),
    output: tokens.output + subagents.reduce((n, s) => n + s.tokens.output, 0),
    cacheRead: tokens.cacheRead + subagents.reduce((n, s) => n + s.tokens.cacheRead, 0),
    reasoning: tokens.reasoning + subagents.reduce((n, s) => n + s.tokens.reasoning, 0),
    total: tokens.total + subagents.reduce((n, s) => n + s.tokens.total, 0),
  };
  const costs = [result.main.cost, ...subagents.map((s) => s.cost)].filter((c) => c != null);
  result.totals = {
    tokens: totalsTokens,
    cost: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
    subagents: subagents.length,
    runningSubagents: activeSubs.length,
    doneSubagents: doneSubs.length,
    doneSubagentTokens: {
      input: doneSubs.reduce((n, s) => n + s.tokens.input, 0),
      output: doneSubs.reduce((n, s) => n + s.tokens.output, 0),
      cacheRead: doneSubs.reduce((n, s) => n + s.tokens.cacheRead, 0),
      reasoning: doneSubs.reduce((n, s) => n + s.tokens.reasoning, 0),
      total: doneSubs.reduce((n, s) => n + s.tokens.total, 0),
    },
    doneSubagentCost: (() => {
      const dc = doneSubs.map((s) => s.cost).filter((c) => c != null);
      return dc.length ? dc.reduce((a, b) => a + b, 0) : null;
    })(),
  };

  // Sidecars (title generation, compaction), counted separately.
  const bySource = new Map();
  for (const r of sidecarRows) {
    const k = r.query_source || 'sidecar';
    if (!bySource.has(k)) bySource.set(k, []);
    bySource.get(k).push(r);
  }
  for (const [k, rows] of bySource) {
    const t = sumTokens(rows);
    result.sidecars.push({ source: k, requests: rows.length, tokens: t, cost: costOf(rows[0].model_id, t.input, t.output, t.cacheRead) });
  }

  result.state = (fresh || busy) ? 'running' : 'idle';
  result.busy = busy;
  result.runningTools = live.runningTools || [];
  result.lastActivityAt = Math.max(
    live.lastEventAt || 0,
    session.updatedAt || 0,
    ...subagents.map((s) => s.lastActivityAt || 0),
    result.main.lastCompletedAt || 0);
  if (busy) result.lastActivityAt = Math.max(result.lastActivityAt, result.now);

  return result;
}

// -------------------------------------------------------------- injection ----

function cdpReadPort() {
  for (const file of DEVTOOLS_PORT_FILES) {
    try {
      const txt = fs.readFileSync(file, 'utf8').trim().split('\n');
      const port = parseInt(txt[0], 10);
      if (Number.isFinite(port) && port > 0) return port;
    } catch { /* try the next candidate */ }
  }
  return null;
}

function cdpList(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/list', timeout: 2500 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve([]); } });
    });
    req.on('timeout', () => { req.destroy(); resolve([]); });
    req.on('error', () => resolve([]));
  });
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = true;
  }

  connect() {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      try {
        const ws = new WebSocket(this.wsUrl);
        this.ws = ws;
        ws.addEventListener('open', () => { this.closed = false; done(true); });
        ws.addEventListener('message', (ev) => {
          let msg;
          try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
          if (msg.id && this.pending.has(msg.id)) {
            const { resolve: r } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            r(msg);
          }
        });
        ws.addEventListener('close', () => { this.closed = true; done(false); });
        ws.addEventListener('error', () => { this.closed = true; done(false); });
      } catch { done(false); }
      setTimeout(() => done(false), 4000);
    });
  }

  send(method, params = {}, timeoutMs = 5000) {
    return new Promise((resolve) => {
      if (!this.ws || this.closed) return resolve(null);
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); resolve(null); }, timeoutMs);
      this.pending.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); } });
      try { this.ws.send(JSON.stringify({ id, method, params })); } catch { clearTimeout(timer); this.pending.delete(id); resolve(null); }
    });
  }

  close() { try { this.ws && this.ws.close(); } catch {} this.closed = true; }
}

class Injector {
  constructor() {
    this.clients = new Map(); // wsUrl -> CdpClient
    this.lastPanelAlive = 0;
    this.lastScan = 0;
    this.lastInjected = new Map();
    this.newDocumentRegistered = new Set();
    this.failures = 0;
    this.domSessionId = null;
    this.domSessionIdAt = 0;
    this.domRunningSubagents = [];
  }

  panelSource() {
    let src = '';
    try { src = fs.readFileSync(PANEL_JS, 'utf8'); } catch { return ''; }
    const base = `http://127.0.0.1:${state.port}`;
    // Push-only: the daemon feeds telemetry over CDP, so the page makes no
    // network requests and CSP / mixed-content rules cannot block the panel.
    return `window.__ZCODE_PANEL_BASE=${JSON.stringify(base)};\nwindow.__ZCODE_PANEL_PUSH_ONLY=true;\n${src}`;
  }

  async scan() {
    if (nowMs() - this.lastScan < 2000) return;
    this.lastScan = nowMs();
    const port = cdpReadPort();
    if (!port) return;
    const targets = await cdpList(port);
    const pages = (targets || []).filter((t) =>
      t && t.type === 'page' && t.webSocketDebuggerUrl &&
      !/^devtools:/.test(t.url || '') && !/^chrome-extension:/.test(t.url || ''));
    if (!pages.length) return;

    const wanted = new Set(pages.map((t) => t.webSocketDebuggerUrl));
    for (const [url, client] of this.clients) {
      if (!wanted.has(url) || client.closed) {
        client.close(); this.clients.delete(url); this.newDocumentRegistered.delete(url); this.lastInjected.delete(url);
      }
    }
    for (const t of pages) {
      const url = t.webSocketDebuggerUrl;
      if (!this.clients.has(url)) {
        const client = new CdpClient(url);
        const ok = await client.connect();
        if (ok) {
          this.clients.set(url, client);
          log('cdp attached:', (t.url || '').slice(0, 60));
        }
      }
      await this.inject(this.clients.get(url), t.url || '');
    }
  }

  async inject(client, pageUrl) {
    if (!client || client.closed) return;
    const src = this.panelSource();
    if (!src) return;
    const last = this.lastInjected.get(client.wsUrl) || 0;
    // Leave a healthy panel alone (its in-page watchdogs re-anchor it); touch
    // the page only right after attach or when it has gone quiet.
    const stale = nowMs() - this.lastPanelAlive > 25000;
    if (!stale && nowMs() - last < 25000) return;
    this.lastInjected.set(client.wsUrl, nowMs());
    try {
      await client.send('Page.enable');
      if (!this.newDocumentRegistered.has(client.wsUrl)) {
        await client.send('Page.addScriptToEvaluateOnNewDocument', { source: src });
        this.newDocumentRegistered.add(client.wsUrl);
      }
      // panel.js is idempotent; re-running the full script just re-mounts the
      // existing instance. Only do that when nothing is mounted yet.
      const rev = await client.send('Runtime.evaluate', {
        expression: 'typeof window.__zcodeAgentPanelEnsure === "function" ? (window.__zcodeAgentPanelEnsure(), true) : false',
        returnByValue: true,
      });
      const revived = !!(rev && rev.result && rev.result.result && rev.result.result.value === true);
      if (!revived) {
        await client.send('Runtime.evaluate', { expression: src, awaitPromise: false, returnByValue: false });
      }
      if (this.failures) log('cdp injection recovered after', this.failures, 'failures');
      this.failures = 0;
    } catch (e) {
      this.failures++;
      if (this.failures % 20 === 1) log('cdp inject failure:', e.message);
    }
  }

  notePanelAlive() { this.lastPanelAlive = nowMs(); }

  /** Push one telemetry snapshot into every attached page. */
  async feed() {
    if (!this.clients.size) return;
    let payload = '';
    try {
      payload = JSON.stringify(buildTelemetry(null))
        .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    } catch (e) { return; }
    const expr = 'window.__ZCODE_PANEL_FEED && window.__ZCODE_PANEL_FEED(' + payload + ')';
    const sends = [];
    for (const client of this.clients.values()) {
      if (client.closed) continue;
      sends.push(client.send('Runtime.evaluate', { expression: expr, awaitPromise: false, returnByValue: false }, 4000));
    }
    await Promise.all(sends);
  }

  /** Ask each page for panel liveness plus the session and subagents the UI is showing. */
  async probe() {
    if (!this.clients.size) return;
    const expr = `(function () {
      var el = document.querySelector('[data-session-id]');
      var out = { m: !!window.__zcodeAgentPanelMounted, s: null, r: [] };
      if (el) {
        out.s = el.getAttribute('data-session-id') || null;
        var raw = el.getAttribute('data-running-subagent-ids');
        if (raw) { try { out.r = JSON.parse(raw) || []; } catch (e) { out.r = String(raw).split(',').filter(Boolean); } }
      }
      return out;
    })()`;
    const sends = [];
    for (const client of this.clients.values()) {
      if (client.closed) continue;
      sends.push((async () => {
        const res = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true }, 4000);
        const v = res && res.result && res.result.result && res.result.result.value;
        if (!v || typeof v !== 'object') return;
        if (v.m === true) this.notePanelAlive();
        if (typeof v.s === 'string' && v.s && v.s !== 'draft') { this.domSessionId = v.s; this.domSessionIdAt = nowMs(); }
        if (Array.isArray(v.r)) this.domRunningSubagents = v.r;
      })());
    }
    await Promise.all(sends);
  }

  loop() { this.scan().catch(() => {}); }
}

const injector = new Injector();

// ---------------------------------------------------------------- server ----

const state = { port: CONFIG.port };

function servePanelJs(res) {
  try {
    const body = fs.readFileSync(PANEL_JS);
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch (e) {
    res.writeHead(500); res.end('panel.js missing: ' + e.message);
  }
}

function serveStandalone(res) {
  const light = CONFIG.theme === 'light';
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>ZCode Agent Panel</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; flex-direction:column;
    font:14px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
    background:#15171c; color:#e8eaf0; }
  body.light { background:#f4f5f7; color:#1d2230; }
  .wrap { width:min(860px, 100%); margin:0 auto; padding:22px 18px 0; flex:1; display:flex; flex-direction:column; }
  header { display:flex; align-items:baseline; gap:10px; margin-bottom:14px; }
  header h1 { font-size:14px; font-weight:600; margin:0; }
  header span { font-size:12px; opacity:.55; }
  .messages { flex:1; display:flex; flex-direction:column; gap:10px; padding-bottom:10px; overflow:auto; }
  .msg { border:1px solid rgba(140,152,180,.22); border-radius:10px; padding:9px 12px; font-size:13px; opacity:.85; max-width:76%; }
  .msg.me { align-self:flex-end; background:rgba(90,140,255,.12); border-color:rgba(90,140,255,.3); }
  .composerRow { padding:10px 0 22px; }
  .composer { border:1px solid rgba(140,152,180,.28); border-radius:14px; padding:11px 13px; background:rgba(255,255,255,.03); }
  body.light .composer { background:rgba(255,255,255,.85); }
  [data-lexical-editor] { outline:none; min-height:22px; }
  .hint { font-size:11px; opacity:.45; margin-top:5px; }
</style></head>
<body${light ? ' class="light"' : ''}>
<div class="wrap">
  <header><h1>ZCode Agent Panel</h1><span>preview - the same panel pins above the ZCode chat box</span></header>
  <div class="messages">
    <div class="msg">This page stands in for the ZCode chat. The panel above the composer is the real widget, fed by live telemetry from ~/.zcode.</div>
    <div class="msg me">show me the agents</div>
    <div class="msg">Main agent plus every subagent, with tokens burned and context left.</div>
  </div>
  <div class="composerRow">
    <div class="composer">
      <div contenteditable="true" data-lexical-editor="true">Ask ZCode anything...</div>
      <div class="hint">Ctrl+Shift+Z toggles the panel</div>
    </div>
  </div>
</div>
<script src="/panel.js"></script>
</body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  if (p === '/' || p === '/index.html') return serveStandalone(res);
  if (p === '/panel.js') return servePanelJs(res);
  if (p === '/api/telemetry') {
    let body = '{"ok":false}';
    try { body = JSON.stringify(buildTelemetry(url.searchParams.get('session'))); } catch (e) { log('telemetry error', e.message); }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(body);
  }
  if (p === '/api/panel-alive') { injector.notePanelAlive(); res.writeHead(204); return res.end(); }
  if (p === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      ok: true, port: state.port, pid: process.pid, db: db.ok, dbError: db.error,
      logFile: tailer.file, cdpPort: cdpReadPort(), attached: injector.clients.size,
      lastPanelAlive: injector.lastPanelAlive || null,
    }));
  }
  if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
  res.writeHead(404); res.end('not found');
});

function listen(port, attempt = 0) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && attempt < 9) {
      log('port', port, 'in use, trying', port + 1);
      listen(port + 1, attempt + 1);
    } else {
      log('server error', e.message);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    state.port = port;
    try { fs.writeFileSync(RUNTIME_FILE, JSON.stringify({ port, pid: process.pid, startedAt: new Date().toISOString() }, null, 2)); } catch {}
    log('panel server listening on http://127.0.0.1:' + port);
  });
}

// ------------------------------------------------------------------ main ----

function readRuntime() {
  try { return JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8')); } catch { return null; }
}

function probeHealth(port, timeoutMs = 900) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

/**
 * Look for an already-running sibling daemon: the runtime file's port plus the
 * configured port range. This keeps a stale runtime file from letting a second
 * daemon take the next free port alongside the first.
 */
async function findRunningSibling() {
  const rt = readRuntime();
  const base = CONFIG.port || 4748;
  const ports = [];
  if (rt && rt.port) ports.push(rt.port);
  for (let i = 0; i < 6; i++) if (!ports.includes(base + i)) ports.push(base + i);
  const results = await Promise.all(ports.map(async (p) => ({ p, h: await probeHealth(p, 500) })));
  for (const { p, h } of results) {
    if (h && h.ok === true && typeof h.pid === 'number' && h.pid !== process.pid && h.logFile !== undefined) {
      return { port: p, pid: h.pid };
    }
  }
  return null;
}

async function boot() {
  // Singleton guard: never run two daemons at once. Must run before listen(),
  // which rewrites the runtime file.
  if (process.env.ZCODE_PANEL_ALLOW_MULTI !== '1') {
    const sibling = await findRunningSibling();
    if (sibling) {
      log('another daemon is already running on port ' + sibling.port + ' (pid ' + sibling.pid + '), exiting');
      process.exit(0);
    }
  }
  listen(CONFIG.port || 4748);
  setInterval(() => { try { tailer.poll(); } catch {} }, 500);
  setInterval(() => { try { injector.loop(); } catch {} }, 3000);
  setInterval(() => { try { db.open(); } catch {} }, 10000);
  setInterval(() => { injector.feed().catch(() => {}); }, Math.max(400, CONFIG.refreshMs || 1000));
  setInterval(() => { injector.probe().catch(() => {}); }, 4000);
  log('daemon started, pid', process.pid, 'node', process.version);
}

boot();

#!/usr/bin/env node
'use strict';
/**
 * ZCode Agent Panel uninstaller.
 *
 *  - stops the daemon
 *  - removes the login autostart entry
 *  - Windows: restores patched ZCode shortcuts from the backups made by install.js
 *    (or strips the debug flag if a backup is missing), removes the created launcher
 *
 * Your panel-config.json, logs and telemetry history are left untouched.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const SELF_DIR = __dirname;
const HOME = os.homedir();
const RUNTIME = path.join(SELF_DIR, 'panel-runtime.json');
const STATE = path.join(SELF_DIR, 'install-state.json');
const say = (s) => console.log(s);

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function killPid(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve(false);
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve(true));
    else { try { process.kill(pid, 'SIGTERM'); } catch {} resolve(true); }
  });
}

function runVbs(lines, args) {
  const tmp = path.join(os.tmpdir(), 'zcap-un-' + Date.now() + '.vbs');
  fs.writeFileSync(tmp, lines.join('\r\n'), 'utf8');
  return new Promise((resolve) => {
    execFile('cscript', ['//nologo', tmp, ...args], { windowsHide: true }, (err, stdout) => {
      try { fs.unlinkSync(tmp); } catch {}
      resolve({ err, out: (stdout || '').trim() });
    });
  });
}

const VBS_READ = [
  'Set sh = CreateObject("WScript.Shell")',
  'Set lnk = sh.CreateShortcut(WScript.Arguments(0))',
  'WScript.Echo lnk.Arguments',
];

const VBS_WRITE_ARGS = [
  'Set sh = CreateObject("WScript.Shell")',
  'Set lnk = sh.CreateShortcut(WScript.Arguments(0))',
  'lnk.Arguments = WScript.Arguments(1)',
  'lnk.Save',
  'WScript.Echo "saved"',
];

(async function main() {
  say('');
  say('ZCode Agent Panel uninstall');
  say('===========================');

  const rt = readJson(RUNTIME);
  if (rt && rt.pid) { await killPid(rt.pid); say('· daemon stopped (pid ' + rt.pid + ')'); }

  const state = readJson(STATE);

  const autostartPath = state && state.autostart && state.autostart.path;
  const fallbackAutostart = [
    path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'ZCodeAgentPanel.vbs'),
    path.join(HOME, 'Library', 'LaunchAgents', 'com.zcode.agent-panel.plist'),
    path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'autostart', 'zcode-agent-panel.desktop'),
  ];
  for (const p of [autostartPath, ...fallbackAutostart]) {
    if (!p) continue;
    try { if (fs.existsSync(p)) { fs.unlinkSync(p); say('· removed auto-start: ' + p); } } catch {}
  }

  if (process.platform === 'win32' && state) {
    for (const s of state.patched || []) {
      let restored = false;
      if (s.backup && fs.existsSync(s.backup)) {
        try { fs.copyFileSync(s.backup, s.path); restored = true; } catch {}
      }
      if (!restored) {
        const r = await runVbs(VBS_READ, [s.path]);
        if (!r.err && r.out !== undefined) {
          const cleaned = String(r.out).replace(/\s*--remote-debugging-port(=\S+)?/g, '').trim();
          await runVbs(VBS_WRITE_ARGS, [s.path, cleaned]);
        }
      }
      say('· restored shortcut: ' + s.path);
    }
    if (state.launcher && fs.existsSync(state.launcher)) {
      try { fs.unlinkSync(state.launcher); say('· removed launcher: ' + state.launcher); } catch {}
    }
  }

  try { if (fs.existsSync(RUNTIME)) fs.unlinkSync(RUNTIME); } catch {}
  try { if (fs.existsSync(STATE)) fs.unlinkSync(STATE); } catch {}

  say('');
  say('Done. ZCode now starts without the debug flag. Files kept:');
  say('  panel-config.json, panel.js, daemon.js, daemon.log, shortcut-backups/');
  say('To reinstall later: node ' + path.join(SELF_DIR, 'install.js'));
  say('');
})().catch((e) => {
  console.error('uninstall failed:', e && e.message);
  process.exit(1);
});

#!/usr/bin/env node
'use strict';
/**
 * ZCode Agent Panel installer.
 *
 *  1. Registers the daemon to start at login (Windows Startup / LaunchAgent / autostart).
 *  2. Starts the daemon now.
 *  3. Windows: adds --remote-debugging-port=0 to the ZCode shortcuts (the panel needs
 *     a DevTools port to pin itself above the chat composer). Shortcuts are backed up
 *     first, and uninstall.js restores them.
 *  4. Opens the standalone preview so you can see the panel immediately.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn, execFile } = require('child_process');

const SELF_DIR = __dirname;
const HOME = os.homedir();
const DAEMON = path.join(SELF_DIR, 'daemon.js');
const RUNTIME = path.join(SELF_DIR, 'panel-runtime.json');
const STATE = path.join(SELF_DIR, 'install-state.json');
const BACKUP_DIR = path.join(SELF_DIR, 'shortcut-backups');
const LAUNCHER_NAME = 'Launch ZCode with Agent Panel.lnk';

function config() {
  try { return JSON.parse(fs.readFileSync(path.join(SELF_DIR, 'panel-config.json'), 'utf8')); } catch { return {}; }
}
const PORT = Number(config().port) || 4748;
const DEBUG_FLAG = '--remote-debugging-port=0';
const DRY_RUN = process.argv.includes('--dry-run');

const say = (s) => console.log(s);

// ------------------------------------------------------------------ daemon ----

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function killPid(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve(false);
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve(true));
    } else {
      try { process.kill(pid, 'SIGTERM'); } catch {}
      resolve(true);
    }
  });
}

async function stopExistingDaemon() {
  const rt = readJson(RUNTIME);
  if (rt && rt.pid) {
    await killPid(rt.pid);
    say('· stopped previous daemon (pid ' + rt.pid + ')');
  }
}

function startDaemon() {
  const child = spawn(process.execPath, [DAEMON], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: SELF_DIR,
  });
  child.unref();
  return child.pid;
}

function healthCheck() {
  return new Promise((resolve) => {
    let tries = 0;
    const attempt = () => {
      tries++;
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 1200 }, (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => { if (tries < 10) setTimeout(attempt, 500); else resolve(null); });
    };
    attempt();
  });
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], { windowsHide: true }, () => {});
    else if (process.platform === 'darwin') execFile('open', [url], () => {});
    else execFile('xdg-open', [url], () => {});
  } catch {}
}

// --------------------------------------------------------------- autostart ----

function registerAutoStart() {
  const note = (p) => say('· auto-start registered: ' + p);
  if (process.platform === 'win32') {
    const startupDir = path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'),
      'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    const vbsPath = path.join(startupDir, 'ZCodeAgentPanel.vbs');
    const vbs = [
      'Set WshShell = CreateObject("WScript.Shell")',
      `WshShell.Run "node.exe ""${DAEMON.replace(/"/g, '""')}""", 0, False`,
      '',
    ].join('\r\n');
    fs.mkdirSync(startupDir, { recursive: true });
    fs.writeFileSync(vbsPath, vbs, 'utf8');
    note(vbsPath);
    return { platform: 'win32', path: vbsPath };
  }
  if (process.platform === 'darwin') {
    const dir = path.join(HOME, 'Library', 'LaunchAgents');
    const plistPath = path.join(dir, 'com.zcode.agent-panel.plist');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.zcode.agent-panel</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${DAEMON}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(plistPath, plist, 'utf8');
    note(plistPath);
    return { platform: 'darwin', path: plistPath };
  }
  const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'autostart');
  const desktopPath = path.join(dir, 'zcode-agent-panel.desktop');
  const desktop = `[Desktop Entry]
Type=Application
Name=ZCode Agent Panel
Exec=${process.execPath} "${DAEMON}"
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(desktopPath, desktop, 'utf8');
  note(desktopPath);
  return { platform: 'linux', path: desktopPath };
}

// ------------------------------------------------------------ shortcuts (win) ----

function runVbs(lines, args) {
  const tmp = path.join(os.tmpdir(), 'zcap-' + Date.now() + '.vbs');
  fs.writeFileSync(tmp, lines.join('\r\n'), 'utf8');
  return new Promise((resolve) => {
    execFile('cscript', ['//nologo', tmp, ...args], { windowsHide: true }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmp); } catch {}
      resolve({ err, out: (stdout || '').trim(), errOut: (stderr || '').trim() });
    });
  });
}

const VBS_READ = [
  'Set sh = CreateObject("WScript.Shell")',
  'Set lnk = sh.CreateShortcut(WScript.Arguments(0))',
  'WScript.Echo lnk.TargetPath',
  'WScript.Echo lnk.Arguments',
];

const VBS_WRITE_ARGS = [
  'Set sh = CreateObject("WScript.Shell")',
  'Set lnk = sh.CreateShortcut(WScript.Arguments(0))',
  'lnk.Arguments = WScript.Arguments(1)',
  'lnk.Save',
  'WScript.Echo "saved"',
];

const VBS_CREATE = [
  'Set sh = CreateObject("WScript.Shell")',
  'Set lnk = sh.CreateShortcut(WScript.Arguments(0))',
  'lnk.TargetPath = WScript.Arguments(1)',
  'lnk.Arguments = WScript.Arguments(2)',
  'lnk.WorkingDirectory = WScript.Arguments(3)',
  'lnk.IconLocation = WScript.Arguments(1)',
  'lnk.Save',
  'WScript.Echo "created"',
];

function listShortcuts() {
  const out = [];
  const scan = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth > 0) scan(p, depth - 1); continue; }
      if (/\.lnk$/i.test(e.name)) out.push(p);
    }
  };
  const appData = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
  scan(path.join(HOME, 'Desktop'), 0);
  if (process.env.PUBLIC) scan(path.join(process.env.PUBLIC, 'Desktop'), 0);
  scan(path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'), 3);
  scan(path.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'), 0);
  return out;
}

function findZCodeExe() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'Programs', 'ZCode', 'ZCode.exe'),
    path.join('C:\\', 'Program Files', 'ZCode', 'ZCode.exe'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

async function patchShortcuts() {
  const shortcuts = listShortcuts();
  const patched = [];
  const skipped = [];
  for (const sc of shortcuts) {
    const r = await runVbs(VBS_READ, [sc]);
    if (r.err || !r.out) continue;
    const lines = r.out.split(/\r?\n/);
    const target = (lines[0] || '').trim();
    const args = (lines[1] || '').trim();
    if (!/ZCode\.exe$/i.test(target)) continue;
    if (args.includes('--remote-debugging-port')) { skipped.push({ path: sc, reason: 'already patched' }); continue; }
    if (DRY_RUN) { patched.push({ path: sc, backup: null, previousArgs: args, dryRun: true }); say('· [dry-run] would patch: ' + sc + '  ->  "' + ((args ? args + ' ' : '') + DEBUG_FLAG) + '"'); continue; }
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const backup = path.join(BACKUP_DIR, path.basename(sc) + '.' + Date.now() + '.bak');
    try { fs.copyFileSync(sc, backup); } catch {}
    const newArgs = (args ? args + ' ' : '') + DEBUG_FLAG;
    const w = await runVbs(VBS_WRITE_ARGS, [sc, newArgs]);
    if (!w.err) {
      patched.push({ path: sc, backup, previousArgs: args });
      say('· patched shortcut: ' + sc);
    }
  }
  return { patched, skipped, exe: findZCodeExe() };
}

async function createLauncher(exe) {
  if (!exe) return null;
  if (DRY_RUN) { say('· [dry-run] would create launcher for ' + exe); return null; }
  const desktop = path.join(HOME, 'Desktop');
  if (!fs.existsSync(desktop)) return null;
  const lnk = path.join(desktop, LAUNCHER_NAME);
  const r = await runVbs(VBS_CREATE, [lnk, exe, DEBUG_FLAG, path.dirname(exe)]);
  if (!r.err) { say('· created launcher: ' + lnk); return lnk; }
  return null;
}

// ------------------------------------------------------------------- main ----

(async function main() {
  say('');
  say('ZCode Agent Panel installer' + (DRY_RUN ? '  [dry run: nothing will be changed]' : ''));
  say('===========================');

  if (!DRY_RUN) await stopExistingDaemon();

  let autostart = { platform: process.platform, path: null };
  if (!DRY_RUN) autostart = registerAutoStart();
  else say('· [dry-run] would register auto-start for ' + process.platform);

  if (!DRY_RUN) {
    const pid = startDaemon();
    say('· daemon started (pid ' + pid + ')');
  }

  let shortcutState = { patched: [], skipped: [], launcher: null, exe: null };
  if (process.platform === 'win32') {
    const patched = await patchShortcuts();
    shortcutState = { ...shortcutState, ...patched };
    if (!patched.patched.length) {
      shortcutState.launcher = await createLauncher(patched.exe);
      if (!shortcutState.launcher && patched.skipped.length) {
        say('· existing ZCode shortcuts already carry the debug flag');
      }
    }
  }

  if (DRY_RUN) {
    say('');
    say('[dry-run] ZCode.exe found: ' + (shortcutState.exe || 'no'));
    say('[dry-run] nothing was written. Re-run without --dry-run to install.');
    return;
  }

  const health = await healthCheck();
  say('');
  if (health && health.ok) {
    say('✔ Panel server is live on http://127.0.0.1:' + PORT);
    if (health.cdpPort) say('✔ ZCode DevTools port detected (' + health.cdpPort + ') - the panel will attach to open windows.');
    else say('· ZCode is not exposing a DevTools port yet: restart it once to activate the in-panel view.');
  } else {
    say('✖ Could not reach the panel server on port ' + PORT + '. See daemon.log.');
  }

  fs.writeFileSync(STATE, JSON.stringify({
    installedAt: new Date().toISOString(),
    autostart,
    ...shortcutState,
  }, null, 2));

  say('');
  if (process.platform === 'win32') {
    say('Next step (one time): ZCode must restart so the debug flag takes effect.');
    say('  1. Quit ZCode from the tray icon (closing the window keeps it running).');
    say('  2. Start ZCode again from its usual icon.');
    say('The panel then pins itself above the chat composer, every time a turn runs.');
  } else {
    say('Next step: restart ZCode so the debug flag takes effect, then start a chat.');
  }
  say('');
  say('Preview without restarting:  http://127.0.0.1:' + PORT + '/');
  say('Uninstall:                   node ' + path.join(SELF_DIR, 'uninstall.js'));
  say('');

  if (process.env.ZCAP_NO_BROWSER !== '1') openBrowser('http://127.0.0.1:' + PORT + '/');
})().catch((e) => {
  console.error('install failed:', e && e.message);
  process.exit(1);
});

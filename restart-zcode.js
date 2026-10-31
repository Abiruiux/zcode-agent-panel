#!/usr/bin/env node
'use strict';
/**
 * One-shot helper: close ZCode and reopen it with the panel flag enabled.
 *
 * ZCode only grants a DevTools port at launch, so the panel can only attach after
 * a restart. This script waits (default 45 s, so the chat can finish writing),
 * closes every ZCode.exe process, waits for them to exit, then starts ZCode again
 * with --remote-debugging-port=0. The running daemon notices the new port within a
 * few seconds and injects the panel.
 *
 * It is deliberately a separate detached process: killing ZCode must not kill it.
 * A record of what happened is appended to restart-log.txt next to this file.
 */

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const LOG = path.join(__dirname, 'restart-log.txt');
const log = (m) => { try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${m}\n`); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXE = process.env.ZCAP_ZCODE_EXE || path.join(
  process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local'),
  'Programs', 'ZCode', 'ZCode.exe');
const DELAY_MS = Number(process.env.ZCAP_RESTART_DELAY_MS || 45000);

(async () => {
  log('armed: will restart ZCode in ' + Math.round(DELAY_MS / 1000) + 's');
  await sleep(DELAY_MS);

  log('closing ZCode');
  await new Promise((res) => execFile('taskkill', ['/IM', 'ZCode.exe', '/F'], () => res()));

  // Wait until no ZCode.exe is left, so the new instance does not lose the single-instance lock.
  let attempts = 0;
  for (; attempts < 40; attempts++) {
    await sleep(500);
    const out = await new Promise((res) => execFile('tasklist', ['/FI', 'IMAGENAME eq ZCode.exe'], (e, o) => res(o || '')));
    if (!/ZCode\.exe/i.test(out)) break;
  }
  log('ZCode processes gone after ' + (attempts * 0.5) + 's');

  await sleep(1500);
  try {
    const child = spawn(EXE, ['--remote-debugging-port=0'], {
      detached: true,
      stdio: 'ignore',
      cwd: path.dirname(EXE),
    });
    child.unref();
    log('relaunched ZCode with panel flag, pid ' + child.pid);
  } catch (e) {
    log('relaunch failed: ' + e.message);
  }
  log('done');
})();

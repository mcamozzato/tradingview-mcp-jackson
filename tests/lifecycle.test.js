/**
 * The server exits when its client is gone — no TradingView connection needed.
 *
 * Unit: exitWhenClientGone fires on stdin end/close and on a changed parent pid,
 * once, and never treats a server started under ppid 1 as orphaned.
 * Process: a real `node src/server.js` exits when its stdin is closed (also with
 * an open handle keeping the loop alive, as the CDP socket does), and when its
 * parent dies while another process still holds the stdin pipe.
 *
 * Run: node --test tests/lifecycle.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { exitWhenClientGone } from '../src/lifecycle.js';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(100);
  }
  return pred();
}

describe('exitWhenClientGone (unit)', () => {
  it('fires on stdin end', () => {
    const stdin = new EventEmitter();
    const reasons = [];
    const h = exitWhenClientGone({ stdin, getPpid: () => 42, onGone: (r) => reasons.push(r) });
    stdin.emit('end');
    h.stop();
    assert.deepEqual(reasons, ['stdin ended']);
  });

  it('fires on stdin close', () => {
    const stdin = new EventEmitter();
    const reasons = [];
    const h = exitWhenClientGone({ stdin, getPpid: () => 42, onGone: (r) => reasons.push(r) });
    stdin.emit('close');
    h.stop();
    assert.deepEqual(reasons, ['stdin closed']);
  });

  it('fires only once when end and close both arrive', () => {
    const stdin = new EventEmitter();
    const reasons = [];
    const h = exitWhenClientGone({ stdin, getPpid: () => 42, onGone: (r) => reasons.push(r) });
    stdin.emit('end');
    stdin.emit('close');
    h.stop();
    assert.equal(reasons.length, 1);
  });

  it('fires when the original parent no longer exists', async () => {
    const stdin = new EventEmitter();
    let parentAlive = true;
    const probed = [];
    const reasons = [];
    exitWhenClientGone({
      stdin, getPpid: () => 42, onGone: (r) => reasons.push(r), intervalMs: 20,
      isAlive: (pid) => { probed.push(pid); return parentAlive; },
    });
    await sleep(60);
    assert.equal(reasons.length, 0, 'parent alive: still running');
    parentAlive = false;
    await waitFor(() => reasons.length > 0, 1000);
    assert.deepEqual(reasons, ['parent 42 gone']);
    assert.ok(probed.every((p) => p === 42), 'probes the ORIGINAL parent pid');
  });

  it('never treats a server started under ppid 1 as orphaned', async () => {
    const stdin = new EventEmitter();
    const reasons = [];
    const h = exitWhenClientGone({
      stdin, getPpid: () => 1, onGone: (r) => reasons.push(r), intervalMs: 20, isAlive: () => false,
    });
    await sleep(100);
    h.stop();
    assert.equal(reasons.length, 0);
    assert.equal(h.initialPpid, 1);
  });
});

describe('server process (spawned)', () => {
  it('exits when the client closes stdin', async () => {
    const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      await sleep(1500); // let it reach server.connect()
      assert.equal(child.exitCode, null, 'server should be running before stdin closes');
      child.stdin.end();
      const exited = await waitFor(() => child.exitCode !== null, 5000);
      assert.ok(exited, 'server still running 5 s after stdin closed');
      assert.equal(child.exitCode, 0);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });

  it('exits on stdin end even when an open handle (the CDP socket) keeps node alive', async () => {
    // A live server holds a websocket to TradingView on :9222, which alone keeps
    // the event loop running after stdin ends. The port is hard-coded to the
    // live app, so a preloaded interval stands in for that socket.
    const keepAlive = 'data:text/javascript,setInterval(()=>{},1e6)';
    const child = spawn(process.execPath, ['--import', keepAlive, SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      await sleep(1500);
      assert.equal(child.exitCode, null, 'server should be running before stdin closes');
      child.stdin.end();
      const exited = await waitFor(() => child.exitCode !== null, 5000);
      assert.ok(exited, 'server still running 5 s after stdin closed');
      assert.equal(child.exitCode, 0);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });

  it('exits when its parent dies while another process holds the stdin pipe', async () => {
    // sh starts `sleep 61.4142 | node server.js` in the background (a unique
    // duration, so cleanup can find it), prints node's pid, lives 2 s so node
    // starts as its child, then exits: node is reparented while `sleep` keeps
    // its stdin open, so only the parent check can notice.
    const out = execFileSync('/bin/sh', ['-c',
      `sleep 61.4142 </dev/null 2>/dev/null | "${process.execPath}" "${SERVER}" >/dev/null 2>&1 & echo $!; sleep 2`,
    ], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const pid = Number(out);
    assert.ok(Number.isInteger(pid) && pid > 0, `bad pid ${out}`);
    assert.ok(alive(pid), 'server should still be running right after its parent exits');
    try {
      const gone = await waitFor(() => !alive(pid), 10000);
      assert.ok(gone, `orphaned server ${pid} still running after 10 s`);
    } finally {
      if (alive(pid)) process.kill(pid, 'SIGKILL');
      try { execFileSync('/usr/bin/pkill', ['-f', '^sleep 61.4142$'], { stdio: 'ignore' }); } catch {}
    }
  });
});

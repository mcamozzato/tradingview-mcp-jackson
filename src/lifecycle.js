/**
 * Exit when the MCP client is gone.
 *
 * The SDK's StdioServerTransport only listens for 'data' on stdin, so a server
 * whose client died kept running forever, holding its CDP connection to
 * TradingView open. 568 of them had piled up on one machine by 2026-10-14 (8 h
 * to 13 days old, ~3.9 GB RSS, 568 sockets on :9222), left by Python clients
 * killed before their atexit cleanup could reap the node child.
 *
 * Two signals, either one ends the process:
 *  - stdin 'end' / 'close': the client closed its end of the pipe (normal exit,
 *    or the kernel closing it when the client died);
 *  - the parent that started us no longer exists: we were orphaned while
 *    something else (a grandchild that inherited the fd) still holds the
 *    pipe's write end, so stdin never ends. A server started with ppid 1 from
 *    the outset (launchd, a daemon) is never treated as orphaned.
 *
 * `process.ppid` is read once at startup and never refreshed, so the check
 * probes the ORIGINAL parent pid with signal 0 instead of re-reading ppid.
 */

export const PARENT_POLL_MS = 2000;

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists, owned by someone else
  }
}

export function exitWhenClientGone({
  stdin = process.stdin,
  getPpid = () => process.ppid,
  isAlive = pidAlive,
  onGone,
  intervalMs = PARENT_POLL_MS,
} = {}) {
  let done = false;
  const initialPpid = getPpid();
  let timer = null;

  const fire = (reason) => {
    if (done) return;
    done = true;
    if (timer) clearInterval(timer);
    onGone(reason);
  };

  stdin.on('end', () => fire('stdin ended'));
  stdin.on('close', () => fire('stdin closed'));

  if (initialPpid !== 1) {
    timer = setInterval(() => {
      if (!isAlive(initialPpid)) fire(`parent ${initialPpid} gone`);
    }, intervalMs);
    timer.unref?.();
  }

  return { initialPpid, stop: () => { done = true; if (timer) clearInterval(timer); } };
}

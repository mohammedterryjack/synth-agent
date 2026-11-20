'use strict';
// oldmac heavy lock (Mo 20 Nov 15:56): Synth's local CPU/IO renders (whisper.cpp captions, editly compose, deck
// render, contact sheets, ffmpeg burn-in) and Articraft compiles never overlap. One shared implementation:
// ~/Code/oldmac-heavy-lock/heavylock.py (flock). We run its `hold` CLI as a child that holds the lock until we close
// its stdin; if Synth dies, the pipe closes and the kernel releases the lock. Waiting never times out and is never
// cancelled; it is logged at the start and every 60 s, and shown on the job as job.waiting. Hold it per render,
// never around Dell GPU calls (those are remote and queue on the Dell).
const path = require('path'), os = require('os'), { spawn } = require('child_process');
const HEAVYLOCK_PY = process.env.OLDMAC_HEAVYLOCK_PY || path.join(os.homedir(), 'Code', 'oldmac-heavy-lock', 'heavylock.py');

function acquire(who, onWait = () => {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('/usr/bin/python3', [HEAVYLOCK_PY, 'hold', '--who', who], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', locked = false, errTail = '';
    p.stderr.on('data', b => {
      err += b;
      let i;
      while ((i = err.indexOf('\n')) >= 0) {
        const line = err.slice(0, i); err = err.slice(i + 1);
        if (line.startsWith('WAIT ')) {
          let w; try { w = JSON.parse(line.slice(5)); } catch { w = { message: line.slice(5), waited_s: null }; }
          onWait(w.message, w.waited_s);
        } else errTail = (errTail + '\n' + line).slice(-800);
      }
    });
    p.stdout.on('data', b => {
      out += b;
      if (!locked && out.includes('\n')) {
        const line = out.split('\n')[0];
        if (!line.startsWith('LOCKED ')) { p.kill(); return reject(new Error(`oldmac heavy lock: unexpected output ${JSON.stringify(line.slice(0, 200))}`)); }
        locked = true;
        const info = JSON.parse(line.slice(7));
        let released = null;
        const release = () => released || (released = new Promise(res => { p.once('exit', () => res()); p.stdin.end(); }));
        resolve({ waited_s: info.waited_s, release });
      }
    });
    p.on('error', e => reject(new Error(`oldmac heavy lock: cannot run ${HEAVYLOCK_PY}: ${e.message}`)));
    p.on('exit', code => { if (!locked) reject(new Error(`oldmac heavy lock: holder exited ${code} before locking${errTail ? ': ' + errTail.trim() : ''}`)); });
  });
}

// Run fn() while holding the lock. job/saveJob (optional) get job.waiting while waiting and job.lock_wait_s after.
async function withHeavyLock(who, fn, { job = null, saveJob = null, log = console.log } = {}) {
  const t0 = Date.now();
  const lk = await acquire(who, (msg, waited) => {
    const line = `${msg} (${who} has waited ${Math.round(waited || 0)} s)`;
    log(`[heavy-lock] ${line}`);
    if (job && saveJob) { job.waiting = line; saveJob(job.id, job); }
  });
  const waited = +((Date.now() - t0) / 1000).toFixed(1);
  if (job) { delete job.waiting; job.lock_wait_s = +((job.lock_wait_s || 0) + waited).toFixed(1); if (saveJob) saveJob(job.id, job); }
  if (waited >= 1) log(`[heavy-lock] ${who} got the lock after ${waited} s`);
  try { return await fn(); } finally { await lk.release(); }
}

module.exports = { acquire, withHeavyLock, HEAVYLOCK_PY };

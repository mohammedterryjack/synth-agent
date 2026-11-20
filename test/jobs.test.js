'use strict';
// node --test test/*.test.js : list_jobs limit/valid JSON, show_job compaction, finish full stop, startup reconcile, X-Client.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path');
const J = require('../jobs.js');
const JOB_RE = /^[0-9a-f]{16}$/;

function mkJobs(n, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synth-jobs-'));
  for (let i = 0; i < n; i++) {
    const id = i.toString(16).padStart(16, '0');
    fs.mkdirSync(path.join(dir, id));
    fs.writeFileSync(path.join(dir, id, 'job.json'), JSON.stringify({ id, kind: 'image', name: 'x'.repeat(50), status: 'failed',
      created: new Date(Date.UTC(2026, 10, 1) + i * 60000).toISOString(), error: 'e'.repeat(800), ...extra }));
  }
  return dir;
}

test('list_jobs: newest 20 by default, valid JSON however many jobs, note for the rest', () => {
  const dir = mkJobs(45);
  const out = J.listJobs(dir, JOB_RE);
  const txt = JSON.stringify(out);
  assert.strictEqual(JSON.stringify(JSON.parse(txt)), txt);
  assert.strictEqual(out.total, 45); assert.strictEqual(out.shown, 20); assert.strictEqual(out.jobs.length, 20);
  assert.strictEqual(out.jobs[0].job_id, (44).toString(16).padStart(16, '0'));
  assert.match(out.note, /^25 older jobs not shown/);
  assert.ok(out.jobs[0].error.length < 300 && /… \(800 chars\)$/.test(out.jobs[0].error));
  assert.strictEqual(J.listJobs(dir, JOB_RE, 100).jobs.length, 45);
  assert.strictEqual(J.listJobs(dir, JOB_RE, 100).note, undefined);
  assert.throws(() => J.listJobs(dir, JOB_RE, 0), /^Error: error list_jobs\.limit: must be a whole number 1-100/);
  assert.throws(() => J.listJobs(dir, JOB_RE, 101), /list_jobs\.limit/);
});

test('list_jobs: an unreadable job.json is listed, not fatal', () => {
  const dir = mkJobs(2);
  fs.writeFileSync(path.join(dir, '0000000000000001', 'job.json'), '{broken');
  const out = J.listJobs(dir, JOB_RE);
  assert.ok(out.jobs.some(r => r.status === 'unreadable'));
});

test('show_job compaction keeps valid JSON and every field', () => {
  const j = { id: 'a', lyrics: 'l'.repeat(5000), prompt: 'short', n: 3 };
  const c = J.compactJob(j);
  assert.deepStrictEqual(Object.keys(c), Object.keys(j));
  assert.strictEqual(c.prompt, 'short'); assert.strictEqual(c.n, 3);
  assert.match(c.lyrics, /… \(5000 chars\)$/);
  JSON.parse(JSON.stringify(c));
});

test('finish line has exactly one full stop', () => {
  assert.strictEqual(J.madeLine('2 s video: cinematic.'), 'Made 2 s video: cinematic.');
  assert.strictEqual(J.madeLine('2 s video: wow!'), 'Made 2 s video: wow!');
  assert.strictEqual(J.madeLine('image 1024x1024 (a fox)'), 'Made image 1024x1024 (a fox).');
  assert.strictEqual(J.madeLine('x. '), 'Made x.');
});

function deps(statusImpl) {
  const saved = [], resumed = [];
  return { saved, resumed, d: { dellStatus: statusImpl, saveJob: (id, j) => saved.push([id, { ...j }]), resume: (id) => resumed.push(id), now: () => '2026-11-20T12:00:00.000Z' } };
}

test('reconcile: Dell 404 -> failed with a clear reason, nothing resumed', async () => {
  const x = deps(async () => { throw Object.assign(new Error('no such music job'), { status: 404 }); });
  const j = { kind: 'song', status: 'queued', dell_job_id: 'd1' };
  const out = await J.reconcileJob('s1', j, x.d);
  assert.match(out, /failed: Dell job d1 gone/);
  assert.strictEqual(x.saved[0][1].status, 'failed');
  assert.match(x.saved[0][1].error, /^JOB FAILED: the Dell no longer has job d1 \(no such music job\).*nothing was cancelled/);
  assert.deepStrictEqual(x.resumed, []);
});

test('reconcile: Dell done/running -> resumed via the tool, status untouched here', async () => {
  for (const status of ['done', 'running', 'queued', 'failed']) {
    const x = deps(async () => ({ status }));
    const out = await J.reconcileJob('t1', { kind: 'generate_sfx', status: 'running', dell_job_id: 'd2' }, x.d);
    assert.match(out, new RegExp(`Dell says ${status}; resumed`));
    assert.deepStrictEqual(x.resumed, ['t1']); assert.strictEqual(x.saved.length, 0);
  }
});

test('reconcile: Dell unreachable -> left as is, loud log line', async () => {
  const x = deps(async () => { throw Object.assign(new Error('fetch failed'), { status: undefined }); });
  const out = await J.reconcileJob('t1', { kind: 'speak', status: 'running', dell_job_id: 'd3' }, x.d);
  assert.match(out, /^RECONCILE FAILED: .*fetch failed.*left running/);
  assert.strictEqual(x.saved.length, 0); assert.strictEqual(x.resumed.length, 0);
});

test('reconcile: no Dell job id (in-process image/slideshow) -> failed, nothing asked', async () => {
  let asked = false;
  const x = deps(async () => { asked = true; return {}; });
  await J.reconcileJob('i1', { kind: 'image', status: 'running' }, x.d);
  assert.strictEqual(asked, false);
  assert.match(x.saved[0][1].error, /^JOB FAILED: synth-agent restarted while this image job was running/);
});

test('X-Client: synth-agent on every gateway POST, not on GET', () => {
  assert.deepStrictEqual(J.gatewayHeaders('k', 'POST', { 'Content-Type': 'application/json' }), { Authorization: 'Bearer k', 'Content-Type': 'application/json', 'X-Client': 'synth-agent' });
  assert.strictEqual(J.gatewayHeaders('k', 'GET')['X-Client'], undefined);
  const svc = fs.readFileSync(path.join(__dirname, '..', 'service.js'), 'utf8'), med = fs.readFileSync(path.join(__dirname, '..', 'media.js'), 'utf8');
  assert.match(svc, /headers: gatewayHeaders\(key\(\), method,/);
  assert.match(med, /headers: gatewayHeaders\(key\(\), 'POST',/);
  assert.ok(!/fetch\(CFG\.music[^;]*Authorization/s.test(svc));
});

test('service.js: tts outputs read files{name} or url, and a failed download marks the job failed (no stuck running)', () => {
  const svc = fs.readFileSync(path.join(__dirname, '..', 'service.js'), 'utf8');
  assert.match(svc, /const url = \(st\.files && st\.files\[name\]\) \|\| st\.url;/);
  assert.match(svc, /JOB FAILED: done on the Dell but not collected/);
});

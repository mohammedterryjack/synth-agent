'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { acquire, withHeavyLock } = require('../heavylock.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synth-lock-test-'));
process.env.OLDMAC_HEAVY_LOCK = path.join(tmp, 'lock');
const pause = ms => new Promise(r => setTimeout(r, ms));
test('Synth lock waits, reports holder and wait state; executes exclusively; releases on error', async () => {
  const a = await acquire('articraft:dummy:compile');
  const logs = [], saves = [], job = { id: 'test', status: 'running' };
  let ran = false;
  const pending = withHeavyLock('synth:test:captions', async () => { ran = true; throw new Error('dummy crash'); },
    { job, saveJob: (id, j) => saves.push(JSON.parse(JSON.stringify(j))), log: s => logs.push(s) });
  const checked = assert.rejects(pending, /dummy crash/);
  await pause(900);
  assert.equal(ran, false);
  assert.match(job.waiting, /waiting for oldmac heavy lock held by articraft:dummy:compile/);
  await a.release();
  await checked;
  assert.equal(ran, true); assert.equal(job.waiting, undefined);
  assert.ok(job.lock_wait_s >= 0.8); assert.ok(saves.length >= 2);
  assert.match(logs[0], /since/);
  const b = await acquire('next'); await b.release();
});
test('all heavy render paths guarded; Dell renders not wrapped', () => {
  const s = fs.readFileSync(path.join(__dirname, '../studio.js'), 'utf8');
  for (const n of ['compose', 'captions', 'deck', 'critique-frames']) assert.ok(s.includes(':'+n+'`, async () => {'));
  const m = fs.readFileSync(path.join(__dirname, '../media.js'), 'utf8');
  assert.ok(m.includes(':contact_sheet`, async () => {'));
  assert.equal(m.match(/withHeavyLock\(`/g).length, 1);
});

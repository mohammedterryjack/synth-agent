'use strict';
// node --test test/*.test.js : generate_video quality draft (Wan 2.2) / final (LTX-2.5) routing and loud errors.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path');
const media = require('../media.js');
const { TOOLS } = require('../tools.js');
const { checkVideo } = media;

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synth-test-'));
  const jobs = {}, posts = [];
  let n = 0;
  const h = {
    jobDir: id => { const d = path.join(root, id); fs.mkdirSync(d, { recursive: true }); return d; },
    loadJob: id => { if (!jobs[id]) throw new Error('no job ' + id); return JSON.parse(JSON.stringify(jobs[id])); },
    saveJob: (id, j) => { jobs[id] = JSON.parse(JSON.stringify(j)); },
    token: () => {}, newId: () => (++n).toString(16).padStart(16, '0'),
    gateway: async (method, p, body) => {
      if (method === 'POST') { posts.push({ p, body }); return { job_id: 'dell1', status: 'queued', queue_position: 1, jobs_ahead: 0 }; }
      return h.next(p);
    },
    next: () => ({ status: 'failed', error: 'boom' }),
    applyBible: a => ({ prompt: String(a.prompt).trim(), project: null, bible_version: null }),
    gatewayBase: 'http://127.0.0.1:1', key: () => 'k', download: async () => 1,
    Pending: class extends Error {}, describeWait: () => 'waiting', sleep: async () => {}, WAIT_MS: 1000, JOB_RE: /^[0-9a-f]{16}$/
  };
  return { h, jobs, posts, tools: media(h) };
}

test('quality is required and must be draft or final', () => {
  assert.throws(() => checkVideo({ prompt: 'x' }), /^Error: error generate_video\.quality: required; .*for example quality:"draft"/);
  assert.throws(() => checkVideo({ prompt: 'x', quality: 'high' }), /error generate_video\.quality: must be "draft" or "final"/);
});

test('draft maps to Wan with defaults', () => {
  assert.deepStrictEqual(checkVideo({ quality: 'draft' }), { quality: 'draft', model: 'wan2.2-ti2v-5b', mode: 't2v', seconds: 3 });
  assert.deepStrictEqual(checkVideo({ quality: 'draft', image: '/x.jpg' }), { quality: 'draft', model: 'wan2.2-ti2v-5b', mode: 'i2v', seconds: 3 });
});

test('draft rejects every LTX-only option loudly', () => {
  for (const [k, v] of [['end_image', '/a.png'], ['source', '/a.mp4'], ['extend_seconds', 2], ['control', 'depth'], ['style', 'anime']])
    assert.throws(() => checkVideo({ quality: 'draft', [k]: v }), new RegExp(`^Error: error generate_video\\.${k}: ${k} is only for quality "final".*for example`));
  for (const m of ['first_last', 'extend', 'restyle'])
    assert.throws(() => checkVideo({ quality: 'draft', mode: m }), /error generate_video\.mode: .* is only for quality "final"/);
});

test('draft seconds 1-5 integers; i2v needs image; t2v takes no image; seed integer', () => {
  assert.throws(() => checkVideo({ quality: 'draft', seconds: 6 }), /error generate_video\.seconds: draft is 1-5/);
  assert.throws(() => checkVideo({ quality: 'draft', seconds: 0 }), /generate_video\.seconds/);
  assert.throws(() => checkVideo({ quality: 'draft', seconds: 2.5 }), /generate_video\.seconds/);
  assert.strictEqual(checkVideo({ quality: 'draft', seconds: 5 }).seconds, 5);
  assert.throws(() => checkVideo({ quality: 'draft', mode: 'i2v' }), /error generate_video\.image: required for mode i2v/);
  assert.throws(() => checkVideo({ quality: 'draft', mode: 't2v', image: '/a.jpg' }), /error generate_video\.image: not used by mode t2v/);
  assert.throws(() => checkVideo({ quality: 'draft', seed: 1.5 }), /error generate_video\.seed/);
});

test('final passes LTX options through unchanged', () => {
  assert.deepStrictEqual(checkVideo({ quality: 'final', mode: 'restyle', source: '/a.mp4', control: 'depth', style: 'anime' }), { quality: 'final', model: 'ltx-2.5', mode: 'restyle' });
});

test('draft t2v posts exactly the Wan fields (any extra field is a 400 on the Dell)', async () => {
  const { tools, posts, jobs } = harness();
  await assert.rejects(tools.generate_video({ quality: 'draft', prompt: ' fox ', seconds: 2, seed: 7 }), /JOB FAILED: draft video \(wan2\.2-ti2v-5b\) 0000000000000001: boom/);
  assert.deepStrictEqual(posts, [{ p: '/v1/videos', body: { prompt: 'fox', model: 'wan2.2-ti2v-5b', mode: 't2v', seconds: 2, seed: 7 } }]);
  assert.strictEqual(jobs['0000000000000001'].status, 'failed');
  assert.strictEqual(jobs['0000000000000001'].quality, 'draft');
});

test('final t2v posts no model field (LTX default path unchanged)', async () => {
  const { tools, posts } = harness();
  await assert.rejects(tools.generate_video({ quality: 'final', prompt: 'fox', seconds: 4, style: 'anime' }), /JOB FAILED: final video \(ltx-2\.5\)/);
  assert.deepStrictEqual(posts[0].body, { prompt: 'fox', style: 'anime', seconds: 4 });
});

test('draft with an LTX-only option posts nothing', async () => {
  const { tools, posts } = harness();
  await assert.rejects(tools.generate_video({ quality: 'draft', prompt: 'fox', style: 'anime' }), /error generate_video\.style/);
  await assert.rejects(tools.generate_video({ prompt: 'fox' }), /error generate_video\.quality: required/);
  assert.strictEqual(posts.length, 0);
});

test('draft i2v sends the normalised image (EXIF/MPO normaliser) as image_base64', async () => {
  const { tools, posts } = harness();
  const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'synth-img-')), 'in.png');
  require('child_process').execFileSync('/usr/bin/python3', ['-c', `from PIL import Image; Image.new('RGB',(64,48),(200,10,10)).save(${JSON.stringify(src)})`]);
  await assert.rejects(tools.generate_video({ quality: 'draft', prompt: 'fox', image: src }), /JOB FAILED/);
  const b = posts[0].body;
  assert.deepStrictEqual(Object.keys(b).sort(), ['image_base64', 'mode', 'model', 'prompt', 'seconds']);
  assert.strictEqual(b.mode, 'i2v');
  assert.ok(Buffer.from(b.image_base64, 'base64').length > 50);
});

test('tool schema: one generate_video with quality enum, no separate draft tool, every tool name unique', () => {
  const names = TOOLS.map(t => t.name);
  assert.strictEqual(new Set(names).size, names.length);
  assert.ok(!names.some(n => /draft|wan|ltx/i.test(n)));
  const v = TOOLS.find(t => t.name === 'generate_video');
  assert.deepStrictEqual(v.inputSchema.properties.quality.enum, ['draft', 'final']);
  assert.match(v.description, /"draft" = Wan 2\.2/);
  assert.match(v.description, /"final" = LTX-2\.5/);
});

test('videoLabel: draft says Wan, no sound; final says LTX; old records without quality get no label', () => {
  const { videoLabel } = media;
  assert.strictEqual(videoLabel({ kind: 'video', quality: 'draft', mode: 't2v', video_seconds: 2.04 }), '2.04 s draft t2v video (Wan, no sound)');
  assert.strictEqual(videoLabel({ kind: 'video', quality: 'final', mode: 'i2v', video_seconds: 5.04 }), '5.04 s final i2v video (LTX)');
  assert.strictEqual(videoLabel({ kind: 'video', quality: 'final', mode: 't2v', video_seconds: 5, style: 'anime' }), '5 s final t2v video (anime style) (LTX)');
  assert.strictEqual(videoLabel({ kind: 'video', quality: 'draft', mode: 'i2v', seconds: 3 }), '3 s draft i2v video (Wan, no sound)');
  assert.strictEqual(videoLabel({ kind: 'video', mode: 't2v', video_seconds: 5 }), null);
  assert.strictEqual(videoLabel({ kind: 'image', quality: 'draft' }), null);
});

test('service.js uses videoLabel in finish, show_job and list_jobs', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'service.js'), 'utf8');
  assert.match(src, /j\.kind === 'video' \? \(videoLabel\(j\)/);
  assert.match(src, /if \(videoLabel\(j\)\) j\.label = videoLabel\(j\);/);
  assert.match(src, /listJobs\(CFG\.dir, JOB_RE, a\.limit, videoLabel\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'jobs.js'), 'utf8'), /label: \(label && label\(j\)\) \|\| undefined/);
});

test('a separate_stems job as audio input fails loudly and names both files', () => {
  const { h, jobs } = harness();
  const id = 'abcdefabcdef0001';
  jobs[id] = { id, kind: 'separate_stems', status: 'done' };
  const d = h.jobDir(id);
  fs.writeFileSync(path.join(d, 'vocals.wav'), 'x'); fs.writeFileSync(path.join(d, 'backing.wav'), 'x');
  assert.throws(() => h.resolveInput(id, 'audio', 'compose.music'), /compose\.music: job abcdefabcdef0001 is separate_stems with two files; pick one by path, for example ".*backing\.wav" \(music, no vocals\) or ".*vocals\.wav"/);
  assert.strictEqual(h.resolveInput(path.join(d, 'backing.wav'), 'audio', 'compose.music'), path.join(d, 'backing.wav'));
});

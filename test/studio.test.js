'use strict';
// node --test test/*.test.js : bible lock + verbatim injection, storyboard schema/continuity/approval gate, compose spec,
// make_slideshow alias mapping, deck checks/contrast, captions helpers, Ink-style errors.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path');
const B = require('../board.js');

const fox = 'Small red fox with a white-tipped bushy tail, amber eyes, a torn left ear, slim build, black socks on all four legs, a faded blue scarf knotted around the neck, alert pointed face and soft cream chest fur.';
const owl = 'Old barn owl with a heart-shaped white face, dark kind eyes, mottled golden-brown wings, one bent tail feather, small round spectacles perched on the beak, perched upright like a teacher, calm and slow.';
const bibleArgs = { project: 'fox-tale', style_lock: 'hand-painted watercolour picture book, soft paper texture, warm autumn palette, gentle morning light, 35mm lens look',
  characters: [{ id: 'char_fox', name: 'Fen', identity_lock: fox }, { id: 'char_owl', name: 'Orla', identity_lock: owl }],
  environments: [{ id: 'env_forest', name: 'Birch forest', style_lock: 'silver birch forest, mossy ground, low mist, cool dawn light through the trees' }],
  palette: ['#1b2a33', '#f2e8d5', '#c8553d'], negative: 'no text, no watermark' };
const shot = (o = {}) => ({ summary: 'Fen walks', durationSec: 3, shotSize: 'wide', angle: 'eye-level', movement: 'static', characters: ['char_fox'], environment: 'env_forest', lighting: 'cool dawn', imagePrompt: 'Fen trots along a path', ...o });

test('bible: Ink errors, word limits, lock text reused verbatim', () => {
  const b = B.normaliseBible(bibleArgs, 'T');
  assert.strictEqual(b.creative_status, 'locked');
  assert.throws(() => B.normaliseBible({ ...bibleArgs, project: 'Fox Tale' }), /^Error: error write_bible\.project: .*; for example project:"fox-tale"$/);
  assert.throws(() => B.normaliseBible({ ...bibleArgs, characters: [{ id: 'char_fox', name: 'Fen', identity_lock: 'a fox' }] }), /error write_bible\.characters\[0\]\.identity_lock: must be 30-60 words/);
  assert.throws(() => B.normaliseBible({ ...bibleArgs, characters: [{ id: 'fox', name: 'Fen', identity_lock: fox }] }), /characters\[0\]\.id: must look like char_/);
  assert.throws(() => B.normaliseBible({ ...bibleArgs, palette: ['red'] }), /write_bible\.palette/);
  const p = B.withBible(b, 'Fen peers out', { characters: ['char_fox'], environment: 'env_forest' });
  assert.ok(p.includes(`Fen: ${fox}`), 'identity_lock verbatim');
  assert.ok(p.startsWith(`Style: ${bibleArgs.style_lock}`));
  assert.ok(p.includes('Setting: silver birch forest') && p.includes('\nShot: Fen peers out') && p.endsWith('Avoid: no text, no watermark'));
  assert.throws(() => B.withBible(b, 'x', { characters: ['char_cat'], tool: 'generate_video' }), /^Error: error generate_video\.characters: "char_cat" is not in the fox-tale bible \(char_fox, char_owl\)/);
});

test('storyboard: take schema, generated ids, all draft, enum errors', () => {
  const b = B.normaliseBible(bibleArgs);
  const board = B.normaliseBoard({ title: 'Lantern', project: 'fox-tale', shots: [shot(), shot({ shotSize: 'close', imagePrompt: 'Fen sniffs the lantern' })] }, b);
  assert.deepStrictEqual(B.schemaIssues(board), []);
  assert.deepStrictEqual(board.shots.map(s => [s.id, s.index, s.beatId, s.status]), [['shot-001', 1, 'beat-001', 'draft'], ['shot-002', 2, 'beat-001', 'draft']]);
  assert.strictEqual(board.aspectRatio, '16:9');
  assert.throws(() => B.normaliseBoard({ title: 't', shots: [shot({ shotSize: 'closeup' })] }, b), /^Error: error storyboard\.shots\[0\]\.shotSize: must be one of extreme-wide, .*got "closeup"; for example shotSize:"medium"/);
  assert.throws(() => B.normaliseBoard({ title: 't', shots: [shot({ characters: ['char_cat'] })] }, b), /storyboard\.shots\[0\]\.characters: "char_cat" is not in the fox-tale bible/);
  assert.throws(() => B.normaliseBoard({ title: 't', shots: [shot({ colour: 'red' })] }, b), /storyboard\.shots\[0\]\.colour: unknown field/);
  assert.throws(() => B.normaliseBoard({ title: 't', aspect_ratio: '2:1', shots: [shot()] }, b), /storyboard\.aspect_ratio/);
  assert.throws(() => B.normaliseBoard({ title: 't', shots: [shot({ environment: 'env_x' })] }, null), /needs a project with a bible/);
  const take = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'take-rain-night.shots.json'), 'utf8'));
  assert.deepStrictEqual(B.schemaIssues(take), [], 'take\'s own example board passes the same schema');
});

test('storyboard continuity warnings (never thrown)', () => {
  const b = B.normaliseBible(bibleArgs);
  const board = B.normaliseBoard({ title: 'L', project: 'fox-tale', shots: [
    shot({ shotSize: 'medium' }), shot({ shotSize: 'medium' }), shot({ shotSize: 'wide', imagePrompt: 'close-up of Fen', lighting: 'warm sunset' }), shot({ durationSec: 12, shotSize: 'close' })] }, b);
  const w = B.continuityWarnings(board, b).map(x => `${x.shot}: ${x.warning}`).join('\n');
  assert.match(w, /^1: opens on a medium shot/m);
  assert.match(w, /^2: same shotSize \(medium\) and angle \(eye-level\) as shot 1/m);
  assert.match(w, /^3: imagePrompt says close-up but shotSize is wide/m);
  assert.match(w, /^3: lighting "warm sunset" differs from shot 1/m);
  assert.match(w, /^4: 12 s is longer than one generate_video clip/m);
  assert.match(B.continuityWarnings(board, null)[0].warning, /no project bible/);
  assert.match(B.shotPrompt(board, board.shots[0]), /^Fen trots along a path\. medium shot from the waist up, eye-level camera, cool dawn$/);
});

test('compose: Ink errors, editly spec, narration stretches the clip, ducking filter', () => {
  assert.throws(() => B.checkCompose({ clips: [{ image: 'a', video: 'b' }] }), /^Error: error compose\.clips\[0\]: give exactly one of image, video or title \(got image, video\)/);
  assert.throws(() => B.checkCompose({ clips: [{ title: 'x', cut_to: 2 }] }), /compose\.clips\[0\]\.cut_to: only for video clips/);
  assert.throws(() => B.checkCompose({ clips: [{ title: 'x' }], transition: 'wipe' }), /compose\.transition: must be one of fade/);
  assert.throws(() => B.checkCompose({ clips: [{ title: 'x' }], duck: true }), /compose\.duck: only applies with music/);
  const plan = B.checkCompose({ clips: [{ title: 'Intro' }, { image: '0123456789abcdef', text: 'Fen wakes', narration: 'fedcba9876543210' }, { video: '/x/v.mp4', cut_from: 1, cut_to: 3, transition: 'none' }], music: 'aaaaaaaaaaaaaaaa' });
  assert.strictEqual(plan.duck, true);
  const spec = B.editlySpec(plan, [{}, { file: '/j/img2.jpg', narration: '/j/n.wav', narrationSec: 6.2 }, { file: '/j/v.mp4', videoSec: 5 }], { outPath: '/j/edit.mp4', font: '/j/font.ttf' });
  assert.deepStrictEqual(spec.clips.map(c => c.duration), [4, 6.8, 2]);
  assert.strictEqual(spec.clips[0].layers[0].type, 'title-background');
  assert.deepStrictEqual(spec.clips[1].layers.map(l => l.type), ['image', 'subtitle', 'detached-audio']);
  assert.strictEqual(spec.clips[2].transition, null);
  assert.strictEqual(spec.allowRemoteRequests, false);
  assert.match(B.duckFilter(0.25, 10, true), /sidechaincompress/);
  assert.doesNotMatch(B.duckFilter(0.25, 10, false), /sidechaincompress/);
});

test('make_slideshow alias maps the old schema onto compose', () => {
  const c = B.slideshowToCompose({ slides: [{ title: 'Hi' }, { image: 'x', caption: 'cap', narration: 'n', seconds: 5 }], seconds_per_slide: 3, music: 'm', music_volume: 0.3, name: 'old' });
  assert.deepStrictEqual(c, { clips: [{ title: 'Hi' }, { image: 'x', narration: 'n', seconds: 5, text: 'cap' }], seconds_per_clip: 3, music: 'm', music_volume: 0.3, transition: 'fade', name: 'old' });
  assert.ok(B.checkCompose(c, 'make_slideshow'));
  assert.throws(() => B.slideshowToCompose({ slides: [] }), /error make_slideshow\.slides/);
});

test('deck: layouts, required fields, contrast warnings from a palette', () => {
  assert.throws(() => B.checkDeck({ title: 'D', slides: [{ layout: 'chart' }] }), /^Error: error make_deck\.slides\[0\]\.layout: must be one of title, /);
  assert.throws(() => B.checkDeck({ title: 'D', slides: [{ layout: 'bullets', title: 'x' }] }), /make_deck\.slides\[0\]\.bullets: required for layout bullets/);
  assert.throws(() => B.checkDeck({ title: 'D', slides: [{ layout: 'bullets', title: 'x', bullets: ['1', '2', '3', '4', '5', '6', '7'] }] }), /1-6 short lines/);
  assert.ok(B.checkDeck({ title: 'D', slides: [{ layout: 'big_number', number: 3, label: 'shots' }] }).slides[0].number === '3');
  assert.deepStrictEqual(B.contrastWarnings(B.THEMES.dark), []);
  assert.deepStrictEqual(B.contrastWarnings(B.THEMES.light), []);
  const c = B.deckColours('dark', ['#1b2a33', '#f2e8d5', '#c8553d']);
  assert.deepStrictEqual([c.bg, c.fg, c.accent], ['#1b2a33', '#f2e8d5', '#c8553d']);
  assert.match(B.contrastWarnings({ bg: '#777777', fg: '#888888', accent: '#808080', muted: '#7a7a7a' })[0], /below WCAG AA 4\.5:1/);
  assert.ok(Math.abs(B.contrast('#000000', '#ffffff') - 21) < 1e-9);
});

test('captions helpers', () => {
  const srt = '1\n00:00:00,000 --> 00:00:01,520\n Cint is online.\n\n2\n00:00:01,600 --> 00:00:03,000\nSecond line\n';
  assert.deepStrictEqual(B.srtCues(srt), [{ start: 0, end: 1.52, text: 'Cint is online.' }, { start: 1.6, end: 3, text: 'Second line' }]);
  assert.match(B.srtToVtt(srt), /^WEBVTT\n\n1\n00:00:00\.000 --> 00:00:01\.520/);
});

test('catalog topics cover the shot vocabulary', () => {
  for (const v of [...B.SHOT_SIZES, ...B.CAMERA_ANGLES, ...B.CAMERA_MOVEMENTS]) assert.ok(B.CATALOG['shot-language'].includes(v), v);
  assert.ok(B.CATALOG['shot-language'].includes('take by XucroYuri, MIT'));
});

// ---- studio.js tools with fake deps (no Dell, no GPU): the approval gate and verbatim bible use.
function fakeStudio() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synth-studio-'));
  const JOB_RE = /^[0-9a-f]{16}$/; let n = 0;
  const jobDir = id => path.join(dir, id);
  const H = { dir, JOB_RE, WAIT_MS: 60000, Pending: class extends Error {}, key: () => 'k'.repeat(20), llmBase: 'http://127.0.0.1:1', llmModel: 'm',
    jobDir, newId: () => (++n).toString(16).padStart(16, '0'), token: () => 't',
    saveJob: (id, j) => { fs.mkdirSync(jobDir(id), { recursive: true }); fs.writeFileSync(path.join(jobDir(id), 'job.json'), JSON.stringify(j)); },
    loadJob: id => JSON.parse(fs.readFileSync(path.join(jobDir(id), 'job.json'), 'utf8')) };
  const calls = [];
  const S = require('../studio.js')(H);
  H.tools = { ...S,
    async generate_image(a) { const p = H.applyBible(a, 'generate_image'); calls.push(p.prompt); const id = H.newId(); H.saveJob(id, { kind: 'image', status: 'done' }); return { text: `job_id ${id}`, job_id: id }; },
    async contact_sheet(a) { const id = H.newId(); H.saveJob(id, { kind: 'contact_sheet', status: 'done', images: a.images }); fs.writeFileSync(path.join(jobDir(id), 'contact_sheet.jpg'), 'x'); return { job_id: id }; } };
  return { S, H, calls, dir };
}

test('studio: bible locked, storyboard renders nothing until Mo approves, then one image per shot with the bible verbatim', async () => {
  const { S, calls } = fakeStudio();
  const w = await S.write_bible(bibleArgs);
  assert.match(w.text, /^project fox-tale: bible v1 locked: 2 characters \(char_fox, char_owl\)/);
  await assert.rejects(S.write_bible(bibleArgs), /^Error: error write_bible\.replace: the fox-tale bible is locked \(v1/);
  assert.match((await S.write_bible({ ...bibleArgs, replace: true })).text, /bible v2 locked/);
  const sb = await S.storyboard({ title: 'Lantern', project: 'fox-tale', shots: [shot(), shot({ shotSize: 'close', characters: ['char_fox', 'char_owl'], imagePrompt: 'Orla hands Fen a lantern' })] });
  assert.match(sb.text, /^job_id [0-9a-f]{16}: storyboard "Lantern" revision 1, 2 shots, 6 s, 16:9 \(1344x768\), NOT approved, nothing rendered \(no GPU used\)/);
  assert.strictEqual(calls.length, 0);
  await assert.rejects(S.approve_storyboard({ job_id: sb.job_id }), /^Error: error approve_storyboard\.mo_said: required/);
  assert.strictEqual(calls.length, 0, 'no GPU spend without approval');
  const r = await S.approve_storyboard({ job_id: sb.job_id, mo_said: 'yes go ahead' });
  assert.match(r.text, /approved by Mo and rendered: 2 images/);
  assert.strictEqual(calls.length, 2);
  assert.ok(calls[1].includes(`Fen: ${fox}`) && calls[1].includes(`Orla: ${owl}`) && calls[1].includes('Shot: Orla hands Fen a lantern. close-up on the face'));
  assert.match((await S.approve_storyboard({ job_id: sb.job_id })).text, /already rendered/);
  assert.strictEqual(calls.length, 2, 'never renders twice');
  const v = await S.validate_storyboard({ job_id: sb.job_id });
  assert.match(v.text, /0 schema errors/);
  await assert.rejects(S.catalog({ topic: 'nope' }), /^Error: error catalog\.topic: must be one of shot-language/);
  assert.match((await S.catalog({ topic: 'projects' })).text, /project fox-tale \(bible v2/);
});

test('studio: applyBible refuses ids without a project and unknown projects', async () => {
  const { H } = fakeStudio();
  assert.deepStrictEqual(H.applyBible({ prompt: ' a cat ' }, 'generate_image'), { prompt: 'a cat', project: null, bible_version: null });
  assert.throws(() => H.applyBible({ prompt: 'x', characters: ['char_fox'] }, 'generate_video'), /^Error: error generate_video\.characters: needs project/);
  assert.throws(() => H.applyBible({ prompt: 'x', project: 'nope' }, 'generate_image'), /error generate_image\.project: no bible for project nope/);
});

test('critique labels each problem with the right unit for the job kind', () => {
  assert.strictEqual(B.critiqueUnit('storyboard'), 'shot');
  assert.strictEqual(B.critiqueUnit('compose'), 'frame');
  assert.strictEqual(B.critiqueUnit('deck'), 'slide');
  assert.strictEqual(B.whereLabel('slide 4', 'shot'), 'shot 4');
  assert.strictEqual(B.whereLabel('Frames 2-3', 'frame'), 'frame 2-3');
  assert.strictEqual(B.whereLabel('all', 'shot'), 'all');
  assert.strictEqual(B.whereLabel('slide 6', 'slide'), 'slide 6');
});

test('compose critique frames avoid transitions', () => {
  const spec = { clips: [{ duration: 2.5, transition: { duration: 0.5 } }, { duration: 3.063, transition: { duration: 0.5 } }, { duration: 4.063, transition: { duration: 0.5 } }, { duration: 4, transition: { duration: 0.5 } }, { duration: 2, transition: { duration: 0.5 } }] };
  const t = B.cleanFrameTimes(spec, 9);
  assert.strictEqual(t.length, 5);
  const windows = [[2.0, 2.5], [4.563, 5.063], [8.126, 8.626], [11.626, 12.126]];
  for (const x of t) for (const [a, b] of windows) assert.ok(!(x > a && x < b), `${x} is inside transition ${a}-${b}`);
  assert.strictEqual(B.cleanFrameTimes({ clips: Array.from({ length: 20 }, () => ({ duration: 2, transition: { duration: 0.5 } })) }, 9).length, 9);
});

'use strict';
// Pure helpers for the Synth studio tools (no I/O; unit-tested in test/studio.test.js).
//  * Shot vocabulary and the shots.json storyboard schema are copied from take (github.com/XucroYuri/take, MIT,
//    packages/core/src/models/enums.ts + schemas.ts + skills/take/references/shot-language.md). take's cloud
//    render (gpt-image / Seedance / Minimax) is NOT used: Synth renders on the Dell.
//  * The locked style/character bible follows SKEL's studio.json registry (github.com/brandflowr/openSkeleton, MIT):
//    identity_lock is the canonical 30-60-word appearance text that every downstream prompt MUST reuse verbatim
//    (CharacterInjection format "consistency_modifier"); environments carry a style_lock; skins a style_text.
//  * Errors follow Ink style: "error <tool>.<arg>: <problem>; for example <fix>". Checks return warnings that are
//    flagged to Mo, never blocking.

// ---------------------------------------------------------------- shot language (take, MIT)
const SHOT_SIZES = ['extreme-wide', 'wide', 'full', 'medium', 'medium-close', 'close', 'extreme-close'];
const CAMERA_ANGLES = ['eye-level', 'low', 'high', 'dutch', 'over-shoulder', 'aerial', 'bird', 'worm'];
const CAMERA_MOVEMENTS = ['static', 'pan-left', 'pan-right', 'tilt-up', 'tilt-down', 'dolly-in', 'dolly-out', 'tracking',
  'handheld', 'crane-up', 'crane-down', 'zoom-in', 'zoom-out', 'orbit'];
const SHOT_STATUSES = ['draft', 'approved', 'rendering', 'done', 'failed'];
const ASPECT_RATIOS = { '16:9': [1344, 768], '9:16': [768, 1344], '1:1': [1024, 1024], '4:3': [1152, 864], '21:9': [1536, 656] };
const SIZE_WORDS = {
  'extreme-wide': 'extreme wide shot, tiny figures in a vast setting', wide: 'wide shot, full body with the surroundings',
  full: 'full shot, the whole body in frame', medium: 'medium shot from the waist up', 'medium-close': 'medium close-up from the chest up',
  close: 'close-up on the face', 'extreme-close': 'extreme close-up on one detail'
};
const ANGLE_WORDS = {
  'eye-level': 'eye-level camera', low: 'low-angle camera looking up', high: 'high-angle camera looking down', dutch: 'dutch tilted angle',
  'over-shoulder': 'over-the-shoulder view', aerial: 'aerial view', bird: "bird's-eye view straight down", worm: "worm's-eye view from the ground"
};
const SHOT_LANGUAGE = `Shot language (fixed vocabulary, copied from take by XucroYuri, MIT). Every shot uses exactly these values.
shotSize, widest to tightest:
  extreme-wide = environment, epic scale, figures tiny | wide = whole body + surroundings | full = whole body, complete action
  medium = waist up, dialogue/action | medium-close = chest up, emotion starts | close = face, emotional core | extreme-close = eyes/hands/object, peak tension
angle:
  eye-level = neutral, equal | low = power, threat, heroic | high = vulnerable, controlled, overview | dutch = unease, imbalance
  over-shoulder = conversation, point of view | aerial = big overview | bird = straight down, map-like | worm = from the ground, oppressive
movement (stills ignore it; generate_video uses it):
  static (default) | pan-left / pan-right = reveal, follow sideways | tilt-up / tilt-down = reveal height | dolly-in = emphasis, intrusion
  dolly-out = isolation, reveal, ending | tracking = follow the subject | handheld = documentary, panic | crane-up / crane-down = epic reveal
  zoom-in / zoom-out = like dolly but space does not change | orbit = 360-degree inspection, ritual
lighting is free text with direction + quality, e.g. "golden-hour backlight", "neon-glow", "hard-shadow noir", "soft-window daylight", "moonlit blue", "practical-lamp warm", "studio three-point".
Pacing: action = medium/close + handheld/tracking, 2-3 s | dialogue = medium/medium-close + static/pan, 4-6 s | climax = close/extreme-close + dolly-in, 5-8 s | transition = wide/extreme-wide + crane, 3 s.
Continuity rules (validate_storyboard warns, never blocks):
  1. Open a scene with an establishing shot (extreme-wide, wide or full) before you go close.
  2. Do not cut between two shots with the same shotSize and angle of the same characters (a jump cut): change size or angle.
  3. Keep the lighting of a location the same from shot to shot unless the story changes it (say so in notes).
  4. Characters and places come from the project bible and are named by id; their look is never re-described in imagePrompt.
  5. imagePrompt describes only this shot's action and framing; do not contradict shotSize/angle in it.
  6. A shot you will animate should be 1-5 s (draft) or 1-10 s (final).`;

// ---------------------------------------------------------------- Ink-style errors
const err = (tool, arg, problem, example) => new Error(`error ${tool}.${arg}: ${problem}; for example ${example}`);
const isStr = v => typeof v === 'string' && v.trim().length > 0;
const words = s => String(s).trim().split(/\s+/).filter(Boolean).length;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ID_RE = /^[a-z][a-z0-9_]{1,39}$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

// ---------------------------------------------------------------- bible (SKEL studio.json pattern)
// Input from write_bible; returns the normalised, locked bible (throws Ink errors).
function normaliseBible(a, now = new Date().toISOString()) {
  const T = 'write_bible';
  if (!isStr(a.project) || !SLUG_RE.test(a.project)) throw err(T, 'project', `must be a short lowercase slug (a-z, 0-9, -), got ${JSON.stringify(a.project)}`, 'project:"fox-tale"');
  if (!isStr(a.style_lock)) throw err(T, 'style_lock', 'required: the one look of the whole project (medium, palette, lighting, texture, lens), 10-80 words', 'style_lock:"hand-painted watercolour picture book, soft paper texture, warm autumn palette, gentle morning light, 35mm lens"');
  const sw = words(a.style_lock);
  if (sw < 10 || sw > 80) throw err(T, 'style_lock', `must be 10-80 words, got ${sw}`, 'style_lock:"hand-painted watercolour picture book, soft paper texture, warm autumn palette, gentle morning light, 35mm lens"');
  const chars = a.characters == null ? [] : a.characters;
  if (!Array.isArray(chars) || chars.length > 12) throw err(T, 'characters', 'must be a list of at most 12 characters', 'characters:[{id:"char_fox",name:"Fen the fox",identity_lock:"..."}]');
  const envs = a.environments == null ? [] : a.environments;
  if (!Array.isArray(envs) || envs.length > 12) throw err(T, 'environments', 'must be a list of at most 12 environments', 'environments:[{id:"env_forest",name:"Birch forest",style_lock:"..."}]');
  const seen = new Set();
  const outChars = chars.map((c, i) => {
    const at = `characters[${i}]`;
    if (!c || typeof c !== 'object') throw err(T, at, 'must be an object', '{id:"char_fox",name:"Fen",identity_lock:"..."}');
    if (!isStr(c.id) || !ID_RE.test(c.id) || !c.id.startsWith('char_')) throw err(T, `${at}.id`, `must look like char_<name> (lowercase, _), got ${JSON.stringify(c.id)}`, 'id:"char_fox"');
    if (seen.has(c.id)) throw err(T, `${at}.id`, `duplicate id ${c.id}`, 'give each character its own id');
    seen.add(c.id);
    if (!isStr(c.name)) throw err(T, `${at}.name`, 'required', 'name:"Fen the fox"');
    if (!isStr(c.identity_lock)) throw err(T, `${at}.identity_lock`, 'required: the canonical 30-60-word appearance (species/age, build, face, hair/fur, eyes, wardrobe, one or two marks)', 'identity_lock:"Small red fox with a white-tipped tail, amber eyes, a torn left ear, ..."');
    const n = words(c.identity_lock);
    if (n < 30 || n > 60) throw err(T, `${at}.identity_lock`, `must be 30-60 words (SKEL identity_lock), got ${n}`, 'describe body, face, colours, wardrobe and one distinguishing mark in about 40 words');
    return { id: c.id, name: String(c.name).trim(), identity_lock: String(c.identity_lock).trim().replace(/\s+/g, ' ') };
  });
  const outEnvs = envs.map((e, i) => {
    const at = `environments[${i}]`;
    if (!e || typeof e !== 'object') throw err(T, at, 'must be an object', '{id:"env_forest",name:"Birch forest",style_lock:"..."}');
    if (!isStr(e.id) || !ID_RE.test(e.id) || !e.id.startsWith('env_')) throw err(T, `${at}.id`, `must look like env_<name>, got ${JSON.stringify(e.id)}`, 'id:"env_forest"');
    if (seen.has(e.id)) throw err(T, `${at}.id`, `duplicate id ${e.id}`, 'give each environment its own id');
    seen.add(e.id);
    if (!isStr(e.name)) throw err(T, `${at}.name`, 'required', 'name:"Birch forest at dawn"');
    if (!isStr(e.style_lock) || words(e.style_lock) < 8 || words(e.style_lock) > 60) throw err(T, `${at}.style_lock`, 'required, 8-60 words: the place, its materials, light and weather, the same in every shot', 'style_lock:"silver birch forest, mossy ground, low mist, cool dawn light through the trees"');
    return { id: e.id, name: String(e.name).trim(), style_lock: String(e.style_lock).trim().replace(/\s+/g, ' ') };
  });
  const palette = a.palette == null ? [] : a.palette;
  if (!Array.isArray(palette) || palette.length > 6 || !palette.every(c => HEX_RE.test(c))) throw err(T, 'palette', 'must be up to 6 colours as #rrggbb (used by make_deck themes)', 'palette:["#1b2a33","#f2e8d5","#c8553d"]');
  if (a.negative != null && !isStr(a.negative)) throw err(T, 'negative', 'must be text', 'negative:"no text, no watermark"');
  return { project: a.project, studio_version: '1.0', style_lock: String(a.style_lock).trim().replace(/\s+/g, ' '), palette: palette.map(c => c.toLowerCase()),
    characters: outChars, environments: outEnvs, negative: a.negative ? String(a.negative).trim() : null, creative_status: 'locked', modified_at: now };
}

// The text prepended (verbatim) to every image/video prompt that names a project. Shared by generate_image,
// generate_video and approve_storyboard, so the bible is never paraphrased.
function biblePrompt(bible, { characters = [], environment = null, tool = 'generate_image' } = {}) {
  if (!Array.isArray(characters)) throw err(tool, 'characters', 'must be a list of character ids from the bible', `characters:["${(bible.characters[0] || { id: 'char_x' }).id}"]`);
  const byId = Object.fromEntries(bible.characters.map(c => [c.id, c]));
  const parts = [`Style: ${bible.style_lock}`];
  for (const id of characters) {
    const c = byId[id];
    if (!c) throw err(tool, 'characters', `${JSON.stringify(id)} is not in the ${bible.project} bible (${bible.characters.map(x => x.id).join(', ') || 'no characters'})`, `characters:["${(bible.characters[0] || { id: 'char_x' }).id}"]`);
    parts.push(`${c.name}: ${c.identity_lock}`);
  }
  if (environment != null) {
    const e = bible.environments.find(x => x.id === environment);
    if (!e) throw err(tool, 'environment', `${JSON.stringify(environment)} is not in the ${bible.project} bible (${bible.environments.map(x => x.id).join(', ') || 'no environments'})`, `environment:"${(bible.environments[0] || { id: 'env_x' }).id}"`);
    parts.push(`Setting: ${e.style_lock}`);
  }
  return parts.join('\n');
}
function withBible(bible, prompt, opts) {
  const head = biblePrompt(bible, opts);
  return `${head}\nShot: ${String(prompt).trim()}${bible.negative ? `\nAvoid: ${bible.negative}` : ''}`;
}

// ---------------------------------------------------------------- storyboard (take shots.json)
const SHOT_KEYS = new Set(['summary', 'durationSec', 'shotSize', 'angle', 'movement', 'characters', 'environment', 'location', 'lighting', 'tone', 'imagePrompt', 'videoPrompt', 'notes', 'beat']);
// a: storyboard tool args; bible: the project bible or null. Returns a take-schema storyboard (all shots draft).
function normaliseBoard(a, bible) {
  const T = 'storyboard';
  if (!isStr(a.title)) throw err(T, 'title', 'required', 'title:"Fen finds the lantern"');
  const ar = a.aspect_ratio ?? '16:9';
  if (!Object.prototype.hasOwnProperty.call(ASPECT_RATIOS, ar)) throw err(T, 'aspect_ratio', `must be one of ${Object.keys(ASPECT_RATIOS).join(', ')}, got ${JSON.stringify(ar)}`, 'aspect_ratio:"16:9"');
  if (!Array.isArray(a.shots) || a.shots.length < 1 || a.shots.length > 24) throw err(T, 'shots', 'must be a list of 1-24 shots', 'shots:[{summary:"...",durationSec:3,shotSize:"wide",angle:"eye-level",movement:"static",characters:[],imagePrompt:"..."}]');
  const beats = a.beats == null ? [] : a.beats;
  if (!Array.isArray(beats) || beats.length > 24) throw err(T, 'beats', 'must be a list of at most 24 beats', 'beats:[{summary:"Fen wakes",purpose:"set the mood"}]');
  const outBeats = beats.map((b, i) => {
    if (!b || !isStr(b.summary) || !isStr(b.purpose)) throw err(T, `beats[${i}]`, 'needs summary and purpose', '{summary:"Fen wakes",purpose:"set the mood",emotion:"calm"}');
    return { id: `beat-${String(i + 1).padStart(3, '0')}`, index: i + 1, summary: String(b.summary).trim(), purpose: String(b.purpose).trim(), ...(isStr(b.emotion) ? { emotion: String(b.emotion).trim() } : {}) };
  });
  const charIds = bible ? new Set(bible.characters.map(c => c.id)) : null;
  const envIds = bible ? new Set(bible.environments.map(e => e.id)) : null;
  const shots = a.shots.map((s, i) => {
    const at = `shots[${i}]`, n = i + 1;
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw err(T, at, 'must be an object', '{summary:"...",durationSec:3,shotSize:"wide",angle:"eye-level",movement:"static",characters:[],imagePrompt:"..."}');
    for (const k of Object.keys(s)) if (!SHOT_KEYS.has(k)) throw err(T, `${at}.${k}`, `unknown field (fields: ${[...SHOT_KEYS].join(', ')})`, 'remove it, or put it in notes');
    if (!isStr(s.summary)) throw err(T, `${at}.summary`, 'required: one line of what happens', 'summary:"Fen spots a glow between the trees"');
    if (!(typeof s.durationSec === 'number' && s.durationSec > 0 && s.durationSec <= 30)) throw err(T, `${at}.durationSec`, `must be a number of seconds >0 and <=30, got ${JSON.stringify(s.durationSec)}`, 'durationSec:3');
    if (!SHOT_SIZES.includes(s.shotSize)) throw err(T, `${at}.shotSize`, `must be one of ${SHOT_SIZES.join(', ')}, got ${JSON.stringify(s.shotSize)}`, 'shotSize:"medium" (catalog("shot-language") lists them)');
    if (!CAMERA_ANGLES.includes(s.angle)) throw err(T, `${at}.angle`, `must be one of ${CAMERA_ANGLES.join(', ')}, got ${JSON.stringify(s.angle)}`, 'angle:"eye-level"');
    const movement = s.movement ?? 'static';
    if (!CAMERA_MOVEMENTS.includes(movement)) throw err(T, `${at}.movement`, `must be one of ${CAMERA_MOVEMENTS.join(', ')}, got ${JSON.stringify(movement)}`, 'movement:"static"');
    const chars = s.characters ?? [];
    if (!Array.isArray(chars) || !chars.every(isStr)) throw err(T, `${at}.characters`, 'must be a list of character ids (or [] for none)', bible ? `characters:["${[...charIds][0] || 'char_x'}"]` : 'characters:[]');
    if (charIds) for (const c of chars) if (!charIds.has(c)) throw err(T, `${at}.characters`, `${JSON.stringify(c)} is not in the ${bible.project} bible (${[...charIds].join(', ') || 'no characters'})`, `characters:["${[...charIds][0] || 'char_x'}"]`);
    if (s.environment != null) {
      if (!envIds) throw err(T, `${at}.environment`, 'needs a project with a bible', 'project:"fox-tale" (write_bible first), or use location instead');
      if (!envIds.has(s.environment)) throw err(T, `${at}.environment`, `${JSON.stringify(s.environment)} is not in the ${bible.project} bible (${[...envIds].join(', ') || 'no environments'})`, `environment:"${[...envIds][0] || 'env_x'}"`);
    }
    if (!isStr(s.imagePrompt)) throw err(T, `${at}.imagePrompt`, 'required: this shot\'s action and framing only (the bible adds the look)', 'imagePrompt:"Fen peers out from behind a birch trunk at a warm glow"');
    const beatN = s.beat ?? (outBeats.length ? null : 1);
    if (outBeats.length && !(Number.isInteger(beatN) && beatN >= 1 && beatN <= outBeats.length)) throw err(T, `${at}.beat`, `must be the beat number 1-${outBeats.length}`, 'beat:1');
    const o = { id: `shot-${String(n).padStart(3, '0')}`, beatId: `beat-${String(beatN).padStart(3, '0')}`, index: n, summary: String(s.summary).trim(), durationSec: s.durationSec,
      shotSize: s.shotSize, angle: s.angle, movement, characters: chars.map(String) };
    for (const k of ['environment', 'location', 'lighting', 'tone']) if (isStr(s[k])) o[k] = String(s[k]).trim();
    o.imagePrompt = String(s.imagePrompt).trim();
    if (isStr(s.videoPrompt)) o.videoPrompt = String(s.videoPrompt).trim();
    o.status = 'draft';
    if (isStr(s.notes)) o.notes = String(s.notes).trim();
    return o;
  });
  return { title: String(a.title).trim(), aspectRatio: ar, ...(isStr(a.style) ? { style: String(a.style).trim() } : {}), source: 'agent', shots, ...(outBeats.length ? { beats: outBeats } : {}) };
}

// Schema check of a stored shots.json (same rules as take's zod schema + integrity) -> list of error strings.
function schemaIssues(b) {
  const out = [];
  if (!b || typeof b !== 'object') return ['storyboard is not an object'];
  if (!isStr(b.title)) out.push('title: required');
  if (!Object.prototype.hasOwnProperty.call(ASPECT_RATIOS, b.aspectRatio)) out.push(`aspectRatio: ${JSON.stringify(b.aspectRatio)} is not one of ${Object.keys(ASPECT_RATIOS).join(', ')}`);
  if (!['agent', 'manual', 'imported'].includes(b.source)) out.push('source: must be agent, manual or imported');
  if (!Array.isArray(b.shots)) return out.concat('shots: must be a list');
  const beatIds = new Set((b.beats || []).map(x => x.id)), ids = new Set();
  b.shots.forEach((s, i) => {
    const p = `shots[${i}]`;
    if (!/^shot-\d+$/.test(s.id || '')) out.push(`${p}.id: must match shot-<n>`);
    if (ids.has(s.id)) out.push(`${p}.id: duplicate ${s.id}`); ids.add(s.id);
    if (s.index !== i + 1) out.push(`${p}.index: expected ${i + 1}, got ${s.index}`);
    if (!/^beat-\d+$/.test(s.beatId || '')) out.push(`${p}.beatId: must match beat-<n>`);
    if (beatIds.size && !beatIds.has(s.beatId)) out.push(`${p}.beatId: dangling beat reference ${s.beatId}`);
    if (!isStr(s.summary)) out.push(`${p}.summary: required`);
    if (!(s.durationSec > 0)) out.push(`${p}.durationSec: must be positive`);
    if (!SHOT_SIZES.includes(s.shotSize)) out.push(`${p}.shotSize: ${JSON.stringify(s.shotSize)} not in the vocabulary`);
    if (!CAMERA_ANGLES.includes(s.angle)) out.push(`${p}.angle: ${JSON.stringify(s.angle)} not in the vocabulary`);
    if (!CAMERA_MOVEMENTS.includes(s.movement)) out.push(`${p}.movement: ${JSON.stringify(s.movement)} not in the vocabulary`);
    if (!Array.isArray(s.characters)) out.push(`${p}.characters: must be a list`);
    if (!isStr(s.imagePrompt)) out.push(`${p}.imagePrompt: required`);
    if (!SHOT_STATUSES.includes(s.status)) out.push(`${p}.status: ${JSON.stringify(s.status)} not one of ${SHOT_STATUSES.join(', ')}`);
  });
  return out;
}

// Continuity / craft warnings (never blocking). Returns [{shot, warning}].
const CLOSE_WORDS = /\b(close[- ]?up|extreme close|macro)\b/i, WIDE_WORDS = /\b(wide shot|extreme wide|establishing shot|long shot)\b/i;
function continuityWarnings(b, bible) {
  const w = [], shots = b.shots || [];
  const add = (shot, warning) => w.push({ shot, warning });
  if (!bible) add(null, 'no project bible: characters and style can drift between shots (write_bible, then storyboard with project)');
  if (shots.length && !['extreme-wide', 'wide', 'full'].includes(shots[0].shotSize)) add(1, `opens on a ${shots[0].shotSize} shot; continuity rule 1 wants an establishing shot (extreme-wide, wide or full) first`);
  const lightByPlace = {};
  shots.forEach((s, i) => {
    const n = i + 1, prev = shots[i - 1];
    if (prev && prev.shotSize === s.shotSize && prev.angle === s.angle && JSON.stringify([...prev.characters].sort()) === JSON.stringify([...s.characters].sort()) && s.characters.length)
      add(n, `same shotSize (${s.shotSize}) and angle (${s.angle}) as shot ${n - 1} with the same characters: a jump cut; change the size or the angle`);
    if (CLOSE_WORDS.test(s.imagePrompt) && ['extreme-wide', 'wide', 'full'].includes(s.shotSize)) add(n, `imagePrompt says close-up but shotSize is ${s.shotSize}`);
    if (WIDE_WORDS.test(s.imagePrompt) && ['close', 'extreme-close', 'medium-close'].includes(s.shotSize)) add(n, `imagePrompt says wide/establishing but shotSize is ${s.shotSize}`);
    if (bible && s.characters.length) for (const c of bible.characters) if (s.characters.includes(c.id) && s.imagePrompt.toLowerCase().includes(c.identity_lock.toLowerCase().split(/[,.]/)[0].slice(0, 24)))
      add(n, `imagePrompt repeats ${c.id}'s look; the bible adds it verbatim, describe only the action`);
    const place = s.environment || s.location;
    if (place && s.lighting) {
      if (lightByPlace[place] && lightByPlace[place].lighting !== s.lighting && !(s.notes && /light/i.test(s.notes)))
        add(n, `lighting "${s.lighting}" differs from shot ${lightByPlace[place].n} in the same place ("${lightByPlace[place].lighting}"); keep it or explain the change in notes`);
      if (!lightByPlace[place]) lightByPlace[place] = { lighting: s.lighting, n };
    }
    if (s.durationSec > 10) add(n, `${s.durationSec} s is longer than one generate_video clip (draft 1-5 s, final 1-10 s); split it if it will be animated`);
  });
  return w;
}

function boardMarkdown(b) {
  const total = b.shots.reduce((t, s) => t + s.durationSec, 0);
  const lines = [`# ${b.title}`, `${b.shots.length} shots, ${+total.toFixed(1)} s, ${b.aspectRatio}${b.style ? ', ' + b.style : ''}`, ''];
  for (const s of b.shots)
    lines.push(`${s.index}. [${s.durationSec} s] ${s.shotSize}, ${s.angle}, ${s.movement}${s.characters.length ? ' | ' + s.characters.join(', ') : ''}${s.environment || s.location ? ' | ' + (s.environment || s.location) : ''}${s.lighting ? ' | ' + s.lighting : ''}: ${s.summary}${s.status !== 'draft' ? ` (${s.status})` : ''}`);
  return lines.join('\n');
}
// The shot part of one storyboard frame's prompt (camera words from the fixed vocabulary). The bible is added by
// generate_image itself (applyBible -> withBible), the one place it enters any prompt.
function shotPrompt(b, s) {
  const cam = `${SIZE_WORDS[s.shotSize]}, ${ANGLE_WORDS[s.angle]}`;
  return `${s.imagePrompt}. ${cam}${s.lighting ? ', ' + s.lighting : ''}${s.location && !s.environment ? ', ' + s.location : ''}${b.style ? '. ' + b.style : ''}`;
}

// ---------------------------------------------------------------- compose (editly)
const TRANSITIONS = ['fade', 'fadegrayscale', 'directional-left', 'directional-right', 'crosszoom', 'dreamy', 'circleopen', 'cube', 'none'];
const COMPOSE_SIZES = { '1280x720': [1280, 720], '1920x1080': [1920, 1080], '720x1280': [720, 1280], '1080x1080': [1080, 1080] };
const CLIP_KEYS = new Set(['image', 'video', 'title', 'text', 'narration', 'seconds', 'cut_from', 'cut_to', 'transition', 'background']);
// a: compose args -> validated plan (refs unresolved). Throws Ink errors.
function checkCompose(a, T = 'compose') {
  if (!Array.isArray(a.clips) || a.clips.length < 1 || a.clips.length > 60) throw err(T, 'clips', 'must be a list of 1-60 clips', 'clips:[{title:"Fen and the lantern"},{image:"<image job_id>",text:"Fen wakes",seconds:4}]');
  const size = a.size ?? '1280x720';
  if (!COMPOSE_SIZES[size]) throw err(T, 'size', `must be one of ${Object.keys(COMPOSE_SIZES).join(', ')}, got ${JSON.stringify(size)}`, 'size:"1280x720"');
  const per = a.seconds_per_clip ?? 4;
  if (!(typeof per === 'number' && per >= 1 && per <= 60)) throw err(T, 'seconds_per_clip', `must be 1-60, got ${JSON.stringify(per)}`, 'seconds_per_clip:4');
  const tr = a.transition ?? 'fade';
  if (!TRANSITIONS.includes(tr)) throw err(T, 'transition', `must be one of ${TRANSITIONS.join(', ')}, got ${JSON.stringify(tr)}`, 'transition:"fade"');
  const vol = a.music_volume ?? 0.25;
  if (!(typeof vol === 'number' && vol > 0 && vol <= 1)) throw err(T, 'music_volume', `must be >0 and <=1, got ${JSON.stringify(vol)}`, 'music_volume:0.25');
  if (a.duck != null && typeof a.duck !== 'boolean') throw err(T, 'duck', 'must be true or false', 'duck:true');
  if (a.duck && !a.music) throw err(T, 'duck', 'only applies with music', 'add music:"<song job_id>" or drop duck');
  const clips = a.clips.map((c, i) => {
    const at = `clips[${i}]`;
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw err(T, at, 'must be an object', '{image:"<job_id>",seconds:4}');
    for (const k of Object.keys(c)) if (!CLIP_KEYS.has(k)) throw err(T, `${at}.${k}`, `unknown field (fields: ${[...CLIP_KEYS].join(', ')})`, 'remove it');
    const kinds = ['image', 'video', 'title'].filter(k => c[k] != null && String(c[k]).trim());
    if (kinds.length !== 1) throw err(T, at, `give exactly one of image, video or title (got ${kinds.join(', ') || 'none'})`, '{video:"<video job_id>"}');
    if (c.seconds != null && !(typeof c.seconds === 'number' && c.seconds >= 0.5 && c.seconds <= 60)) throw err(T, `${at}.seconds`, `must be 0.5-60, got ${JSON.stringify(c.seconds)}`, 'seconds:4');
    for (const k of ['cut_from', 'cut_to']) if (c[k] != null && (kinds[0] !== 'video' || !(typeof c[k] === 'number' && c[k] >= 0))) throw err(T, `${at}.${k}`, 'only for video clips, seconds >= 0', `${k}:1.5`);
    if (c.cut_from != null && c.cut_to != null && !(c.cut_to > c.cut_from)) throw err(T, `${at}.cut_to`, 'must be after cut_from', 'cut_from:0.5, cut_to:3');
    if (c.transition != null && !TRANSITIONS.includes(c.transition)) throw err(T, `${at}.transition`, `must be one of ${TRANSITIONS.join(', ')}`, 'transition:"crosszoom"');
    if (c.text != null && !isStr(c.text)) throw err(T, `${at}.text`, 'must be text', 'text:"Fen wakes"');
    if (c.background != null && (kinds[0] !== 'title' || !HEX_RE.test(c.background))) throw err(T, `${at}.background`, 'only for title clips, #rrggbb', 'background:"#111418"');
    return { n: i + 1, kind: kinds[0], ref: kinds[0] === 'title' ? null : String(c[kinds[0]]).trim(), title: kinds[0] === 'title' ? String(c.title) : null,
      text: c.text ? String(c.text) : null, narration: c.narration ? String(c.narration).trim() : null, seconds: c.seconds ?? null,
      cut_from: c.cut_from ?? null, cut_to: c.cut_to ?? null, transition: c.transition ?? null, background: c.background ?? null };
  });
  return { clips, size, width: COMPOSE_SIZES[size][0], height: COMPOSE_SIZES[size][1], per, transition: tr, music: a.music ? String(a.music).trim() : null, music_volume: vol, duck: a.duck ?? Boolean(a.music) };
}
// make_slideshow (hidden alias since compose landed): old slides schema -> compose args. Same behaviour, one engine.
function slideshowToCompose(a) {
  if (!Array.isArray(a.slides) || !a.slides.length) throw err('make_slideshow', 'slides', 'a non-empty list is required', 'slides:[{title:"Intro"},{image:"<job_id>",caption:"..."}]');
  return {
    clips: a.slides.map(s => {
      const c = {};
      for (const k of ['image', 'video', 'title', 'narration', 'seconds']) if (s && s[k] != null) c[k] = s[k];
      if (s && s.caption != null) c.text = s.caption;
      return c;
    }),
    ...(a.seconds_per_slide != null ? { seconds_per_clip: a.seconds_per_slide } : {}),
    ...(a.music != null ? { music: a.music } : {}), ...(a.music_volume != null ? { music_volume: a.music_volume } : {}),
    transition: 'fade', ...(a.name != null ? { name: a.name } : {})
  };
}
// plan + resolved files (container paths) + measured durations -> editly JSON spec.
// files: [{file, narration, narrationSec, videoSec}] per clip, font: container path of the .ttf.
function editlySpec(plan, files, { outPath, font }) {
  const clips = plan.clips.map((c, i) => {
    const f = files[i] || {};
    let dur = c.seconds;
    if (c.kind === 'video') {
      const span = (c.cut_to ?? f.videoSec) - (c.cut_from ?? 0);
      dur = dur ?? span;
    }
    dur = dur ?? plan.per;
    if (f.narrationSec) dur = Math.max(dur, f.narrationSec + 0.6);
    dur = +dur.toFixed(3);
    const layers = [];
    if (c.kind === 'video') layers.push({ type: 'video', path: f.file, resizeMode: 'contain-blur', ...(c.cut_from != null ? { cutFrom: c.cut_from } : {}), ...(c.cut_to != null ? { cutTo: c.cut_to } : {}) });
    else if (c.kind === 'image') layers.push({ type: 'image', path: f.file, resizeMode: 'contain-blur', zoomDirection: null });
    else layers.push({ type: 'title-background', text: c.title, background: { type: 'fill-color', color: c.background || '#111418' } });
    if (c.text) layers.push({ type: 'subtitle', text: c.text });
    if (f.narration) layers.push({ type: 'detached-audio', path: f.narration, start: 0.3 });
    const t = c.transition ?? plan.transition;
    return { duration: dur, transition: t === 'none' ? null : { name: t, duration: Math.min(0.5, dur / 4) }, layers };
  });
  return { outPath, width: plan.width, height: plan.height, fps: 24, allowRemoteRequests: false, keepSourceAudio: true, clipsAudioVolume: 1,
    defaults: { layer: { fontPath: font }, transition: { name: plan.transition === 'none' ? 'fade' : plan.transition, duration: 0.5 } }, clips, audioTracks: [] };
}
// ffmpeg filter that lays the music under the edit and ducks it under speech/clip audio (sidechain).
function duckFilter(vol, total, duck) {
  const fadeAt = Math.max(0, total - 1.5).toFixed(3);
  const m = `[1:a]aresample=48000,volume=${vol},atrim=0:${total.toFixed(3)},afade=t=out:st=${fadeAt}:d=1.5[m]`;
  if (!duck) return `${m};[0:a][m]amix=inputs=2:duration=first:normalize=0[a]`;
  return `${m};[0:a]asplit=2[v][key];[m][key]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=400:makeup=1[md];[v][md]amix=inputs=2:duration=first:normalize=0[a]`;
}

// ---------------------------------------------------------------- deck
const LAYOUTS = ['title', 'section', 'bullets', 'image_left', 'image_right', 'full_image', 'quote', 'big_number'];
const SLIDE_KEYS = new Set(['layout', 'title', 'subtitle', 'bullets', 'image', 'caption', 'quote', 'by', 'number', 'label', 'notes']);
const THEMES = { dark: { bg: '#111418', fg: '#f2f2f2', accent: '#4fa3ff', muted: '#a8b0b8' }, light: { bg: '#fafaf7', fg: '#1d2329', accent: '#c8553d', muted: '#5b6670' } };
const NEEDS = { title: ['title'], section: ['title'], bullets: ['title', 'bullets'], image_left: ['title', 'image'], image_right: ['title', 'image'], full_image: ['image'], quote: ['quote'], big_number: ['number', 'label'] };
function checkDeck(a) {
  const T = 'make_deck';
  if (!isStr(a.title)) throw err(T, 'title', 'required (the deck title, also the file name)', 'title:"Fen and the lantern: pitch"');
  if (!Array.isArray(a.slides) || a.slides.length < 1 || a.slides.length > 40) throw err(T, 'slides', 'must be a list of 1-40 slides', 'slides:[{layout:"title",title:"...",subtitle:"..."}]');
  const theme = a.theme ?? 'dark';
  if (!THEMES[theme]) throw err(T, 'theme', `must be dark or light, got ${JSON.stringify(theme)}`, 'theme:"dark" (a project bible palette overrides the colours)');
  const slides = a.slides.map((s, i) => {
    const at = `slides[${i}]`;
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw err(T, at, 'must be an object', '{layout:"bullets",title:"...",bullets:["..."]}');
    for (const k of Object.keys(s)) if (!SLIDE_KEYS.has(k)) throw err(T, `${at}.${k}`, `unknown field (fields: ${[...SLIDE_KEYS].join(', ')})`, 'remove it, or put it in notes');
    if (!LAYOUTS.includes(s.layout)) throw err(T, `${at}.layout`, `must be one of ${LAYOUTS.join(', ')}, got ${JSON.stringify(s.layout)}`, 'layout:"bullets" (catalog("deck") shows each)');
    for (const k of NEEDS[s.layout]) if (s[k] == null || (k === 'bullets' ? !Array.isArray(s[k]) || !s[k].length : !isStr(String(s[k])))) throw err(T, `${at}.${k}`, `required for layout ${s.layout}`, k === 'bullets' ? 'bullets:["One point","Another point"]' : `${k}:"..."`);
    if (s.bullets != null && (!Array.isArray(s.bullets) || s.bullets.length > 6 || !s.bullets.every(isStr))) throw err(T, `${at}.bullets`, 'must be 1-6 short lines of text', 'bullets:["Fen is curious","The lantern is magic"]');
    for (const k of ['title', 'subtitle', 'caption', 'quote', 'by', 'label', 'notes']) if (s[k] != null && !isStr(s[k])) throw err(T, `${at}.${k}`, 'must be text', `${k}:"..."`);
    if (s.number != null && !isStr(String(s.number))) throw err(T, `${at}.number`, 'must be a short number or text', 'number:"3x"');
    return { ...s, number: s.number != null ? String(s.number) : undefined };
  });
  return { title: String(a.title).trim(), theme, slides };
}
function hexLum(h) {
  const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) { const [x, y] = [hexLum(a), hexLum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); }
// Theme colours: the bible palette (darkest = bg for dark, lightest for light; most saturated other = accent), else the preset.
function deckColours(theme, palette) {
  const base = { ...THEMES[theme] };
  if (!palette || palette.length < 2) return base;
  const byLum = [...palette].sort((p, q) => hexLum(p) - hexLum(q));
  base.bg = theme === 'dark' ? byLum[0] : byLum[byLum.length - 1];
  base.fg = theme === 'dark' ? byLum[byLum.length - 1] : byLum[0];
  const rest = palette.filter(c => c !== base.bg && c !== base.fg);
  if (rest.length) base.accent = rest[0];
  return base;
}
function contrastWarnings(col) {
  const w = [];
  const fg = contrast(col.fg, col.bg), ac = contrast(col.accent, col.bg), mu = contrast(col.muted, col.bg);
  if (fg < 4.5) w.push(`body text contrast ${fg.toFixed(2)}:1 on the background is below WCAG AA 4.5:1`);
  if (ac < 3) w.push(`accent colour contrast ${ac.toFixed(2)}:1 on the background is below 3:1 for large text`);
  if (mu < 3) w.push(`caption colour contrast ${mu.toFixed(2)}:1 on the background is below 3:1`);
  return w;
}

// ---------------------------------------------------------------- captions
function srtToVtt(srt) {
  return 'WEBVTT\n\n' + String(srt).replace(/\r/g, '').replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2').trim() + '\n';
}
function srtCues(srt) {
  return String(srt).replace(/\r/g, '').split(/\n\s*\n/).map(b => b.trim()).filter(Boolean).map(b => {
    const l = b.split('\n'), m = /(\d\d):(\d\d):(\d\d),(\d\d\d) --> (\d\d):(\d\d):(\d\d),(\d\d\d)/.exec(l[1] || '');
    if (!m) return null;
    const t = (h, mi, s, ms) => +h * 3600 + +mi * 60 + +s + +ms / 1000;
    return { start: t(m[1], m[2], m[3], m[4]), end: t(m[5], m[6], m[7], m[8]), text: l.slice(2).join(' ').trim() };
  }).filter(Boolean);
}

// ---------------------------------------------------------------- catalog
const CATALOG = {
  'shot-language': SHOT_LANGUAGE,
  bible: `write_bible: one locked look per project (SKEL studio.json pattern, brandflowr/openSkeleton, MIT).
  project: slug, e.g. "fox-tale". style_lock: 10-80 words, the medium/palette/light/lens of everything.
  characters: [{id:"char_<name>", name, identity_lock: 30-60 words: species/age, build, face, hair/fur, eyes, wardrobe, one or two marks}].
  environments: [{id:"env_<name>", name, style_lock: 8-60 words}]. palette: up to 6 #rrggbb (deck colours). negative: what to avoid.
  Every generate_image / generate_video / storyboard shot with project + characters/environment starts with this text, verbatim:
    Style: <style_lock> / <Name>: <identity_lock> / Setting: <style_lock> / Shot: <your prompt> / Avoid: <negative>
  So never re-describe a character's look in a prompt: name them by id. A locked bible changes only with replace:true, when Mo asks.`,
  storyboard: `Storyboard workflow (board approval before any GPU spend):
  1. (optional) write_bible for the project.  2. storyboard: title, aspect_ratio (16:9 default), project, shots (fields below).
     It saves shots.json (take's schema), checks continuity and returns the shot list. Nothing is rendered.
  3. Reply to Mo with the shot list and the warnings; ask him to approve or change it. Revise with storyboard + job_id (resets approval).
  4. Only after Mo approves in his own words: approve_storyboard(job_id, mo_said:"<his words>"). It renders one image per shot
     (generate_image, queued on the Dell, never cancelled), then a numbered contact sheet. Call it again with the job_id to keep waiting.
  5. critique(job_id) for a Vision review of the contact sheet (2-3 rounds max), then finish.
  Shot fields: summary, durationSec, shotSize, angle, movement (catalog "shot-language"), characters [ids], environment (id) or location,
  lighting, tone, imagePrompt (action + framing only), videoPrompt (motion, for generate_video later), notes, beat (number, with beats).`,
  compose: `compose: one timeline, assembled here with editly (mifi/editly, MIT) in a local container (no network) + ffmpeg.
  clips (in order), each exactly one of: image (job_id/path, shown still), video (job_id/path, its own sound kept; cut_from/cut_to seconds), title (text card; background #rrggbb).
  Per clip: text (caption at the bottom), narration (speech job_id/audio file; the clip lasts at least as long), seconds, transition.
  Whole edit: size 1280x720 (default) | 1920x1080 | 720x1280 | 1080x1080; seconds_per_clip (default 4); transition (default fade):
  ${TRANSITIONS.join(', ')}; music (song job_id/file) at music_volume (default 0.25), duck (default true with music: music dips under speech and clip sound).
  make_slideshow is the old name of compose (still accepted).`,
  deck: `make_deck: one editable .pptx (power-pptx, MIT: fit_text so text fits its box, slide.lint for overflow/off-slide), rendered here to check.
  theme dark|light (a project bible palette overrides the colours). Layouts and their fields:
    title: title, subtitle | section: title, subtitle | bullets: title, bullets (1-6 short lines)
    image_left / image_right: title, image (job_id/path), bullets or caption | full_image: image, caption
    quote: quote, by | big_number: number, label, caption.   Any slide: notes (speaker notes).
  Keep bullets under about 10 words. After make_deck: critique(job_id) (deterministic checks + Vision, 2-3 rounds), then finish.`,
  captions: `make_captions: timed captions with whisper.cpp (ggml small, CPU on this machine; no Dell, no GPU).
  source: a speech/song/video/compose job_id or an audio/video file. language: "auto" (default) or a code like "en".
  Writes captions.srt + captions.vtt. burn_in:true (video sources only) also writes captioned.mp4 with the text drawn in.
  Long audio takes about 1-2x its length.`,
  review: `critique(job_id): for a deck, storyboard, contact sheet, compose, slideshow, image or video job.
  First the deterministic checks (contrast, overflow/off-slide, missing shots), then the Dell vision model looks at the rendered
  slides / contact sheet and lists concrete problems. Up to 3 rounds per job. Warnings never block: tell Mo the open warnings
  and ask if he wants another round of refinement.`
};

// critique frames for a compose: the middle of each clip's clean span (after the incoming and before the outgoing
// transition), at most n spread over the clips. Pure, from the editly spec Synth wrote.
function cleanFrameTimes(spec, n = 9) {
  const out = []; let t = 0, prevTr = 0;
  spec.clips.forEach((c, i) => {
    const tr = i < spec.clips.length - 1 ? Math.min((c.transition || {}).duration || 0, c.duration / 2) : 0;
    const a = t + prevTr, b = t + c.duration - tr;
    out.push(b > a ? (a + b) / 2 : t + c.duration / 2);
    t += c.duration - tr; prevTr = tr;
  });
  if (out.length <= n) return out;
  return Array.from({ length: n }, (_, i) => out[Math.round(i * (out.length - 1) / (n - 1))]);
}
// critique: what a numbered tile is called for each job kind, and the model's "where" relabelled to match
// (small VLMs copy the example word, e.g. "slide 4" for a storyboard shot).
function critiqueUnit(kind) {
  return kind === 'deck' ? 'slide' : kind === 'storyboard' ? 'shot' : ['compose', 'video', 'slideshow', 'captions'].includes(kind) ? 'frame' : kind === 'contact_sheet' ? 'tile' : 'image';
}
function whereLabel(where, unit) {
  const w = String(where || 'all').trim();
  return w.replace(/^(slides?|shots?|frames?|tiles?|images?|panels?)\b\s*/i, `${unit} `).trim();
}

module.exports = { critiqueUnit, whereLabel, cleanFrameTimes, SHOT_SIZES, CAMERA_ANGLES, CAMERA_MOVEMENTS, SHOT_STATUSES, ASPECT_RATIOS, TRANSITIONS, COMPOSE_SIZES, LAYOUTS, THEMES, CATALOG,
  normaliseBible, biblePrompt, withBible, normaliseBoard, schemaIssues, continuityWarnings, boardMarkdown, shotPrompt,
  checkCompose, slideshowToCompose, editlySpec, duckFilter, checkDeck, deckColours, contrast, contrastWarnings, srtToVtt, srtCues, SLUG_RE };

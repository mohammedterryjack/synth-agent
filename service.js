'use strict';
// synth-agent: the Synth bot's bridge to the Dell (media-gateway ACE-Step music on :8091, dell-synth Qwen3-TTS on :8094,
// both of which only accept this machine). The Synth bot (Hermes profile "synth") drives it through mcp.js.
// Since 2026-11-20 also images and LTX-2.5 video via the media gateway, and slideshows / contact sheets with ffmpeg here
// (media.js). Video renders unload the Dell chat model inside the gateway (its unload-per-render path), never from here.
//   * unix socket (owner-only) for mcp.js: newline-delimited JSON {op: "tool", name, args} -> {ok, result: {text}}
//   * HTTP on the LAN address only: a keyless read-only viewer per job at /v/<token>/ (unguessable token per job)
// Outputs live in ~/synth/<job_id>/. The Dell key is DELL_LLM_API_KEY in the synth profile's .env, read per request.
// One clear path, errors are returned as they are. The chat model on the Dell is never unloaded from here.
// Since 2026-11-20 13:xx also the studio tools (studio.js): catalog, write_bible, storyboard / validate_storyboard /
// approve_storyboard, make_captions (whisper.cpp here), compose (editly in a local container; make_slideshow is its hidden
// alias), make_deck (power-pptx) and critique (deterministic checks + the Dell vision model).
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), http = require('http'), crypto = require('crypto'), { execFileSync } = require('child_process');
const plural = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
// Bible jobs store the full prompt (bible text + shot); the reply shows Mo's own words and names the bible.
const shownPrompt = j => String(j.user_prompt || j.prompt).slice(0, 120);
const bibleNote = j => (j.project ? `, ${j.project} bible v${j.bible_version}` : '');

const need = k => { const v = process.env[k]; if (!v) throw new Error(k + ' is not set (see .env.example)'); return v; };
const HOME = os.homedir();
const CFG = {
  dir: process.env.SYNTH_DIR || path.join(HOME, 'synth'),
  sock: process.env.SYNTH_SOCK || path.join(HOME, '.hermes', 'synth-agent', 'worker.sock'),
  bind: need('SYNTH_BIND'),
  port: +(process.env.SYNTH_PORT || 8648),
  env: process.env.SYNTH_ENV_FILE || path.join(HOME, '.hermes', 'profiles', 'synth', '.env'),
  music: need('DELL_MEDIA'),
  tts: need('DELL_SYNTH'),
  llm: need('DELL_LLM'),
  llmModel: process.env.DELL_LLM_MODEL || 'Qwen3.8-Flash-Next-UD-IQ4_XS'
};
const JOB_RE = /^[0-9a-f]{16}$/;
const { gatewayHeaders, listJobs, compactJob, madeLine, reconcileJob } = require('./jobs.js');
const log = (...a) => console.log(new Date().toISOString(), ...a);
const WAIT_MS = 30 * 60 * 1000;
class Pending extends Error {}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function key() {
  const m = /^DELL_LLM_API_KEY=(.+)$/m.exec(fs.readFileSync(CFG.env, 'utf8'));
  if (!m || m[1].trim().length < 16) throw new Error(`DELL_LLM_API_KEY is missing in ${CFG.env}`);
  return m[1].trim();
}
function newId() { return crypto.randomBytes(8).toString('hex'); }
function jobDir(id) {
  if (!JOB_RE.test(id || '')) throw new Error(`error job_id: must be the 16-hex id a Synth tool returned, got ${JSON.stringify(id)}; for example job_id:"3f9c0a1b2c3d4e5f" (list_jobs shows recent ones)`);
  return path.join(CFG.dir, id);
}
function loadJob(id) {
  const f = path.join(jobDir(id), 'job.json');
  if (!fs.existsSync(f)) throw new Error(`no job ${id} on this machine`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function saveJob(id, j) {
  const d = jobDir(id);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const tmp = path.join(d, 'job.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(j, null, 1));
  fs.renameSync(tmp, path.join(d, 'job.json'));
}
function token(id) {
  const f = path.join(jobDir(id), 'view.token');
  if (!fs.existsSync(f)) {
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    fs.writeFileSync(f, crypto.randomBytes(18).toString('hex'), { mode: 0o600 });
  }
  return fs.readFileSync(f, 'utf8').trim();
}
const viewerUrl = id => `http://${CFG.bind}:${CFG.port}/v/${token(id)}/`;

// Video or media containers that dell-synth's libsndfile loader cannot open.
const CONTAINER_EXTS = new Set(['.mov', '.mp4', '.m4v', '.mkv', '.webm', '.avi', '.mpg', '.mpeg', '.m2ts', '.mts', '.ts', '.3gp', '.wmv', '.flv', '.ogv', '.qt']);

function extractAudioToWav(src, dest) {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('ffmpeg is not installed on this machine');
    throw new Error(`ffmpeg is not usable: ${e.message}`);
  }
  const tmp = dest + '.part';
  try { fs.unlinkSync(tmp); } catch { /* no leftover */ }
  try {
    execFileSync('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-i', src,
      '-map', '0:a:0',
      '-vn',
      '-ac', '2',
      '-ar', '44100',
      '-c:a', 'pcm_s16le',
      '-f', 'wav',
      tmp
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    const err = ((e.stderr && e.stderr.toString()) || (e.stdout && e.stdout.toString()) || e.message || '').trim();
    if (/matches no streams|does not contain any stream|Output file does not contain any stream/i.test(err))
      throw new Error(`${src} has no audio stream`);
    throw new Error(`ffmpeg failed to extract audio from ${src}: ${err.slice(0, 500) || 'exit ' + e.status}`);
  }
  if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw new Error(`ffmpeg produced no WAV from ${src}`);
  }
  fs.renameSync(tmp, dest);
}

function audioForDell(src, id) {
  const ext = path.extname(src).toLowerCase();
  if (!CONTAINER_EXTS.has(ext)) {
    return { path: src, filename: path.basename(src).replace(/[^\w.-]+/g, '_') || 'audio.wav', extracted: false };
  }
  const dest = path.join(jobDir(id), 'input.wav');
  extractAudioToWav(src, dest);
  return { path: dest, filename: 'input.wav', extracted: true };
}

function prepareUpload(src, id, job) {
  try {
    const send = audioForDell(src, id);
    if (send.extracted) { job.extracted_wav = 'input.wav'; saveJob(id, job); }
    return send;
  } catch (e) {
    job.status = 'failed'; job.error = e.message; job.finished = new Date().toISOString(); saveJob(id, job);
    throw e;
  }
}


async function readJsonRes(r, label) {
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { throw new Error(`${label}: HTTP ${r.status} ${t.slice(0, 300)}`); }
  if (!r.ok) throw Object.assign(new Error(j.error || `${label}: HTTP ${r.status} ${t.slice(0, 300)}`), { status: r.status });
  return j;
}
async function music(method, p, body) {
  const r = await fetch(CFG.music + p, {
    method,
    body: body == null ? undefined : JSON.stringify(body),
    headers: gatewayHeaders(key(), method, body == null ? {} : { 'Content-Type': 'application/json' })
  });
  return readJsonRes(r, `dell-media-gateway ${method} ${p}`);
}
async function tts(method, p, { json, raw, type, headers } = {}) {
  const r = await fetch(CFG.tts + p, {
    method,
    body: raw !== undefined ? raw : (json !== undefined ? JSON.stringify(json) : undefined),
    headers: { Authorization: 'Bearer ' + key(), ...(type ? { 'Content-Type': type } : (json !== undefined ? { 'Content-Type': 'application/json' } : {})), ...headers }
  });
  return readJsonRes(r, `dell-synth ${method} ${p}`);
}

function describeWait(kind, st) {
  const wait = st.waiting_for ? ` (${st.waiting_for})` : '';
  const pos = st.status === 'queued' && st.queue_position != null
    ? ` (position ${st.queue_position} in the Dell queue, ${st.jobs_ahead || 0} ahead)` : '';
  return `${kind} is still ${st.status}${pos}${wait} after 30 min. This is not a failure: call the same tool again with the same job_id to keep waiting (it will not run twice), or show_job to check.`;
}

async function waitMusic(id, dellId) {
  const t0 = Date.now();
  for (;;) {
    const st = await music('GET', `/v1/music/${dellId}`);
    if (st.status === 'done') return st;
    if (st.status === 'failed') throw new Error(st.error || 'music job failed with no detail');
    if (st.status !== 'queued' && st.status !== 'running') throw new Error(`music job ${st.status}: ${st.error || 'no detail'}`);
    if (Date.now() - t0 > WAIT_MS) throw new Pending(describeWait('generate_song', st));
    await sleep(3000);
  }
}
async function waitTts(id, dellId) {
  const t0 = Date.now();
  for (;;) {
    const st = await tts('GET', `/v1/jobs/${dellId}`);
    if (st.status === 'done') return st;
    if (st.status === 'failed') throw new Error(st.error || 'speech job failed with no detail');
    if (st.status !== 'queued' && st.status !== 'running') throw new Error(`speech job ${st.status}: ${st.error || 'no detail'}`);
    if (Date.now() - t0 > WAIT_MS) throw new Pending(describeWait(loadJob(id).kind, st));
    await sleep(3000);
  }
}

async function download(url, dest) {
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + key() } });
  if (!r.ok) throw new Error(`could not download ${url}: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const tmp = dest + '.part';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
  return buf.length;
}

async function resumeOrCreate(a, kind, start) {
  if (a.job_id) {
    const j = loadJob(a.job_id);
    if (j.kind !== kind) throw new Error(`job ${a.job_id} is a ${j.kind} job, not ${kind}`);
    if (j.status === 'done') return { id: a.job_id, job: j, started: false };
    if (!j.dell_job_id) throw new Error(`job ${a.job_id} has no Dell job id`);
    return { id: a.job_id, job: j, started: true, resume: true };
  }
  return start();
}

const tools = {
  async generate_song(a) {
    let id, job;
    if (a.job_id) {
      job = loadJob(a.job_id);
      if (job.kind !== 'song') throw new Error(`job ${a.job_id} is a ${job.kind} job, not a song`);
      id = a.job_id;
      if (job.status === 'done' && fs.existsSync(path.join(jobDir(id), 'song.mp3')))
        return { text: `job_id ${id}: song already done (${job.seconds} s), file ${path.join(jobDir(id), 'song.mp3')}` };
      if (!job.dell_job_id) throw new Error(`job ${id} has no Dell music job id`);
    } else {
      if (!a.tags || !String(a.tags).trim()) throw new Error('tags (style/genre/mood/instruments/vocals) is required');
      if (Boolean(a.lyrics && String(a.lyrics).trim()) === Boolean(a.instrumental))
        throw new Error('give lyrics or instrumental=true, not both or neither');
      const seconds = a.seconds == null ? 10 : a.seconds;
      if (!(seconds >= 10 && seconds <= 240)) throw new Error('seconds must be a number 10-240');
      if (a.bpm != null && (!(Number.isInteger(a.bpm) && a.bpm >= 10 && a.bpm <= 300))) throw new Error('bpm must be an integer 10-300');
      if (a.seed != null && (!(Number.isInteger(a.seed) && a.seed >= 0))) throw new Error('seed must be a non-negative integer');
      id = newId();
      job = {
        id, kind: 'song', name: a.name || 'song', tags: String(a.tags).trim(),
        lyrics: a.instrumental ? null : String(a.lyrics), instrumental: Boolean(a.instrumental),
        seconds, seed: a.seed ?? null, bpm: a.bpm ?? null,
        status: 'queued', created: new Date().toISOString()
      };
      saveJob(id, job); token(id);
      const body = { tags: job.tags, seconds: job.seconds };
      if (job.instrumental) body.instrumental = true; else body.lyrics = job.lyrics;
      if (job.seed != null) body.seed = job.seed;
      if (job.bpm != null) body.bpm = job.bpm;
      let submitted;
      try { submitted = await music('POST', '/v1/music', body); }
      catch (e) {
        job.status = 'failed'; job.error = e.message; job.finished = new Date().toISOString(); saveJob(id, job);
        throw e;
      }
      job.dell_job_id = submitted.job_id;
      job.status = submitted.status || 'queued';
      job.queue_position = submitted.queue_position;
      job.jobs_ahead = submitted.jobs_ahead;
      saveJob(id, job);
    }
    let st;
    try { st = await waitMusic(id, job.dell_job_id); }
    catch (e) {
      if (e instanceof Pending) throw e;
      job.status = 'failed'; job.error = e.message; job.finished = new Date().toISOString(); saveJob(id, job);
      throw e;
    }
    if (!st.url) throw new Error('music job finished with no audio URL');
    const dest = path.join(jobDir(id), 'song.mp3');
    const bytes = await download(st.url, dest);
    job.status = 'done'; job.url = st.url; job.bytes = bytes; job.finished = new Date().toISOString(); job.error = null;
    saveJob(id, job);
    return { text: `job_id ${id}: ${job.seconds} s ${job.instrumental ? 'instrumental' : 'song with lyrics'} (${bytes} bytes). Call finish to get the Viewer and MEDIA lines.` };
  },

  async speak(a) {
    if (a.job_id) return finishTtsWait(a.job_id, 'speak');
    if (!a.text || !String(a.text).trim()) throw new Error('text is required');
    return startTts('speak', a.name, { text: String(a.text).trim(), language: a.language || 'English', speaker: a.speaker || 'Aiden', instruct: a.instruct || null });
  },
  async clone_voice(a) {
    if (a.job_id) return finishTtsWait(a.job_id, 'clone_voice');
    if (!a.text || !String(a.text).trim()) throw new Error('text is required');
    if (!a.path) throw new Error('path (the reference clip on this machine) is required');
    const st = fs.statSync(a.path);
    if (!st.isFile()) throw new Error(`${a.path} is not a file`);
    const id = newId();
    const job = {
      id, kind: 'clone_voice', name: a.name || path.basename(a.path),
      text: String(a.text).trim(), language: a.language || 'English',
      ref_path: a.path, ref_text: a.ref_text ? String(a.ref_text) : null,
      x_vector_only: !a.ref_text, status: 'queued', created: new Date().toISOString()
    };
    saveJob(id, job); token(id);
    const send = prepareUpload(a.path, id, job);
    const ref = fs.readFileSync(send.path);
    const boundary = '----Synth' + crypto.randomBytes(12).toString('hex');
    const fields = [
      ['text', job.text], ['language', job.language],
      ...(job.ref_text ? [['ref_text', job.ref_text]] : [['x_vector_only', 'true']])
    ];
    const blobs = [];
    for (const [k, v] of fields) {
      blobs.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    const fname = send.filename;
    blobs.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="ref"; filename="${fname}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    blobs.push(ref);
    blobs.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const raw = Buffer.concat(blobs);
    let submitted;
    try { submitted = await tts('POST', '/v1/clone', { raw, type: 'multipart/form-data; boundary=' + boundary }); }
    catch (e) {
      job.status = 'failed'; job.error = e.message; job.finished = new Date().toISOString(); saveJob(id, job);
      throw e;
    }
    job.dell_job_id = submitted.job_id; job.status = submitted.status || 'queued'; saveJob(id, job);
    return finishTtsWait(id, 'clone_voice');
  },
  async design_voice(a) {
    if (a.job_id) return finishTtsWait(a.job_id, 'design_voice');
    if (!a.text || !String(a.text).trim()) throw new Error('text is required');
    if (!a.instruct || !String(a.instruct).trim()) throw new Error('instruct (a description of the voice) is required');
    return startTts('design_voice', a.name, { text: String(a.text).trim(), language: a.language || 'English', instruct: String(a.instruct).trim() });
  },

  async generate_sfx(a) {
    if (a.job_id) return finishTtsWait(a.job_id, 'generate_sfx');
    if (!a.prompt || !String(a.prompt).trim()) throw new Error('prompt is required');
    const seconds = a.seconds == null ? 5 : a.seconds;
    if (!(seconds >= 1 && seconds <= 30)) throw new Error('seconds must be a number 1-30');
    return startTts('generate_sfx', a.name, { prompt: String(a.prompt).trim(), seconds, seed: a.seed ?? null });
  },
  async separate_stems(a) {
    if (a.job_id) return finishTtsWait(a.job_id, 'separate_stems');
    if (!a.path) throw new Error('path (the mix or song on this machine) is required');
    const stt = fs.statSync(a.path);
    if (!stt.isFile()) throw new Error(`${a.path} is not a file`);
    const id = newId();
    const job = {
      id, kind: 'separate_stems', name: a.name || path.basename(a.path),
      src_path: a.path, status: 'queued', created: new Date().toISOString()
    };
    saveJob(id, job); token(id);
    const send = prepareUpload(a.path, id, job);
    const rawFile = fs.readFileSync(send.path);
    const boundary = '----Synth' + crypto.randomBytes(12).toString('hex');
    const fname = send.filename;
    const blobs = [
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="${fname}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      rawFile,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ];
    if (a.name) {
      blobs.unshift(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${a.name}\r\n`));
    }
    const raw = Buffer.concat(blobs);
    let submitted;
    try { submitted = await tts('POST', '/v1/stems', { raw, type: 'multipart/form-data; boundary=' + boundary }); }
    catch (e) {
      job.status = 'failed'; job.error = e.message; job.finished = new Date().toISOString(); saveJob(id, job);
      throw e;
    }
    job.dell_job_id = submitted.job_id; job.status = submitted.status || 'queued'; saveJob(id, job);
    return finishTtsWait(id, 'separate_stems');
  },

  async finish(a) {
    const j = loadJob(a.job_id);

    if (j.status !== 'done') throw new Error(`job ${a.job_id} is ${j.status}${j.error ? ': ' + j.error : ''}; wait for it to finish before calling finish`);
    const d = jobDir(a.job_id);
    const audio = OUTPUTS.filter(n => fs.existsSync(path.join(d, n)));
    if (!audio.length) throw new Error(`job ${a.job_id} is done but has no output file in ${d}`);
    token(a.job_id);
    const what = j.kind === 'song'
      ? `${j.seconds} s ${j.instrumental ? 'instrumental' : 'song'} (${j.tags})`
      : j.kind === 'separate_stems' ? '2 stems (vocals and backing)'
      : j.kind === 'generate_sfx' ? `sound effect (${j.prompt || ''})`
      : j.kind === 'image' ? `image ${j.width}x${j.height}${bibleNote(j)} (${shownPrompt(j)})`
      : j.kind === 'video' ? (videoLabel(j) ? `${videoLabel(j)}${bibleNote(j)}: ${shownPrompt(j)}` : `${j.video_seconds} s ${j.mode} video${j.style ? ' (' + j.style + ' style)' : ''}${bibleNote(j)} (${shownPrompt(j)})`)
      : j.kind === 'slideshow' ? `${j.video_seconds} s slideshow (${plural(j.slides.length, 'slide')})`
      : j.kind === 'contact_sheet' ? `contact sheet (${j.tiles} tiles)`
      : j.kind === 'storyboard' ? `storyboard "${j.title}" (${plural(j.shots, 'shot')}, ${j.seconds} s, ${j.board_status === 'done' ? 'approved and rendered' : j.approved ? 'approved, ' + j.board_status : 'NOT approved yet, nothing rendered'})`
      : j.kind === 'captions' ? `${plural(j.cues, 'caption')} (SRT + VTT${j.burn_in ? ', burned into the video' : ''})`
      : j.kind === 'compose' ? `${j.video_seconds} s video, ${plural(j.clips.length, 'clip')}${j.music ? ', with music' : ''}${j.has_audio === false ? ', no sound' : ''}`
      : j.kind === 'deck' ? `${j.slides}-slide editable deck "${j.title}" (PowerPoint .pptx)`
      : `${j.kind} (${j.language || 'English'})`;
    const open = (j.critiques && j.critiques.length) ? j.critiques[j.critiques.length - 1].warnings : (j.checks || (j.kind === 'storyboard' ? (j.warnings || []).map(w => `${w.shot ? 'shot ' + w.shot : 'board'}: ${w.warning}`) : []));
    const warn = open.length ? [`Open warnings (tell Mo, and ask if he wants another round of refinement):`, ...open.map(w => '- ' + w)] : [];
    return { text: [`${madeLine(what)} Files in ${d}/`, ...warn, `Viewer: ${viewerUrl(a.job_id)}`, ...audio.map(n => 'MEDIA:' + path.join(d, n))].join('\n') };
  },
  async show_job(a) {
    const j = loadJob(a.job_id);
    if (j.dell_job_id && (j.status === 'queued' || j.status === 'running')) {
      try {
        const st = j.kind === 'song' ? await music('GET', `/v1/music/${j.dell_job_id}`)
          : j.kind === 'video' ? await music('GET', `/v1/videos/${j.dell_job_id}`) : await tts('GET', `/v1/jobs/${j.dell_job_id}`);
        Object.assign(j, { dell_status: st.status, waiting_for: st.waiting_for, queue_position: st.queue_position, jobs_ahead: st.jobs_ahead, error: st.error || j.error });
      } catch (e) { j.dell_error = e.message; }
    }
    if (videoLabel(j)) j.label = videoLabel(j);
    return { text: JSON.stringify(compactJob(j)) };
  },
  async list_jobs(a = {}) {
    // Newest 20 by default; a.limit (1-100) is accepted on the socket but not in the MCP schema. Always valid JSON.
    return { text: JSON.stringify(listJobs(CFG.dir, JOB_RE, a.limit, videoLabel)) };
  },
  async cancel_job(a) {
    if (!fs.existsSync(jobDir(a.job_id))) throw new Error(`job ${a.job_id} was not started by Synth; refusing to cancel it`);
    const j = loadJob(a.job_id);
    if (j.kind === 'song')
      throw new Error('song jobs cannot be cancelled: the Dell music service has no cancel endpoint. The job will finish or fail on its own. Nothing was stopped.');
    if (!['speak', 'clone_voice', 'design_voice', 'generate_sfx', 'separate_stems'].includes(j.kind))
      throw new Error(`${j.kind} jobs cannot be cancelled (the media gateway has no cancel endpoint; slideshows and contact sheets run here and finish on their own). Nothing was stopped.`);
    const st = await tts('POST', `/v1/cancel?job=${j.dell_job_id || a.job_id}`, { json: {} });
    j.status = 'cancelled'; j.error = 'cancelled'; j.finished = new Date().toISOString(); saveJob(a.job_id, j);
    return { text: JSON.stringify(st).slice(0, 3000) };
  }
};

// Every output file a job can have, in the order finish lists them.
const OUTPUTS = ['song.mp3', 'speech.wav', 'sfx.wav', 'vocals.wav', 'backing.wav', 'image.jpg', 'video.mp4', 'slideshow.mp4', 'compose.mp4', 'captioned.mp4',
  'contact_sheet.jpg', 'deck_sheet.jpg', 'deck.pptx', 'captions.srt', 'captions.vtt', 'board.md'];
const { videoLabel } = require('./media.js');
// One shared deps object: media.js adds its resolver/normaliser to it, studio.js adds applyBible (used by media.js at
// call time) and calls generate_image / contact_sheet through H.tools.
const H = { jobDir, loadJob, saveJob, token, newId, gateway: music, gatewayBase: CFG.music, key, download, Pending, describeWait, sleep, WAIT_MS, JOB_RE,
  dir: CFG.dir, llmBase: CFG.llm, llmModel: CFG.llmModel };
Object.assign(tools, require('./media.js')(H));
Object.assign(tools, require('./studio.js')(H));
H.tools = tools;

async function startTts(kind, name, payload) {
  const id = newId();
  const job = { id, kind, name: name || kind, ...payload, status: 'queued', created: new Date().toISOString() };
  saveJob(id, job); token(id);
  const pathMap = { speak: '/v1/speak', design_voice: '/v1/design', generate_sfx: '/v1/sfx' };
  let submitted;
  try { submitted = await tts('POST', pathMap[kind], { json: payload }); }
  catch (e) {
    job.status = 'failed'; job.error = e.message; job.finished = new Date().toISOString(); saveJob(id, job);
    throw e;
  }
  job.dell_job_id = submitted.job_id; job.status = submitted.status || 'queued'; saveJob(id, job);
  return finishTtsWait(id, kind);
}
async function finishTtsWait(id, kind) {
  const job = loadJob(id);
  if (job.kind !== kind) throw new Error(`job ${id} is a ${job.kind} job, not ${kind}`);
  if (job.status === 'done' && stemOrAudioDone(id, job.kind))
    return { text: ttsDoneText(id, job) };
  if (!job.dell_job_id) throw new Error(`job ${id} has no Dell speech job id`);
  let st;
  try { st = await waitTts(id, job.dell_job_id); }
  catch (e) {
    if (e instanceof Pending) throw e;
    job.status = 'failed'; job.error = e.message; job.finished = new Date().toISOString(); saveJob(id, job);
    throw e;
  }
  let bytes;
  try { bytes = await downloadOutputs(id, job.kind, st); }
  catch (e) { job.status = 'failed'; job.error = `JOB FAILED: done on the Dell but not collected: ${e.message}`; job.finished = new Date().toISOString(); saveJob(id, job); throw e; }
  job.status = 'done'; job.url = st.url; job.files = st.files || null; job.bytes = bytes; job.finished = new Date().toISOString(); job.error = null;
  if (st.sample_rate) job.sample_rate = st.sample_rate;
  if (st.seconds != null) job.audio_seconds = st.seconds;
  saveJob(id, job);
  return { text: ttsDoneText(id, job) };
}
function stemOrAudioDone(id, kind) {
  const d = jobDir(id);
  if (kind === 'separate_stems') return fs.existsSync(path.join(d, 'vocals.wav')) && fs.existsSync(path.join(d, 'backing.wav'));
  if (kind === 'generate_sfx') return fs.existsSync(path.join(d, 'sfx.wav'));
  return fs.existsSync(path.join(d, 'speech.wav'));
}
async function downloadOutputs(id, kind, st) {
  const d = jobDir(id);
  if (kind === 'separate_stems') {
    if (!st.files || !st.files['vocals.wav'] || !st.files['backing.wav']) throw new Error('stem job finished with no vocals/backing URLs');
    let n = 0;
    for (const name of ['vocals.wav', 'backing.wav']) n += await download(st.files[name], path.join(d, name));
    return n;
  }
  const name = kind === 'generate_sfx' ? 'sfx.wav' : 'speech.wav';
  // dell-synth reports outputs as files{name: url} (sfx, stems) or url (speech); either names the one file.
  const url = (st.files && st.files[name]) || st.url;
  if (!url) throw new Error(`job finished with no ${name} URL (Dell status had url=${st.url || 'none'}, files=${st.files ? Object.keys(st.files).join(',') : 'none'})`);
  return download(url, path.join(d, name));
}
function ttsDoneText(id, job) {
  const extra = job.x_vector_only ? ' (speaker embedding only: no reference transcript, quality may be lower)' : '';
  return `job_id ${id}: ${job.kind} ${job.bytes || ''} bytes${extra}. Call finish to get the Viewer and MEDIA lines.`;
}

// ---------------------------------------------------------------- socket
fs.mkdirSync(path.dirname(CFG.sock), { recursive: true, mode: 0o700 });
fs.mkdirSync(CFG.dir, { recursive: true, mode: 0o700 });
if (fs.existsSync(CFG.sock)) fs.unlinkSync(CFG.sock);
net.createServer(c => {
  let buf = '';
  c.on('data', async d => {
    buf += d; const i = buf.indexOf('\n'); if (i < 0) return;
    const reply = o => c.end(JSON.stringify(o) + '\n');
    let req; try { req = JSON.parse(buf.slice(0, i)); } catch { return reply({ ok: false, error: 'bad request' }); }
    const f = req.op === 'tool' && Object.prototype.hasOwnProperty.call(tools, req.name) && tools[req.name];
    if (!f) return reply({ ok: false, error: `unknown tool ${req.name}` });
    const t0 = Date.now();
    try { const r = await f(req.args || {}); log('tool', req.name, 'ok', Date.now() - t0, 'ms'); reply({ ok: true, result: r }); }
    catch (e) {
      if (e instanceof Pending) { log('tool', req.name, 'pending'); return reply({ ok: true, result: { text: e.message } }); }
      log('tool', req.name, 'error', e.message); reply({ ok: true, result: { error: `${req.name} failed: ${e.message}` } });
    }
  });
  c.on('error', () => {});
}).listen(CFG.sock, () => { fs.chmodSync(CFG.sock, 0o600); log('socket', CFG.sock); });

// ---------------------------------------------------------------- startup reconcile
// Waiting only happens inside a tool call, so a restart leaves queued/running jobs with no waiter (root cause of the
// 17-18 Nov jobs stuck as queued/running). On start, ask the Dell about each one (GET only, never cancel): gone (404)
// -> failed with the reason; still known -> the tool's own job_id path resumes waiting and collects the result.
const DELL_STATUS = { song: j => music('GET', `/v1/music/${j.dell_job_id}`), video: j => music('GET', `/v1/videos/${j.dell_job_id}`) };
const RESUME = { song: id => tools.generate_song({ job_id: id }), video: id => tools.generate_video({ job_id: id }) };
for (const k of ['speak', 'clone_voice', 'design_voice', 'generate_sfx', 'separate_stems']) {
  DELL_STATUS[k] = j => tts('GET', `/v1/jobs/${j.dell_job_id}`);
  RESUME[k] = id => finishTtsWait(id, k);
}
async function reconcileAll() {
  for (const id of fs.readdirSync(CFG.dir)) {
    if (!JOB_RE.test(id) || !fs.existsSync(path.join(CFG.dir, id, 'job.json'))) continue;
    let j;
    try { j = loadJob(id); } catch (e) { log('RECONCILE FAILED', id, e.message); continue; }
    if (j.status !== 'queued' && j.status !== 'running') continue;
    if (j.dell_job_id && !DELL_STATUS[j.kind]) { log('RECONCILE FAILED', id, `no Dell status route for kind ${j.kind}; left ${j.status}`); continue; }
    const out = await reconcileJob(id, j, {
      dellStatus: jj => DELL_STATUS[jj.kind](jj), saveJob, now: () => new Date().toISOString(),
      resume: rid => RESUME[j.kind](rid).then(r => log('reconcile', rid, 'resumed:', (r && r.text || '').slice(0, 200)), e => log('reconcile', rid, 'resume ended:', e.message))
    });
    log('reconcile', id, j.kind, out);
  }
}
reconcileAll().catch(e => log('RECONCILE FAILED', e.message));

// ---------------------------------------------------------------- viewer
const TYPES = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.mp4': 'video/mp4',
  '.vtt': 'text/vtt; charset=utf-8', '.srt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.pdf': 'application/pdf',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function byToken(t) {
  if (!/^[0-9a-f]{36}$/.test(t)) return null;
  for (const id of fs.readdirSync(CFG.dir)) {
    const f = path.join(CFG.dir, id, 'view.token');
    if (JOB_RE.test(id) && fs.existsSync(f) && crypto.timingSafeEqual(Buffer.from(fs.readFileSync(f, 'utf8').trim()), Buffer.from(t))) return id;
  }
  return null;
}
function page(id) {
  const d = jobDir(id), j = fs.existsSync(path.join(d, 'job.json')) ? JSON.parse(fs.readFileSync(path.join(d, 'job.json'), 'utf8')) : {};
  const files = fs.readdirSync(d).filter(n => n !== 'view.token' && !n.endsWith('.part') && !n.endsWith('.tmp') && fs.statSync(path.join(d, n)).isFile()).sort();
  const shown = OUTPUTS.filter(n => files.includes(n));
  const track = files.includes('captions.vtt') ? '<track kind="captions" src="captions.vtt" srclang="en" label="Captions" default>' : '';
  const media = shown.map(n => n.endsWith('.jpg') ? `<img src="${esc(n)}">` : n.endsWith('.mp4') ? `<video src="${esc(n)}" controls playsinline crossorigin>${n === 'captioned.mp4' ? '' : track}</video>`
    : /\.(mp3|wav)$/.test(n) ? `<audio src="${esc(n)}" controls></audio>`
    : n === 'board.md' ? `<pre>${esc(fs.readFileSync(path.join(d, n), 'utf8'))}</pre>`
    : `<p><a href="${esc(n)}">${esc(n)}</a></p>`).join('\n')
    + files.filter(n => /^slide-\d+\.jpg$/.test(n)).map(n => `<img src="${esc(n)}" loading="lazy">`).join('\n');
  const title = esc(j.name || id);
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Synth ${esc(id)}</title>
<style>body{background:#111;color:#ddd;font:14px/1.4 system-ui,sans-serif;margin:0;padding:16px}audio,video,img{width:100%;max-width:1280px;margin:12px 0;display:block}a{color:#8cf}pre{white-space:pre-wrap;background:#1a1a1a;padding:8px;border:1px solid #333}</style>
<h3>Synth · ${title}</h3>
${media || '<p>No output yet.</p>'}
<pre>${esc(JSON.stringify({ kind: j.kind, status: j.status, prompt: j.prompt, user_prompt: j.user_prompt, project: j.project, bible_version: j.bible_version, mode: j.mode, style: j.style, tags: j.tags, language: j.language, speaker: j.speaker, seconds: j.seconds, video_seconds: j.video_seconds, width: j.width, height: j.height, instruct: j.instruct,
  project: j.project, bible_version: j.bible_version, board_status: j.board_status, approval: j.approval, cues: j.cues, slides: j.slides, warnings: j.warnings, checks: j.checks,
  critique: j.critiques && j.critiques.length ? j.critiques[j.critiques.length - 1] : undefined, error: j.error }, null, 2))}</pre>
<p>${files.map(n => `<a href="${esc(n)}">${esc(n)}</a>`).join(' · ')}</p>`;
}
http.createServer((req, res) => {
  const m = /^\/v\/([0-9a-f]+)\/(.*)$/.exec(decodeURIComponent((req.url || '').split('?')[0]));
  const id = m && byToken(m[1]);
  if (req.method !== 'GET' || !id) { res.writeHead(404); return res.end('not found'); }
  const rel = m[2];
  if (!rel) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(page(id)); }
  if (!/^[A-Za-z0-9_.-]+$/.test(rel) || rel === 'view.token') { res.writeHead(404); return res.end('not found'); }
  const f = path.join(jobDir(id), rel);
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  const size = fs.statSync(f).size, type = TYPES[path.extname(f)] || 'application/octet-stream', r = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (r) {
    const s = r[1] ? +r[1] : size - +r[2], e = r[1] && r[2] ? +r[2] : size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${s}-${e}/${size}`, 'Content-Length': e - s + 1, 'Accept-Ranges': 'bytes' });
    return fs.createReadStream(f, { start: s, end: e }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(f).pipe(res);
}).listen(CFG.port, CFG.bind, () => log('http', `${CFG.bind}:${CFG.port}`));

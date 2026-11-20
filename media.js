'use strict';
// Synth media tools (2026-11-20, Mo 09:56: "can we make synth bot have all the video and audio gen tools").
//  * generate_image -> dell-media-gateway POST /v1/images (Z-Image-Turbo, synchronous, queued in the gateway's GPU FIFO)
//  * generate_video -> dell-media-gateway POST /v1/videos (LTX-2.5 t2v/i2v/first_last/extend/restyle + style LoRAs; the
//    gateway unloads the Dell chat model per render). Inputs are files on this machine or Synth job ids, always sent
//    as base64 (one path). The gateway validates every field and its error is returned as is.
//  * generate_video quality "draft" -> the same POST /v1/videos with model wan2.2-ti2v-5b (Wan 2.2 TI2V-5B: t2v/i2v only,
//    1-5 s, 832x480 24 fps, no audio). Mo 10:54: Wan for quick drafts, LTX for final quality, one tool, no overlap.
//    LTX-only options with draft fail loudly here (never dropped, never sent to LTX instead).
//  * contact_sheet -> ffmpeg on this machine's CPU (no Dell, no GPU). make_slideshow moved to compose (studio.js,
//    editly) on 20 Nov and stays only as a hidden alias there.
//  * generate_image / generate_video take optional project + characters + environment: the project's locked bible
//    (studio.js h.applyBible) is put in front of the prompt verbatim; the job keeps the user prompt and bible version.
// No fallbacks; nothing is ever cancelled.
const fs = require('fs'), path = require('path'), http = require('http'), { execFile } = require('child_process');

const FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const MAX_B64 = 10 * 1024 * 1024;   // gateway image_base64 / video_base64 decoded limit
const IMG_EXTS = new Set(['.jpg', '.jpeg', '.png', '.mpo', '.webp', '.gif', '.bmp', '.tif', '.tiff']);
const NORMALISE = path.join(__dirname, 'normalise_image.py');   // system python3 + Pillow
const VID_EXTS = new Set(['.mp4', '.mov', '.webm']);
const AUD_EXTS = new Set(['.wav', '.mp3', '.flac', '.m4a', '.ogg']);
const { gatewayHeaders } = require('./jobs.js');
const { withHeavyLock } = require('./heavylock.js');  // oldmac heavy lock: local renders never overlap Articraft compiles

// generate_video quality -> Dell model. Validation only (no I/O), exported for the unit tests.
const VIDEO_QUALITY = { draft: 'wan2.2-ti2v-5b', final: 'ltx-2.5' };
const FINAL_ONLY = { end_image: 'end_image', source: 'source', extend_seconds: 'extend_seconds', control: 'control', style: 'style' };
function vErr(arg, problem, example) { return new Error(`error generate_video.${arg}: ${problem}; for example ${example}`); }
function checkVideo(a) {
  const q = a.quality;
  if (q == null) throw vErr('quality', 'required; "draft" = Wan 2.2 quick draft (832x480, 1-5 s, no sound, t2v/i2v) or "final" = LTX-2.5 final quality (768x512, 1-10 s, with sound, all modes)', 'quality:"draft"');
  if (!Object.prototype.hasOwnProperty.call(VIDEO_QUALITY, q)) throw vErr('quality', `must be "draft" or "final", got ${JSON.stringify(q)}`, 'quality:"final"');
  const mode = a.mode || (a.image ? 'i2v' : 't2v');
  if (q === 'final') return { quality: q, model: VIDEO_QUALITY[q], mode };
  for (const k of Object.keys(FINAL_ONLY))
    if (a[k] != null) throw vErr(k, `${k} is only for quality "final" (LTX-2.5); draft (Wan 2.2) does t2v/i2v only, no style, no sound`, `drop ${k}, or use quality:"final"`);
  if (mode !== 't2v' && mode !== 'i2v') throw vErr('mode', `"${mode}" is only for quality "final" (LTX-2.5); draft does t2v or i2v`, 'mode:"t2v"');
  if (mode === 'i2v' && !a.image) throw vErr('image', 'required for mode i2v (the first frame)', 'image:"<image job_id>"');
  if (mode === 't2v' && a.image) throw vErr('image', 'not used by mode t2v', 'mode:"i2v" to start from the image');
  const seconds = a.seconds ?? 3;
  if (!(Number.isInteger(seconds) && seconds >= 1 && seconds <= 5)) throw vErr('seconds', `draft is 1-5 whole seconds, got ${JSON.stringify(a.seconds)}`, 'seconds:3 (or quality:"final" for up to 10 s)');
  if (a.seed != null && !Number.isInteger(a.seed)) throw vErr('seed', `must be an integer, got ${JSON.stringify(a.seed)}`, 'seed:42');
  return { quality: q, model: VIDEO_QUALITY[q], mode, seconds };
}

function run(cmd, args, timeoutMs = 20 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (e, out, err) => {
      if (e) return reject(new Error(`${path.basename(cmd)} failed: ${(String(err || '').trim().split('\n').slice(-4).join(' | ') || e.message).slice(0, 600)}`));
      resolve(String(out));
    });
  });
}
async function duration(p) {
  const s = (await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', p], 60000)).trim();
  const d = parseFloat(s);
  if (!(d > 0)) throw new Error(`could not read the duration of ${p}`);
  return d;
}
// One label for a video job everywhere (finish, show_job, list_jobs). Only for records that carry quality.
function videoLabel(j) {
  if (!j || j.kind !== 'video' || !j.quality) return null;
  const secs = j.video_seconds != null ? `${j.video_seconds} s ` : (j.seconds != null ? `${j.seconds} s ` : '');
  return j.quality === 'draft' ? `${secs}draft ${j.mode} video (Wan, no sound)`
    : `${secs}final ${j.mode} video${j.style ? ' (' + j.style + ' style)' : ''} (LTX)`;
}
module.exports = media;
module.exports.videoLabel = videoLabel;
module.exports.checkVideo = checkVideo;
module.exports.VIDEO_QUALITY = VIDEO_QUALITY;
function media(h) {
  const { jobDir, loadJob, saveJob, token, newId, gateway, gatewayBase, key, download, Pending, describeWait, sleep, WAIT_MS, JOB_RE } = h;

  // POST /v1/images is synchronous and the gateway's wait budget only counts LLM-idle time, so the answer can take far
  // longer than fetch()'s fixed 300 s header timeout. Plain http with a 40 min ceiling (the MCP call limit).
  function postImage(body) {
    return new Promise((resolve, reject) => {
      const data = Buffer.from(JSON.stringify(body));
      const req = http.request(gatewayBase + '/v1/images', { method: 'POST', timeout: 40 * 60 * 1000,
        headers: gatewayHeaders(key(), 'POST', { 'Content-Type': 'application/json', 'Content-Length': data.length }) }, res => {
        let t = ''; res.setEncoding('utf8'); res.on('data', c => t += c);
        res.on('end', () => {
          let j; try { j = JSON.parse(t); } catch { return reject(new Error(`dell-media-gateway POST /v1/images: HTTP ${res.statusCode} ${t.slice(0, 300)}`)); }
          if (res.statusCode !== 200) return reject(new Error(j.error || `dell-media-gateway POST /v1/images: HTTP ${res.statusCode}`));
          resolve(j);
        });
      });
      req.on('timeout', () => req.destroy(new Error('dell-media-gateway POST /v1/images: no answer within 40 min (the request stays in the Dell queue)')));
      req.on('error', e => reject(new Error(`dell-media-gateway POST /v1/images: ${e.message}`)));
      req.end(data);
    });
  }

  // A file on this machine, or a Synth job id whose finished output of the wanted kind is used.
  const JOB_FILES = { image: ['image.jpg', 'contact_sheet.jpg'], video: ['video.mp4', 'compose.mp4', 'captioned.mp4', 'slideshow.mp4'],
    audio: ['speech.wav', 'song.mp3', 'sfx.wav', 'vocals.wav', 'backing.wav'] };
  function resolveInput(ref, want, label) {
    if (ref == null || !String(ref).trim()) throw new Error(`${label} is empty`);
    ref = String(ref).trim();
    if (JOB_RE.test(ref)) {
      const j = loadJob(ref);
      if (j.status !== 'done') throw new Error(`${label}: job ${ref} is ${j.status}, not done`);
      if (want === 'audio' && j.kind === 'separate_stems') {
        const d = jobDir(ref);
        throw new Error(`${label}: job ${ref} is separate_stems with two files; pick one by path, for example ${JSON.stringify(path.join(d, 'backing.wav'))} (music, no vocals) or ${JSON.stringify(path.join(d, 'vocals.wav'))}`);
      }
      const f = JOB_FILES[want].map(n => path.join(jobDir(ref), n)).find(p => fs.existsSync(p));
      if (!f) throw new Error(`${label}: job ${ref} (${j.kind}) has no ${want} output (${JOB_FILES[want].join(', ')})`);
      return f;
    }
    if (!path.isAbsolute(ref)) throw new Error(`${label} must be a 16-hex Synth job_id or an absolute file path on this machine`);
    const st = fs.statSync(ref);
    if (!st.isFile()) throw new Error(`${label}: ${ref} is not a file`);
    const ext = path.extname(ref).toLowerCase(), ok = { image: IMG_EXTS, video: VID_EXTS, audio: AUD_EXTS }[want];
    if (!ok.has(ext)) throw new Error(`${label}: ${ref} is not a ${want} file (${[...ok].join(', ')})`);
    return ref;
  }
  function b64(p, label) {
    const n = fs.statSync(p).size;
    if (n > MAX_B64) throw new Error(`${label}: ${p} is ${n} bytes; the Dell accepts at most ${MAX_B64} (10 MiB)`);
    return fs.readFileSync(p).toString('base64');
  }
  // Every input image (start/end frames, slides, contact-sheet tiles) goes through normalise_image.py first: EXIF
  // orientation applied, first frame only (phone MPOs), PNG if alpha else JPEG q95. Fails loudly; no fallback.
  async function normaliseImage(src, outBase, label) {
    fs.mkdirSync(path.dirname(outBase), { recursive: true, mode: 0o700 });
    let out;
    try { out = await run('/usr/bin/python3', [NORMALISE, src, outBase], 120000); }
    catch (e) { throw new Error(`${label}: ${e.message.replace(/^python3 failed: /, '')}`); }
    const r = JSON.parse(out.trim().split('\n').pop());
    if (!r.path || !fs.existsSync(r.path)) throw new Error(`${label}: the normaliser wrote no file`);
    return r.path;
  }
  // Shared with studio.js (compose, make_deck, make_captions, critique): one resolver, one normaliser.
  Object.assign(h, { resolveInput, normaliseImage, duration, run });
  function fail(id, job, e) { job.status = 'failed'; job.error = e.message; job.finished = new Date().toISOString(); saveJob(id, job); return e; }
  const doneText = (id, j, what) => ({ text: `job_id ${id}: ${what}. Call finish to get the Viewer and MEDIA lines.`, job_id: id });

  async function waitVideo(id) {
    const job = loadJob(id);
    const t0 = Date.now();
    let st;
    for (;;) {
      st = await gateway('GET', `/v1/videos/${job.dell_job_id}`);
      if (st.status === 'done') break;
      const tag = `${job.quality || 'final'} video (${job.model || 'ltx-2.5'})`;
      if (st.status === 'failed') throw fail(id, job, new Error(`JOB FAILED: ${tag} ${id}: ${st.error || 'no detail from the Dell'}`));
      if (st.status !== 'queued' && st.status !== 'running') throw fail(id, job, new Error(`JOB FAILED: ${tag} ${id} ended ${st.status}: ${st.error || 'no detail from the Dell'}`));
      if (Date.now() - t0 > WAIT_MS) throw new Pending(describeWait('generate_video', st));
      await sleep(5000);
    }
    if (!st.url) throw fail(id, job, new Error(`JOB FAILED: video ${id} finished on the Dell with no URL`));
    const bytes = await download(st.url, path.join(jobDir(id), 'video.mp4'));
    Object.assign(job, { status: 'done', url: st.url, bytes, started_dell: st.started, finished_dell: st.finished,
      finished: new Date().toISOString(), error: null, llm_reload_error: st.llm_reload_error || undefined });
    job.video_seconds = +(await duration(path.join(jobDir(id), 'video.mp4'))).toFixed(2);
    saveJob(id, job);
    return doneText(id, job, `${job.quality ? job.quality + ' (' + job.model + ') ' : ''}${job.mode || 'video'} clip ${job.video_seconds} s (${bytes} bytes)${st.llm_reload_error ? '; Dell LLM reload error: ' + st.llm_reload_error : ''}`);
  }

  return {
    async generate_image(a) {
      if (a.job_id) {
        const j = loadJob(a.job_id);
        if (j.kind !== 'image') throw new Error(`job ${a.job_id} is a ${j.kind} job, not image`);
        if (j.status === 'done') return doneText(a.job_id, j, `image ${j.width}x${j.height} already done`);
        throw new Error(`job ${a.job_id} is ${j.status}${j.error ? ': ' + j.error : ''}`);
      }
      if (!a.prompt || !String(a.prompt).trim()) throw new Error('prompt is required');
      const width = a.width ?? 1024, height = a.height ?? 1024;
      const bp = h.applyBible(a, 'generate_image');
      const id = newId();
      const job = { id, kind: 'image', name: a.name || 'image', prompt: bp.prompt, user_prompt: bp.user_prompt, project: bp.project, bible_version: bp.bible_version,
        characters: bp.characters, environment: bp.environment, width, height, seed: a.seed ?? null,
        status: 'running', created: new Date().toISOString() };
      saveJob(id, job); token(id);
      const body = { prompt: job.prompt, width, height };
      if (a.seed != null) body.seed = a.seed;
      let r;
      try { r = await postImage(body); } catch (e) { throw fail(id, job, e); }
      try { job.bytes = await download(r.url, path.join(jobDir(id), 'image.jpg')); } catch (e) { throw fail(id, job, e); }
      Object.assign(job, { status: 'done', url: r.url, width: r.width, height: r.height, dell_seconds: r.seconds, finished: new Date().toISOString(), error: null });
      saveJob(id, job);
      return doneText(id, job, `image ${r.width}x${r.height} in ${r.seconds} s on the Dell`);
    },

    async generate_video(a) {
      if (a.job_id) {
        const j = loadJob(a.job_id);
        if (j.kind !== 'video') throw new Error(`job ${a.job_id} is a ${j.kind} job, not video`);
        if (j.status === 'done' && fs.existsSync(path.join(jobDir(a.job_id), 'video.mp4'))) return doneText(a.job_id, j, `video already done (${j.video_seconds} s)`);
        if (!j.dell_job_id) throw new Error(`job ${a.job_id} has no Dell video job id`);
        return waitVideo(a.job_id);
      }
      if (!a.prompt || !String(a.prompt).trim()) throw vErr('prompt', 'required', 'prompt:"a red fox trots across snow, camera tracks left, dawn light"');
      const v = checkVideo(a);
      const bp = h.applyBible(a, 'generate_video');
      const body = { prompt: bp.prompt };
      if (v.quality === 'draft') Object.assign(body, { model: v.model, mode: v.mode, seconds: v.seconds }, a.seed != null ? { seed: a.seed } : {});
      else for (const k of ['mode', 'style', 'seconds', 'seed', 'extend_seconds', 'control']) if (a[k] != null) body[k] = a[k];
      const id = newId();
      const job = { id, kind: 'video', name: a.name || (v.quality === 'draft' ? 'draft video' : 'video'), prompt: body.prompt, quality: v.quality, model: v.model, mode: v.mode,
        style: a.style || null, seconds: v.seconds ?? a.seconds ?? null, extend_seconds: a.extend_seconds ?? null, control: a.control || null,
        seed: a.seed ?? null, image: a.image || null, end_image: a.end_image || null, source: a.source || null,
        user_prompt: bp.user_prompt, project: bp.project, bible_version: bp.bible_version, characters: bp.characters, environment: bp.environment,
        status: 'queued', created: new Date().toISOString() };
      saveJob(id, job); token(id);
      try {
        const inDir = path.join(jobDir(id), 'inputs');
        if (a.image) body.image_base64 = b64(await normaliseImage(resolveInput(a.image, 'image', 'image'), path.join(inDir, 'image'), 'image'), 'image');
        if (a.end_image) body.end_image_base64 = b64(await normaliseImage(resolveInput(a.end_image, 'image', 'end_image'), path.join(inDir, 'end_image'), 'end_image'), 'end_image');
        if (a.source) body.video_base64 = b64(resolveInput(a.source, 'video', 'source'), 'source');
      } catch (e) { throw fail(id, job, e); }
      let s;
      try { s = await gateway('POST', '/v1/videos', body); } catch (e) { throw fail(id, job, e); }
      Object.assign(job, { dell_job_id: s.job_id, status: s.status || 'queued', queue_position: s.queue_position, jobs_ahead: s.jobs_ahead });
      saveJob(id, job);
      return waitVideo(id);
    },

    async contact_sheet(a) {
      const hasImgs = Array.isArray(a.images) && a.images.length, hasVid = a.video != null;
      if (Boolean(hasImgs) === Boolean(hasVid)) throw new Error('give images (a list) or video, not both or neither');
      const cols = a.columns ?? 4;
      if (!(Number.isInteger(cols) && cols >= 1 && cols <= 8)) throw new Error('columns must be an integer 1-8');
      const frames = a.frames ?? 12;
      if (!(Number.isInteger(frames) && frames >= 2 && frames <= 48)) throw new Error('frames must be an integer 2-48');
      if (hasImgs && a.images.length > 48) throw new Error('at most 48 images');
      const inputs = hasImgs ? a.images.map((r, i) => resolveInput(r, 'image', `images[${i}]`)) : [resolveInput(a.video, 'video', 'video')];
      const id = newId(), d = jobDir(id), tmp = path.join(d, 'work');
      const job = { id, kind: 'contact_sheet', name: a.name || 'contact sheet', images: a.images || null, video: a.video || null, columns: cols,
        status: 'running', created: new Date().toISOString() };
      saveJob(id, job); token(id);
      fs.mkdirSync(tmp, { recursive: true });
      const TW = 400, TH = 225;
      const thumb = `scale=${TW}:${TH}:force_original_aspect_ratio=decrease,pad=${TW}:${TH}:(ow-iw)/2:(oh-ih)/2:color=0x111418,pad=${TW + 8}:${TH + 8}:4:4:color=0x111418,format=rgb24`;   // one pixel format for every tile: a format change mid-sequence resets the tile filter (lost tiles)
      try { await withHeavyLock(`synth:${id}:contact_sheet`, async () => {
        let n;
        if (hasVid) {
          const len = await duration(inputs[0]);
          await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', inputs[0], '-vf', `fps=${(frames / len).toFixed(5)},${thumb}`, '-frames:v', String(frames), path.join(tmp, 't%03d.png')]);
          n = fs.readdirSync(tmp).filter(f => /^t\d{3}\.png$/.test(f)).length;
        } else {
          for (let i = 0; i < inputs.length; i++)
            await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', await normaliseImage(inputs[i], path.join(tmp, `src${i + 1}`), `images[${i}]`), '-vf', thumb, '-frames:v', '1', path.join(tmp, `t${String(i + 1).padStart(3, '0')}.png`)]);
          n = inputs.length;
        }
        if (!n) throw new Error('no frames were extracted');
        // Number every tile (1..n) so shots can be referred to.
        for (let i = 1; i <= n; i++) {
          const f = path.join(tmp, `t${String(i).padStart(3, '0')}.png`);
          await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', f, '-vf',
            `drawtext=fontfile=${FONT_BOLD}:text=${i}:fontcolor=white:fontsize=28:box=1:boxcolor=black@0.6:boxborderw=6:x=12:y=10`, f + '.n.png']);
          fs.renameSync(f + '.n.png', f);
        }
        const rows = Math.ceil(n / cols);
        await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-framerate', '1', '-i', path.join(tmp, 't%03d.png'),
          '-vf', `tile=${Math.min(cols, n)}x${rows}:color=0x111418`, '-frames:v', '1', '-q:v', '3', path.join(d, 'contact_sheet.jpg')]);
        fs.rmSync(tmp, { recursive: true, force: true });
        job.tiles = n;
      }, { job, saveJob }); } catch (e) { throw fail(id, job, e); }
      Object.assign(job, { status: 'done', bytes: fs.statSync(path.join(d, 'contact_sheet.jpg')).size, finished: new Date().toISOString(), error: null });
      saveJob(id, job);
      return doneText(id, job, `contact sheet with ${job.tiles} numbered tiles`);
    }
  };
};

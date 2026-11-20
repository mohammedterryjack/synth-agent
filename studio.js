'use strict';
// Synth studio tools (Mo 12:52, 20 Nov: storyboard, style/character bible, local captions, editly compose, deck builder).
//  * catalog(topic)            reference text (shot language, bible, storyboard, compose, deck, captions, review, projects)
//  * write_bible               one locked style/character bible per project (SKEL studio.json / identity_lock pattern);
//                              generate_image / generate_video / storyboard shots reuse it verbatim (board.withBible)
//  * storyboard / validate_storyboard / approve_storyboard
//                              take's shots.json (MIT); nothing is rendered until Mo approves; then one generate_image per
//                              shot (Dell GPU queue, never cancelled) and a numbered contact sheet
//  * make_captions             whisper.cpp (ggml small q5_1) on this machine's CPU -> SRT/VTT, optional ffmpeg burn-in
//  * compose (+ hidden alias make_slideshow)
//                              editly (mifi/editly, MIT) in a local docker image with --network none, then ffmpeg music
//                              bed with sidechain ducking
//  * make_deck                 power-pptx (MIT) fit_text + slide.lint, rendered with LibreOffice to check
//  * critique                  deterministic checks + the Dell vision model on the rendered slides / contact sheet,
//                              3 rounds max; warnings are flagged to Mo, never blocking
// No fallbacks: every missing piece fails loudly with its reason.
const fs = require('fs'), path = require('path'), http = require('http'), { execFile } = require('child_process');
const n = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
const B = require('./board.js');
const { withHeavyLock } = require('./heavylock.js');  // oldmac heavy lock: local renders never overlap Articraft compiles

const HERE = __dirname;
const VENV_PY = path.join(HERE, '.venv', 'bin', 'python');
const DECK_PY = path.join(HERE, 'deck.py');
const WHISPER = path.join(HERE, 'vendor', 'whisper.cpp', 'build', 'bin', 'whisper-cli');
const WHISPER_MODEL = path.join(HERE, 'vendor', 'whisper-models', 'ggml-small-q5_1.bin');
// Silero VAD (MIT): whisper only hears speech, so music beds and silence give no invented or repeated lines.
const WHISPER_VAD = path.join(HERE, 'vendor', 'whisper-models', 'ggml-silero-v6.2.0.bin');
const EDITLY_IMAGE = process.env.SYNTH_EDITLY_IMAGE || 'synth-editly:0.15.0-rc.1';
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const DECK_FONT = { family: 'Arial', regular: '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf', bold: '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf' };
const MAX_ROUNDS = 3;
const BOARD_BUDGET_MS = 25 * 60 * 1000;
const err = (tool, arg, problem, example) => new Error(`error ${tool}.${arg}: ${problem}; for example ${example}`);

function sh(cmd, args, { timeout = 20 * 60 * 1000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, cwd, maxBuffer: 32 * 1024 * 1024 }, (e, out, se) => {
      if (e) return reject(new Error(`${path.basename(cmd)} failed${e.killed ? ' (timed out)' : ''}: ${(String(se || '').trim().split('\n').slice(-6).join(' | ') || e.message).slice(0, 900)}`));
      resolve(String(out));
    });
  });
}

module.exports = function studio(h) {
  const { jobDir, loadJob, saveJob, token, newId, Pending, WAIT_MS, JOB_RE, key, dir, llmBase, llmModel } = h;
  const projDir = slug => path.join(dir, 'projects', slug);
  const now = () => new Date().toISOString();
  const fail = (id, job, e) => { job.status = 'failed'; job.error = e.message; job.finished = now(); saveJob(id, job); return e; };

  // ---------------------------------------------------------------- bible
  function loadBible(slug, tool, arg = 'project') {
    if (typeof slug !== 'string' || !B.SLUG_RE.test(slug)) throw err(tool, arg, `must be a project slug, got ${JSON.stringify(slug)}`, 'project:"fox-tale"');
    const f = path.join(projDir(slug), 'bible.json');
    if (!fs.existsSync(f)) throw err(tool, arg, `no bible for project ${slug} (projects: ${listProjects().join(', ') || 'none'})`, `write_bible with project:"${slug}" first`);
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  }
  function listProjects() {
    const d = path.join(dir, 'projects');
    return fs.existsSync(d) ? fs.readdirSync(d).filter(s => fs.existsSync(path.join(d, s, 'bible.json'))).sort() : [];
  }
  // Used by generate_image / generate_video (media.js) and approve_storyboard: the one place the bible enters a prompt.
  h.applyBible = (a, tool) => {
    const prompt = String(a.prompt || '').trim();
    if (a.project == null) {
      for (const k of ['characters', 'environment']) if (a[k] != null) throw err(tool, k, 'needs project (the bible it comes from)', 'project:"fox-tale"');
      return { prompt, project: null, bible_version: null };
    }
    const bible = loadBible(a.project, tool);
    return { prompt: B.withBible(bible, prompt, { characters: a.characters || [], environment: a.environment ?? null, tool }), user_prompt: prompt,
      project: bible.project, bible_version: bible.version, characters: a.characters || [], environment: a.environment ?? null };
  };

  // ---------------------------------------------------------------- helpers
  function newJob(kind, name, extra = {}) {
    const id = newId();
    const job = { id, kind, name: name || kind, status: 'running', created: now(), ...extra };
    saveJob(id, job); token(id);
    return { id, job, d: jobDir(id) };
  }
  async function hasStream(file, type) {
    return Boolean((await sh('ffprobe', ['-v', 'error', '-select_streams', type, '-show_entries', 'stream=index', '-of', 'csv=p=0', file], { timeout: 60000 })).trim());
  }
  async function tileSheet(images, out, cols, tw = 480, th = 270) {
    const work = out + '.tiles';
    fs.mkdirSync(work, { recursive: true });
    for (let i = 0; i < images.length; i++)
      await sh('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', images[i], '-vf',
        `scale=${tw}:${th}:force_original_aspect_ratio=decrease,pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2:color=0x111418,pad=${tw + 8}:${th + 8}:4:4:color=0x111418,format=rgb24,drawtext=fontfile=${FONT_BOLD}:text=${i + 1}:fontcolor=white:fontsize=26:box=1:boxcolor=black@0.6:boxborderw=6:x=12:y=10`,
        '-frames:v', '1', path.join(work, `t${String(i + 1).padStart(3, '0')}.png`)]);
    const c = Math.min(cols, images.length);
    await sh('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-framerate', '1', '-i', path.join(work, 't%03d.png'),
      '-vf', `tile=${c}x${Math.ceil(images.length / c)}:color=0x111418`, '-frames:v', '1', '-q:v', '3', out]);
    fs.rmSync(work, { recursive: true, force: true });
  }
  // A job id or absolute path of any audio or video (captions source).
  function resolveMedia(ref, label) {
    const r = String(ref || '').trim();
    if (JOB_RE.test(r)) {
      const j = loadJob(r);
      if (j.status !== 'done') throw new Error(`${label}: job ${r} is ${j.status}, not done`);
      for (const n of ['video.mp4', 'compose.mp4', 'slideshow.mp4', 'speech.wav', 'song.mp3', 'vocals.wav', 'sfx.wav']) {
        const f = path.join(jobDir(r), n);
        if (fs.existsSync(f)) return f;
      }
      throw new Error(`${label}: job ${r} (${j.kind}) has no audio or video output`);
    }
    try { return h.resolveInput(r, 'video', label); } catch (e) { if (!/is not a video file/.test(e.message)) throw e; }
    return h.resolveInput(r, 'audio', label);
  }

  // ---------------------------------------------------------------- VLM (Dell, same model as the Vision bot)
  function vlm(images, prompt) {
    const body = Buffer.from(JSON.stringify({ model: llmModel, max_tokens: 1400, temperature: 0.2, response_format: { type: 'json_object' },
      chat_template_kwargs: { enable_thinking: false },
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...images.map(f => ({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + fs.readFileSync(f).toString('base64') } }))] }] }));
    return new Promise((resolve, reject) => {
      const req = http.request(llmBase + '/chat/completions', { method: 'POST', timeout: 20 * 60 * 1000,
        headers: { Authorization: 'Bearer ' + key(), 'Content-Type': 'application/json', 'Content-Length': body.length, 'X-Client': 'synth-agent' } }, res => {
        let t = ''; res.setEncoding('utf8'); res.on('data', c => t += c);
        res.on('end', () => {
          let j; try { j = JSON.parse(t); } catch { return reject(new Error(`Dell vision model: HTTP ${res.statusCode} ${t.slice(0, 300)}`)); }
          if (res.statusCode !== 200) return reject(new Error(`Dell vision model: HTTP ${res.statusCode} ${JSON.stringify(j.error || j).slice(0, 300)}`));
          const txt = (((j.choices || [])[0] || {}).message || {}).content || '';
          let o; try { o = JSON.parse(txt.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return reject(new Error(`Dell vision model answer is not JSON: ${txt.slice(0, 300)}`)); }
          if (!o || !Array.isArray(o.issues)) return reject(new Error(`Dell vision model answer has no issues list: ${txt.slice(0, 300)}`));
          resolve(o.issues.slice(0, 8).map(i => ({ where: String(i.where || 'all'), problem: String(i.problem || '').trim(), fix: String(i.fix || '').trim() })).filter(i => i.problem));
        });
      });
      req.on('timeout', () => req.destroy(new Error('Dell vision model: no answer within 20 min')));
      req.on('error', e => reject(new Error(`Dell vision model: ${e.message}`)));
      req.end(body);
    });
  }

  const boardRunning = new Map();   // storyboard job_id -> render promise (one render loop per board)

  async function renderBoard(id, job) {
    const d = jobDir(id), f = path.join(d, 'shots.json');
    const t0 = Date.now();
    const board = JSON.parse(fs.readFileSync(f, 'utf8'));
    const [width, height] = B.ASPECT_RATIOS[board.aspectRatio];
    const save = () => { fs.writeFileSync(f + '.tmp', JSON.stringify(board, null, 1)); fs.renameSync(f + '.tmp', f); fs.writeFileSync(path.join(d, 'board.md'), B.boardMarkdown(board) + '\n'); };
    for (const s of board.shots) {
      if (s.status === 'done' && s.assets && s.assets.image) continue;
      if (Date.now() - t0 > BOARD_BUDGET_MS) {
        const done = board.shots.filter(x => x.status === 'done').length;
        throw new Pending(`job_id ${id}: storyboard still rendering, ${done}/${board.shots.length} shots done. This is not a failure: call approve_storyboard again with the same job_id to keep going (finished shots are kept).`);
      }
      s.status = 'rendering'; save();
      let r;
      try {
        r = await h.tools.generate_image({ prompt: B.shotPrompt(board, s), width, height, name: `${board.title} · shot ${s.index}`,
          ...(job.project ? { project: job.project, characters: s.characters, ...(s.environment ? { environment: s.environment } : {}) } : {}) });
      } catch (e) {
        s.status = 'failed'; s.notes = [s.notes, `render failed: ${e.message}`].filter(Boolean).join(' | '); save();
        job.board_status = 'failed'; job.error = `shot ${s.index}: ${e.message}`; saveJob(id, job);
        throw new Error(`shot ${s.index} failed: ${e.message}. Shots done so far are kept; call approve_storyboard again with the job_id to retry from shot ${s.index}.`);
      }
      s.status = 'done'; s.assets = { ...(s.assets || {}), image: r.job_id }; save();
    }
    const ids = board.shots.map(s => s.assets.image);
    const cs = await h.tools.contact_sheet({ images: ids, columns: board.shots.length <= 4 ? 2 : board.shots.length <= 9 ? 3 : 4, name: `${board.title} · contact sheet` });
    fs.copyFileSync(path.join(jobDir(cs.job_id), 'contact_sheet.jpg'), path.join(d, 'contact_sheet.jpg'));
    Object.assign(job, { board_status: 'done', contact_sheet_job: cs.job_id, images: ids, error: null, rendered: now() });
    saveJob(id, job);
    return { text: `job_id ${id}: storyboard "${board.title}" approved by Mo and rendered: ${ids.length} images (${ids.join(', ')}) and contact sheet ${cs.job_id}. Next: critique with this job_id for a Vision review (warnings only), then finish with this job_id.`, job_id: id };
  }

  async function composeRun(a, via) {
    const T = via || 'compose';
    const plan = B.checkCompose(a, T);
    // Resolve every input before starting (fail loudly on the first bad one).
    const refs = plan.clips.map(c => ({
      file: c.kind === 'title' ? null : h.resolveInput(c.ref, c.kind, `${T}.clips[${c.n - 1}].${c.kind}`),
      narration: c.narration ? h.resolveInput(c.narration, 'audio', `${T}.clips[${c.n - 1}].narration`) : null
    }));
    const musicFile = plan.music ? h.resolveInput(plan.music, 'audio', `${T}.music`) : null;
    await sh('docker', ['image', 'inspect', '--format', '{{.Id}}', EDITLY_IMAGE], { timeout: 60000 })
      .catch(e => { throw new Error(`${T}: the editly image ${EDITLY_IMAGE} is not available on this machine (${e.message})`); });
    const { id, job, d } = newJob('compose', a.name || (via === 'make_slideshow' ? 'slideshow' : 'compose'), { via: via || null, clips: a.clips, size: plan.size, transition: plan.transition,
      music: plan.music, music_volume: plan.music_volume, duck: plan.duck });
    const work = path.join(d, 'work'), inDir = path.join(work, 'in');
    fs.mkdirSync(inDir, { recursive: true });
    try { await withHeavyLock(`synth:${id}:compose`, async () => {
      const files = [];
      for (let i = 0; i < plan.clips.length; i++) {
        const c = plan.clips[i], r = refs[i], o = {};
        if (c.kind === 'image') o.file = await h.normaliseImage(r.file, path.join(inDir, `img${c.n}`), `${T}.clips[${i}].image`);
        else if (c.kind === 'video') { o.file = path.join(inDir, `clip${c.n}${path.extname(r.file).toLowerCase()}`); fs.copyFileSync(r.file, o.file); o.videoSec = await h.duration(o.file); }
        if (c.cut_to != null && o.videoSec != null && c.cut_to > o.videoSec + 0.05) throw err(T, `clips[${i}].cut_to`, `${c.cut_to} s is past the end of the clip (${o.videoSec.toFixed(2)} s)`, `cut_to:${Math.floor(o.videoSec)}`);
        if (r.narration) { o.narration = path.join(inDir, `narr${c.n}${path.extname(r.narration).toLowerCase()}`); fs.copyFileSync(r.narration, o.narration); o.narrationSec = await h.duration(o.narration); }
        files.push(o);
      }
      const font = path.join(work, 'font.ttf'); fs.copyFileSync(FONT_BOLD, font);
      const edit = path.join(work, 'edit.mp4');
      const spec = B.editlySpec(plan, files, { outPath: edit, font });
      fs.writeFileSync(path.join(work, 'editly.json'), JSON.stringify(spec, null, 1));
      const uid = process.getuid(), gid = process.getgid();
      await sh('docker', ['run', '--rm', '--network', 'none', '--cpus', '3', '--user', `${uid}:${gid}`, '-e', `HOME=${work}`, '-v', `${d}:${d}`, '-w', work, EDITLY_IMAGE,
        'editly', '--json', path.join(work, 'editly.json')], { timeout: 45 * 60 * 1000 });
      if (!fs.existsSync(edit)) throw new Error('editly finished but wrote no edit.mp4');
      const out = path.join(d, 'compose.mp4');
      if (musicFile) {
        const total = await h.duration(edit), editAudio = await hasStream(edit, 'a');
        const filter = editAudio ? B.duckFilter(plan.music_volume, total, plan.duck)
          : `[1:a]aresample=48000,volume=${plan.music_volume},atrim=0:${total.toFixed(3)},afade=t=out:st=${Math.max(0, total - 1.5).toFixed(3)}:d=1.5[a]`;
        await sh('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', edit, '-stream_loop', '-1', '-i', musicFile, '-filter_complex', filter,
          '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-t', total.toFixed(3), '-movflags', '+faststart', '-f', 'mp4', out + '.part']);
        fs.renameSync(out + '.part', out);
      } else {
        await sh('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', edit, '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', out + '.part']);
        fs.renameSync(out + '.part', out);
      }
      job.video_seconds = +(await h.duration(out)).toFixed(2);
      job.has_audio = await hasStream(out, 'a');
      fs.rmSync(inDir, { recursive: true, force: true });
      fs.rmSync(edit, { force: true });
    }, { job, saveJob }); } catch (e) { throw fail(id, job, e); }
    Object.assign(job, { status: 'done', bytes: fs.statSync(path.join(d, 'compose.mp4')).size, finished: now(), error: null });
    saveJob(id, job);
    return { text: `job_id ${id}: composed ${plan.clips.length} clips, ${job.video_seconds} s, ${plan.size}${musicFile ? `, music ${plan.duck ? 'ducked under speech' : 'mixed'}` : ''}${job.has_audio ? '' : ', no sound'}. Call finish to get the Viewer and MEDIA lines.`, job_id: id };
  }

  const tools = {
    async catalog(a) {
      const topic = a.topic;
      if (topic === 'projects') {
        const ps = listProjects();
        if (!ps.length) return { text: 'No project bibles yet. write_bible creates one.' };
        return { text: ps.map(p => { const b = loadBible(p, 'catalog', 'topic'); return `project ${p} (bible v${b.version}, locked ${b.modified_at}): characters ${b.characters.map(c => c.id).join(', ') || 'none'}; environments ${b.environments.map(e => e.id).join(', ') || 'none'}\n${B.biblePrompt(b, { characters: b.characters.map(c => c.id) })}`; }).join('\n\n') };
      }
      if (!Object.prototype.hasOwnProperty.call(B.CATALOG, topic)) throw err('catalog', 'topic', `must be one of ${[...Object.keys(B.CATALOG), 'projects'].join(', ')}, got ${JSON.stringify(topic)}`, 'topic:"shot-language"');
      return { text: B.CATALOG[topic] };
    },

    async write_bible(a) {
      const bible = B.normaliseBible(a);
      const pd = projDir(bible.project), f = path.join(pd, 'bible.json');
      fs.mkdirSync(pd, { recursive: true, mode: 0o700 });
      let version = 1;
      if (fs.existsSync(f)) {
        const old = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (a.replace !== true) throw err('write_bible', 'replace', `the ${bible.project} bible is locked (v${old.version}, ${old.modified_at}); it changes only when Mo asks to change it`, 'replace:true with the full new bible, after Mo asked');
        version = old.version + 1;
        fs.copyFileSync(f, path.join(pd, `bible.v${old.version}.json`));
      } else if (a.replace != null && a.replace !== false) {
        throw err('write_bible', 'replace', `there is no ${bible.project} bible to replace yet`, 'drop replace');
      }
      bible.version = version;
      fs.writeFileSync(f + '.tmp', JSON.stringify(bible, null, 1)); fs.renameSync(f + '.tmp', f);
      return { text: `project ${bible.project}: bible v${version} locked: ${n(bible.characters.length, 'character')} (${bible.characters.map(c => c.id).join(', ') || 'none'}), ${n(bible.environments.length, 'environment')} (${bible.environments.map(e => e.id).join(', ') || 'none'}), palette ${bible.palette.join(' ') || 'none'}. Every generate_image, generate_video and storyboard shot with project:"${bible.project}" (and characters / environment ids) starts with this text, verbatim:\n${B.biblePrompt(bible, { characters: bible.characters.map(c => c.id), environment: bible.environments[0] ? bible.environments[0].id : null })}` };
    },

    async storyboard(a) {
      let id, job, revision = 1;
      if (a.job_id) {
        job = loadJob(a.job_id);
        if (job.kind !== 'storyboard') throw err('storyboard', 'job_id', `job ${a.job_id} is a ${job.kind} job, not a storyboard`, 'the job_id storyboard returned');
        if (job.board_status === 'rendering' && boardRunning.has(a.job_id)) throw err('storyboard', 'job_id', 'this board is rendering right now; wait for approve_storyboard to finish', 'approve_storyboard with the same job_id');
        id = a.job_id; revision = (job.revision || 1) + 1;
        fs.copyFileSync(path.join(jobDir(id), 'shots.json'), path.join(jobDir(id), `shots.r${job.revision || 1}.json`));
      }
      const bible = a.project != null ? loadBible(a.project, 'storyboard') : null;
      const board = B.normaliseBoard(a, bible);
      const issues = B.schemaIssues(board);
      if (issues.length) throw new Error(`error storyboard: the board does not fit take's shots.json schema: ${issues.join('; ')}`);
      const warnings = B.continuityWarnings(board, bible);
      const [width, height] = B.ASPECT_RATIOS[board.aspectRatio];
      if (!id) ({ id, job } = newJob('storyboard', a.name || board.title));
      const d = jobDir(id);
      fs.writeFileSync(path.join(d, 'shots.json'), JSON.stringify(board, null, 1));
      fs.writeFileSync(path.join(d, 'board.md'), B.boardMarkdown(board) + '\n');
      for (const n of ['contact_sheet.jpg']) fs.rmSync(path.join(d, n), { force: true });
      Object.assign(job, { status: 'done', board_status: 'draft', approved: false, approval: null, project: bible ? bible.project : null, bible_version: bible ? bible.version : null,
        title: board.title, shots: board.shots.length, seconds: +board.shots.reduce((t, s) => t + s.durationSec, 0).toFixed(1), width, height, revision,
        warnings, images: null, contact_sheet_job: null, critiques: [], finished: now(), error: null });
      saveJob(id, job);
      const wl = warnings.length ? `${warnings.length} continuity warnings (not blocking):\n${warnings.map(w => `- ${w.shot ? 'shot ' + w.shot : 'board'}: ${w.warning}`).join('\n')}` : 'No continuity warnings.';
      return { text: `job_id ${id}: storyboard "${board.title}" revision ${revision}, ${n(board.shots.length, 'shot')}, ${job.seconds} s, ${board.aspectRatio} (${width}x${height}), NOT approved, nothing rendered (no GPU used).\n${B.boardMarkdown(board)}\n${wl}\nReply to Mo with this shot list and the warnings, and ask him to approve it or say what to change. Only after he approves: approve_storyboard with this job_id and his words.`, job_id: id };
    },

    async validate_storyboard(a) {
      const job = loadJob(a.job_id);
      if (job.kind !== 'storyboard') throw err('validate_storyboard', 'job_id', `job ${a.job_id} is a ${job.kind} job, not a storyboard`, 'the job_id storyboard returned');
      const board = JSON.parse(fs.readFileSync(path.join(jobDir(a.job_id), 'shots.json'), 'utf8'));
      const bible = job.project ? loadBible(job.project, 'validate_storyboard') : null;
      const issues = B.schemaIssues(board), warnings = B.continuityWarnings(board, bible);
      if (bible && bible.version !== job.bible_version) warnings.push({ shot: null, warning: `the ${bible.project} bible changed (v${job.bible_version} -> v${bible.version}) since this board was written; rendered shots used the old text` });
      job.warnings = warnings; saveJob(a.job_id, job);
      return { text: `job_id ${a.job_id}: ${n(issues.length, 'schema error')}${issues.length ? ': ' + issues.join('; ') : ''}; ${n(warnings.length, 'warning')}${warnings.length ? ':\n' + warnings.map(w => `- ${w.shot ? 'shot ' + w.shot : 'board'}: ${w.warning}`).join('\n') : '.'}\nBoard ${job.board_status}${job.approved ? ' (approved)' : ' (not approved)'}. Warnings never block: tell Mo and let him decide.` };
    },

    async approve_storyboard(a) {
      const job = loadJob(a.job_id);
      if (job.kind !== 'storyboard') throw err('approve_storyboard', 'job_id', `job ${a.job_id} is a ${job.kind} job, not a storyboard`, 'the job_id storyboard returned');
      if (job.board_status === 'done') return { text: `job_id ${a.job_id}: already rendered (contact sheet ${job.contact_sheet_job}). Call finish with this job_id.` };
      if (boardRunning.has(a.job_id)) {
        const p = boardRunning.get(a.job_id);
        const r = await Promise.race([p, new Promise(res => setTimeout(() => res(null), WAIT_MS))]);
        if (r) return r;
        throw new Pending(`job_id ${a.job_id}: storyboard still rendering; call approve_storyboard again with the same job_id to keep waiting.`);
      }
      if (!job.approved) {
        if (typeof a.mo_said !== 'string' || a.mo_said.trim().length < 2) throw err('approve_storyboard', 'mo_said', 'required: Mo\'s own words approving this board (only call this after he approved it)', 'mo_said:"yes, go ahead with those 6 shots"');
        job.approved = true; job.approval = { mo_said: a.mo_said.trim(), at: now() };
        const f = path.join(jobDir(a.job_id), 'shots.json'), board = JSON.parse(fs.readFileSync(f, 'utf8'));
        for (const s of board.shots) if (s.status === 'draft') s.status = 'approved';
        fs.writeFileSync(f, JSON.stringify(board, null, 1));
      }
      job.board_status = 'rendering'; saveJob(a.job_id, job);
      const p = renderBoard(a.job_id, job).finally(() => boardRunning.delete(a.job_id));
      boardRunning.set(a.job_id, p);
      return p;
    },

    async make_captions(a) {
      const T = 'make_captions';
      if (a.source == null) throw err(T, 'source', 'required: a speech, song, video or compose job_id, or an audio/video file path', 'source:"<video job_id>"');
      const lang = a.language ?? 'auto';
      if (!(lang === 'auto' || /^[a-z]{2,3}$/.test(lang))) throw err(T, 'language', `must be "auto" or a language code, got ${JSON.stringify(lang)}`, 'language:"en"');
      if (a.burn_in != null && typeof a.burn_in !== 'boolean') throw err(T, 'burn_in', 'must be true or false', 'burn_in:true');
      const src = resolveMedia(a.source, `${T}.source`);
      for (const f of [WHISPER, WHISPER_MODEL, WHISPER_VAD]) if (!fs.existsSync(f)) throw new Error(`${T}: ${f} is missing on this machine`);
      const isVideo = await hasStream(src, 'v');
      if (a.burn_in && !isVideo) throw err(T, 'burn_in', `${path.basename(src)} has no picture to draw captions on`, 'drop burn_in, or give a video/compose job_id');
      if (!(await hasStream(src, 'a'))) throw err(T, 'source', `${path.basename(src)} has no sound to transcribe`, 'a video with sound (generate_video quality final, or compose with narration)');
      const secs = await h.duration(src);
      if (secs > 15 * 60) throw err(T, 'source', `${Math.round(secs)} s is longer than 15 min`, 'a shorter clip');
      const { id, job, d } = newJob('captions', a.name || `captions · ${path.basename(src)}`, { source: a.source, source_file: src, language: lang, burn_in: Boolean(a.burn_in), source_seconds: +secs.toFixed(2) });
      const work = path.join(d, 'work'); fs.mkdirSync(work, { recursive: true });
      try { await withHeavyLock(`synth:${id}:captions`, async () => {
        const wav = path.join(work, 'a16.wav');
        await sh('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
        const t0 = Date.now();
        await sh('nice', ['-n', '10', WHISPER, '-m', WHISPER_MODEL, '-f', wav, '-t', '3', '-l', lang, '-ml', '64', '-sow', '-mc', '0', '--vad', '-vm', WHISPER_VAD, '-osrt', '-ovtt', '-of', path.join(work, 'captions'), '-np'],
          { timeout: Math.round(secs * 6 + 600) * 1000 });
        job.whisper_seconds = +((Date.now() - t0) / 1000).toFixed(1);
        for (const n of ['captions.srt', 'captions.vtt']) {
          if (!fs.existsSync(path.join(work, n))) throw new Error(`whisper.cpp wrote no ${n}`);
          fs.renameSync(path.join(work, n), path.join(d, n));
        }
        const cues = B.srtCues(fs.readFileSync(path.join(d, 'captions.srt'), 'utf8'));
        if (!cues.length) throw new Error('whisper.cpp heard no speech (empty captions)');
        job.cues = cues.length;
        job.preview = cues.slice(0, 4).map(c => c.text).join(' / ');
        if (a.burn_in) {
          const out = path.join(d, 'captioned.mp4');
          // A compose with clip text already uses the bottom band: put the spoken captions at the top so they never overlap (libass reads SRT force_style as legacy SSA: 6 = top centre, 2 = bottom centre).
          const srcJob = h.JOB_RE.test(String(a.source).trim()) ? h.loadJob(String(a.source).trim()) : null;
          job.captions_top = Boolean(srcJob && srcJob.kind === 'compose' && (srcJob.clips || []).some(c => c.text));
          const style = `FontName=DejaVu Sans,FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H80000000,BorderStyle=3,Outline=1,Shadow=0,Alignment=${job.captions_top ? 6 : 2},MarginV=24`;
          await sh('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-vf', `subtitles=${path.join(d, 'captions.srt').replace(/([\\:'])/g, '\\$1')}:force_style='${style}'`,
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', '-f', 'mp4', out + '.part']);
          fs.renameSync(out + '.part', out);
        }
        fs.rmSync(work, { recursive: true, force: true });
      }, { job, saveJob }); } catch (e) { throw fail(id, job, e); }
      Object.assign(job, { status: 'done', finished: now(), error: null });
      saveJob(id, job);
      return { text: `job_id ${id}: ${n(job.cues, 'caption')} for ${job.source_seconds} s of ${isVideo ? 'video' : 'audio'} (whisper.cpp small, ${job.whisper_seconds} s on this machine's CPU)${a.burn_in ? ', burned into captioned.mp4' : ''}. Starts: "${job.preview.slice(0, 160)}". Call finish to get the Viewer and MEDIA lines.`, job_id: id };
    },

    async compose(a) { return composeRun(a, null); },
    // Hidden alias (not in tools/list): the old make_slideshow schema, now assembled by compose.
    async make_slideshow(a) { return composeRun(B.slideshowToCompose(a), 'make_slideshow'); },

    async make_deck(a) {
      const T = 'make_deck';
      const spec = B.checkDeck(a);
      const bible = a.project != null ? loadBible(a.project, T) : null;
      const colours = B.deckColours(spec.theme, bible && bible.palette);
      for (const f of [VENV_PY, DECK_PY, DECK_FONT.regular, DECK_FONT.bold]) if (!fs.existsSync(f)) throw new Error(`${T}: ${f} is missing on this machine`);
      const imgs = spec.slides.map((s, i) => (s.image != null ? h.resolveInput(s.image, 'image', `${T}.slides[${i}].image`) : null));
      const { id, job, d } = newJob('deck', a.name || spec.title, { title: spec.title, theme: spec.theme, project: bible ? bible.project : null, colours, slides: spec.slides.length });
      const work = path.join(d, 'work'); fs.mkdirSync(work, { recursive: true });
      try { await withHeavyLock(`synth:${id}:deck`, async () => {
        const slides = [];
        for (let i = 0; i < spec.slides.length; i++) {
          const s = { ...spec.slides[i] };
          if (imgs[i]) s.image = await h.normaliseImage(imgs[i], path.join(work, `img${i + 1}`), `${T}.slides[${i}].image`);
          slides.push(s);
        }
        fs.writeFileSync(path.join(work, 'spec.json'), JSON.stringify({ title: spec.title, colours, font: DECK_FONT, slides }, null, 1));
        const r = JSON.parse((await sh(VENV_PY, [DECK_PY, path.join(work, 'spec.json'), path.join(work, 'deck.pptx')], { timeout: 5 * 60 * 1000 })).trim().split('\n').pop());
        fs.renameSync(path.join(work, 'deck.pptx'), path.join(d, 'deck.pptx'));
        await sh('soffice', [`-env:UserInstallation=file://${path.join(work, 'lo')}`, '--headless', '--convert-to', 'pdf', '--outdir', work, path.join(d, 'deck.pptx')], { timeout: 10 * 60 * 1000 });
        if (!fs.existsSync(path.join(work, 'deck.pdf'))) throw new Error('LibreOffice wrote no deck.pdf');
        await sh('pdftoppm', ['-r', '96', '-jpeg', '-jpegopt', 'quality=88', path.join(work, 'deck.pdf'), path.join(work, 'p')], { timeout: 5 * 60 * 1000 });
        const pages = fs.readdirSync(work).filter(n => /^p-\d+\.jpg$/.test(n)).sort((x, y) => +x.match(/\d+/)[0] - +y.match(/\d+/)[0]);
        if (pages.length !== spec.slides.length) throw new Error(`rendered ${pages.length} pages for ${spec.slides.length} slides`);
        const shots = pages.map((p, i) => { const t = path.join(d, `slide-${String(i + 1).padStart(2, '0')}.jpg`); fs.renameSync(path.join(work, p), t); return t; });
        fs.renameSync(path.join(work, 'deck.pdf'), path.join(d, 'deck.pdf'));
        await tileSheet(shots, path.join(d, 'deck_sheet.jpg'), spec.slides.length <= 4 ? 2 : spec.slides.length <= 9 ? 3 : 4);
        job.lint = r.lint.map(x => ({ slide: x.slide, code: x.code, severity: x.severity, message: x.message }));
        job.checks = [...B.contrastWarnings(colours).map(w => `all slides: ${w}`), ...job.lint.map(x => `slide ${x.slide}: ${x.code}: ${x.message}`)];
        fs.rmSync(work, { recursive: true, force: true });
      }, { job, saveJob }); } catch (e) { throw fail(id, job, e); }
      Object.assign(job, { status: 'done', critiques: [], bytes: fs.statSync(path.join(d, 'deck.pptx')).size, finished: now(), error: null });
      saveJob(id, job);
      return { text: `job_id ${id}: deck "${spec.title}", ${n(spec.slides.length, 'slide')}, editable deck.pptx (${spec.theme} theme${bible ? ', ' + bible.project + ' palette' : ''}). Deterministic checks: ${job.checks.length ? n(job.checks.length, 'warning') + ':\n' + job.checks.map(c => '- ' + c).join('\n') : 'no overflow, off-slide or contrast problems.'}\nNext: critique with this job_id (Vision review of the rendered slides), then finish.`, job_id: id };
    },

    async critique(a) {
      const T = 'critique';
      const job = loadJob(a.job_id), d = jobDir(a.job_id);
      if (job.status !== 'done') throw err(T, 'job_id', `job ${a.job_id} is ${job.status}`, 'a finished deck, storyboard, compose, contact sheet, image or video job');
      if (a.slide != null && (job.kind !== 'deck' || !Number.isInteger(a.slide) || a.slide < 1 || a.slide > job.slides)) throw err(T, 'slide', `only for decks, 1-${job.slides || '?'}`, 'slide:2');
      if (a.focus != null && (typeof a.focus !== 'string' || a.focus.length > 300)) throw err(T, 'focus', 'must be a short text (what to look at)', 'focus:"is the fox the same in every shot?"');
      const rounds = job.critiques || [];
      const open = rounds.length ? rounds[rounds.length - 1].warnings : [];
      if (rounds.length >= MAX_ROUNDS) throw err(T, 'job_id', `${MAX_ROUNDS} critique rounds are done for this job; this is not a failure. Tell Mo the open warnings and let him decide: ${open.join(' | ') || 'none'}`, 'finish with this job_id');
      let images, context, checks = [];
      if (job.kind === 'deck') {
        images = [a.slide ? path.join(d, `slide-${String(a.slide).padStart(2, '0')}.jpg`) : path.join(d, 'deck_sheet.jpg')];
        context = `a ${job.slides}-slide presentation "${job.title}" (${a.slide ? 'slide ' + a.slide + ' shown' : 'numbered contact sheet of every slide'}). Look for: text that is cut off, overflows or overlaps; low contrast; tiny text; crowded or empty slides; images cropped badly; inconsistent style between slides.`;
        checks = job.checks || [];
      } else if (job.kind === 'storyboard') {
        if (job.board_status !== 'done') throw err(T, 'job_id', `the board is ${job.board_status}: critique looks at the rendered contact sheet`, 'approve_storyboard first (after Mo approves), then critique');
        const board = JSON.parse(fs.readFileSync(path.join(d, 'shots.json'), 'utf8'));
        // Up to 8 shots: send each shot's own image (the contact sheet is too small for details like spectacles).
        const shotFiles = (job.images || []).map(id => path.join(jobDir(id), 'image.jpg'));
        const perShot = shotFiles.length > 0 && shotFiles.length <= 8 && shotFiles.every(f => fs.existsSync(f));
        images = perShot ? shotFiles : [path.join(d, 'contact_sheet.jpg')];
        context = `${perShot ? `${shotFiles.length} storyboard images in shot order (image 1 = shot 1, image 2 = shot 2, ...)` : 'a numbered storyboard contact sheet'} "${board.title}". The shot list (tile number = shot number):\n${B.boardMarkdown(board)}\n${job.project ? 'Characters: ' + loadBible(job.project, T).characters.map(c => `${c.name} = ${c.identity_lock}`).join(' | ') : ''}\nLook for: a character that looks different between shots, framing that does not match the shot size/angle, broken continuity (lighting, props, screen direction), artifacts or unreadable images.`;
        checks = B.continuityWarnings(board, job.project ? loadBible(job.project, T) : null).map(w => `${w.shot ? 'shot ' + w.shot : 'board'}: ${w.warning}`);
      } else if (['contact_sheet', 'image'].includes(job.kind)) {
        images = [path.join(d, job.kind === 'image' ? 'image.jpg' : 'contact_sheet.jpg')];
        context = `${job.kind === 'image' ? 'an image' : 'a numbered contact sheet'} "${job.name}"${job.prompt ? ' made from the prompt: ' + String(job.user_prompt || job.prompt).slice(0, 600) : ''}. Look for artifacts, wrong anatomy, unreadable text, and anything that does not match the prompt.`;
      } else if (['compose', 'video', 'slideshow', 'captions'].includes(job.kind)) {
        const v = ['compose.mp4', 'captioned.mp4', 'video.mp4', 'slideshow.mp4'].map(n => path.join(d, n)).find(f => fs.existsSync(f));
        if (!v) throw err(T, 'job_id', `job ${a.job_id} has no video to look at`, 'a compose, video or burned-in captions job');
        const sheet = path.join(d, 'critique_frames.jpg'), len = await h.duration(v), tmp = path.join(d, 'critique_work');
        fs.mkdirSync(tmp, { recursive: true });
        const frames = [];
        await withHeavyLock(`synth:${a.job_id}:critique-frames`, async () => {
        // compose: sample the clean middle of each clip, never a transition (a mid-crosszoom frame looks broken).
        const spec = path.join(d, 'work', 'editly.json');
        const times = job.kind === 'compose' && fs.existsSync(spec) ? B.cleanFrameTimes(JSON.parse(fs.readFileSync(spec, 'utf8')), 9) : Array.from({ length: 9 }, (_, i) => len * (i + 0.5) / 9);
        for (let i = 0; i < times.length; i++) { const f = path.join(tmp, `f${i}.jpg`); await sh('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-ss', Math.min(times[i], len - 0.05).toFixed(3), '-i', v, '-frames:v', '1', f]); frames.push(f); }
        await tileSheet(frames, sheet, 3);
        });
        fs.rmSync(tmp, { recursive: true, force: true });
        images = [sheet];
        context = `${frames.length} numbered frames sampled in order (not during transitions) from a ${len.toFixed(1)} s video "${job.name}". Look for: unreadable or cut-off captions/titles, low contrast text, glitches, bad crops, abrupt or inconsistent style between clips.`;
        if (!(await hasStream(v, 'a'))) checks.push('the video has no sound');
      } else throw err(T, 'job_id', `${job.kind} jobs have nothing visual to critique`, 'a deck, storyboard, compose, contact sheet, image or video job');
      const unit = B.critiqueUnit(job.kind);
      const prompt = `You are a strict art director reviewing ${context}${a.focus ? `\nMo especially wants to know: ${a.focus}` : ''}\nList up to 6 concrete, visible problems, most important first; say which ${unit} number (tiles are numbered). Do not praise. If there is no real problem, return an empty list.\nAnswer only with JSON: {"issues":[{"where":"${unit} 3","problem":"...","fix":"..."}]}`;
      const issues = (await vlm(images, prompt)).map(i => ({ ...i, where: B.whereLabel(i.where, unit) }));
      const warnings = [...checks, ...issues.map(i => `${i.where}: ${i.problem}${i.fix ? ' (fix: ' + i.fix + ')' : ''}`)];
      const round = { round: rounds.length + 1, at: now(), images: images.map(f => path.basename(f)), focus: a.focus || null, checks, vision: issues, warnings };
      job.critiques = [...rounds, round]; saveJob(a.job_id, job);
      fs.writeFileSync(path.join(d, 'critique.json'), JSON.stringify(job.critiques, null, 1));
      return { text: `job_id ${a.job_id}: critique round ${round.round} of ${MAX_ROUNDS} (${job.kind}).\nDeterministic checks: ${checks.length ? '\n' + checks.map(c => '- ' + c).join('\n') : 'none.'}\nVision (Dell): ${issues.length ? '\n' + issues.map(i => `- ${i.where}: ${i.problem}${i.fix ? ' (fix: ' + i.fix + ')' : ''}`).join('\n') : 'no problems seen.'}\nThese are warnings; nothing is blocked. Tell Mo the open warnings in your reply and ask whether he wants another round of refinement${round.round >= MAX_ROUNDS ? ' (this was the last critique round for this job)' : ''}.` };
    }
  };
  return tools;
};

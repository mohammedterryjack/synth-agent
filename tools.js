'use strict';
// Synth tool definitions (MCP tools/list). Every tool runs on the Dell through synth-agent (songs: media-gateway
// ACE-Step 1.5 at :8091; speech: dell-synth Qwen3-TTS 1.7B at :8094; images Z-Image-Turbo and video (draft Wan 2.2, final LTX-2.5) via the media
// gateway :8091; contact sheets with ffmpeg on this machine). Studio tools (20 Nov): catalog, write_bible, storyboard,
// validate_storyboard, approve_storyboard, make_captions, compose, make_deck, critique (studio.js). make_slideshow is a
// hidden alias of compose (accepted on the socket, not listed here).
const job = { type: 'string', description: 'job_id (16 hex) returned by a Synth tool' };
const ref = what => ({ type: 'string', description: `${what}: a Synth job_id (16 hex) whose output is used, or an absolute file path on this machine (e.g. a chat attachment)` });
const T = (name, description, properties = {}, required = ['job_id']) => ({ name, description, inputSchema: { type: 'object', properties: { job_id: job, ...properties }, required, additionalProperties: false } });
const { SHOT_SIZES, CAMERA_ANGLES, CAMERA_MOVEMENTS, ASPECT_RATIOS, TRANSITIONS, COMPOSE_SIZES, LAYOUTS, CATALOG } = require('./board.js');
const str = description => ({ type: 'string', description });
const bibleArgs = {
  project: str('project slug whose locked bible (write_bible) is put in front of the prompt verbatim; then describe only the action and framing'),
  characters: { type: 'array', items: { type: 'string' }, description: 'character ids from the project bible in this picture, e.g. ["char_fox"]' },
  environment: str('environment id from the project bible, e.g. "env_forest"')
};
const shot = { type: 'object', properties: {
  summary: str('one line: what happens'),
  durationSec: { type: 'number', description: 'seconds on screen (1-5 for a draft clip, 1-10 final)' },
  shotSize: { type: 'string', enum: SHOT_SIZES }, angle: { type: 'string', enum: CAMERA_ANGLES }, movement: { type: 'string', enum: CAMERA_MOVEMENTS },
  characters: { type: 'array', items: { type: 'string' }, description: 'character ids from the bible ([] for none)' },
  environment: str('environment id from the bible'), location: str('free-text place (when there is no bible environment)'),
  lighting: str('direction + quality, e.g. "golden-hour backlight"'), tone: str('mood'),
  imagePrompt: str('this shot\'s action and framing only; the bible adds the look'), videoPrompt: str('motion for generate_video later (optional)'),
  notes: str('anything else, e.g. why the lighting changes'), beat: { type: 'integer', description: 'beat number (only with beats)' }
}, required: ['summary', 'durationSec', 'shotSize', 'angle', 'imagePrompt'], additionalProperties: false };
const slide = { type: 'object', properties: {
  layout: { type: 'string', enum: LAYOUTS }, title: str('slide title'), subtitle: str('title/section only'),
  bullets: { type: 'array', items: { type: 'string' }, description: '1-6 short lines (bullets, image_left, image_right)' },
  image: ref('slide picture (image_left, image_right, full_image)'), caption: str('short line under or beside the picture / number'),
  quote: str('quote layout'), by: str('who said the quote'), number: str('big_number layout, e.g. "3 min"'), label: str('big_number layout: what the number is'),
  notes: str('speaker notes')
}, required: ['layout'], additionalProperties: false };
const clip = { type: 'object', properties: {
  image: ref('picture shown still'), video: ref('clip, played with its own sound'), title: str('text card'),
  text: str('caption shown at the bottom of this clip'), narration: ref('speech for this clip (the clip lasts at least as long)'),
  seconds: { type: 'number', description: '0.5-60; default seconds_per_clip (video: its own length)' },
  cut_from: { type: 'number', description: 'video only: start at this second' }, cut_to: { type: 'number', description: 'video only: stop at this second' },
  transition: { type: 'string', enum: TRANSITIONS, description: 'into the next clip; default the edit\'s transition' },
  background: str('title only: card colour #rrggbb')
}, additionalProperties: false };
const TOOLS = [
  { name: 'generate_song', description: 'Compose a song on the Dell with ACE-Step 1.5 (vocals or instrumental). tags: style/genre/mood/instruments/vocals words. Give lyrics, or instrumental=true (not both). seconds 10-240, default 10 (only longer if Mo asks). Optional seed and bpm (10-300). If the Dell does not have enough free memory (songs need about 22.8 GiB free next to the chat model), this fails loudly with the Dell\'s reason; it does not unload the chat model. Returns job_id. If you already have a job_id and the song is still queued or running, call again with only that job_id to keep waiting (it will not start twice).',
    inputSchema: { type: 'object', properties: {
      job_id: job,
      tags: { type: 'string', description: 'style/genre/mood/instruments/vocals' },
      lyrics: { type: 'string' },
      instrumental: { type: 'boolean' },
      seconds: { type: 'number' },
      seed: { type: 'integer' },
      bpm: { type: 'integer' },
      name: { type: 'string', description: 'short label for the job' }
    }, additionalProperties: false } },
  { name: 'speak', description: 'Speak text with a built-in Qwen3-TTS 1.7B speaker on the Dell. language default English. speaker default Aiden (sunny American male). Other speakers: Ryan (English, dynamic male), Vivian, Serena, Uncle_Fu, Dylan, Eric (Chinese), Ono_Anna (Japanese), Sohee (Korean). Optional instruct is a plain-language delivery direction (tone, emotion). Returns job_id. Re-call with only job_id to keep waiting.',
    inputSchema: { type: 'object', properties: {
      job_id: job,
      text: { type: 'string' },
      language: { type: 'string' },
      speaker: { type: 'string' },
      instruct: { type: 'string' },
      name: { type: 'string' }
    }, additionalProperties: false } },
  { name: 'clone_voice', description: 'Clone a voice from a reference clip Mo gave (a file path on this machine, e.g. a chat attachment) and speak text in that voice, using Qwen3-TTS 1.7B Base. language default English. If Mo also gave a transcript of the clip, pass it as ref_text (better quality). Without ref_text, only the speaker embedding is used. Returns job_id. Re-call with only job_id to keep waiting.',
    inputSchema: { type: 'object', properties: {
      job_id: job,
      text: { type: 'string' },
      path: { type: 'string', description: 'reference clip path on this machine. If it is a video or container (.mov, .mp4, .mkv, .webm, and similar), the audio is extracted here to a 44.1 kHz stereo PCM WAV first; no audio stream or ffmpeg failure fails the job with a clear error' },
      ref_text: { type: 'string', description: 'transcript of the reference clip, if Mo gave one' },
      language: { type: 'string' },
      name: { type: 'string' }
    }, additionalProperties: false } },
  { name: 'design_voice', description: 'Invent a voice from a plain-language description (instruct) and speak text in that voice, using Qwen3-TTS 1.7B VoiceDesign. language default English. Returns job_id. Re-call with only job_id to keep waiting.',
    inputSchema: { type: 'object', properties: {
      job_id: job,
      text: { type: 'string' },
      instruct: { type: 'string', description: 'description of the voice and delivery' },
      language: { type: 'string' },
      name: { type: 'string' }
    }, additionalProperties: false } },
  { name: 'generate_sfx', description: 'Generate a sound effect on the Dell with Stable Audio 3 Medium from a text prompt. seconds 1-30, default 5. Optional seed. Returns job_id. Re-call with only job_id to keep waiting. If the model weights are not available, this fails loudly with the reason (it does not unload the chat model).',
    inputSchema: { type: 'object', properties: {
      job_id: job,
      prompt: { type: 'string', description: 'description of the sound effect' },
      seconds: { type: 'number' },
      seed: { type: 'integer' },
      name: { type: 'string' }
    }, additionalProperties: false } },
  { name: 'separate_stems', description: 'Split a mix or song (a file path on this machine) into 2 stems on the Dell with Mel-Band RoFormer (Kim): vocals.wav and backing.wav (the mix minus the vocals). If the path is a video or container (.mov, .mp4, .mkv, .webm, and similar), the audio is extracted here to a 44.1 kHz stereo PCM WAV first and that WAV is sent to the Dell; no audio stream or ffmpeg failure fails the job with a clear error. Returns job_id. Re-call with only job_id to keep waiting.',
    inputSchema: { type: 'object', properties: {
      job_id: job,
      path: { type: 'string', description: 'mix or song file path on this machine' },
      name: { type: 'string' }
    }, additionalProperties: false } },
  { name: 'generate_image', description: 'Generate one image on the Dell with Z-Image-Turbo (text to image; there is no image editing). width/height 256-2048, multiples of 16, default 1024x1024. Use 1344x768 for 16:9 slides or storyboard frames, 768x512 for a frame you will animate with generate_video quality "final", and 832x480 for one you will animate with quality "draft". Optional seed. With project (+ characters / environment ids) the project\'s locked bible goes in front of the prompt verbatim, so describe only the action and framing. Each image unloads the Dell chat model for about a minute and waits its turn in the Dell GPU queue (which can take minutes); it is never cancelled. Returns job_id; call finish for the Viewer and MEDIA lines.',
    inputSchema: { type: 'object', properties: {
      job_id: job,
      prompt: { type: 'string', description: 'what the picture shows: subject, setting, composition, style, lighting' },
      width: { type: 'integer' }, height: { type: 'integer' }, seed: { type: 'integer' },
      ...bibleArgs,
      name: { type: 'string', description: 'short label for the job' }
    }, additionalProperties: false } },
  { name: 'generate_video', description: 'Render a short video clip on the Dell. quality is required and picks the model: "draft" = Wan 2.2 TI2V-5B, a quick look (832x480, 24 fps, NO sound, t2v or i2v only, seconds 1-5, default 3; about 4 min for 2 s) for trying an idea or a shot before the final; "final" = LTX-2.5, final quality (768x512 with generated sound; seconds 1-10, default 5; modes t2v, i2v, first_last, extend, restyle; optional style). Pick draft when Mo wants a quick look, a preview or to try ideas; final when he wants the finished clip, sound, or a final-only option. If unclear, render a draft first and offer the final. Draft with end_image, source, extend_seconds, control, style or mode first_last/extend/restyle fails with an error (it never switches model). Modes: t2v (prompt only), i2v (image = first frame), first_last (image + end_image), extend (source + extend_seconds 1-5; total at most 10 s; returns the whole longer clip), restyle (source + control canny/depth/pose; same length). mode defaults to i2v when image is given, else t2v. Write the prompt as one paragraph: subject, motion, camera, style, lighting (and sound for final). With project (+ characters / environment ids) the locked bible goes in front of the prompt verbatim. Every render unloads the Dell chat model for a few minutes and queues behind other GPU jobs; it is never cancelled. Waits up to 30 min; if still queued or running, call again with only job_id to keep waiting. Returns job_id.',
    inputSchema: { type: 'object', properties: {
      job_id: job,
      quality: { type: 'string', enum: ['draft', 'final'], description: 'draft = Wan 2.2 quick look (832x480, no sound, t2v/i2v, 1-5 s); final = LTX-2.5 final quality (768x512, sound, all modes, 1-10 s). Required for a new clip' },
      prompt: { type: 'string' },
      mode: { type: 'string', enum: ['t2v', 'i2v', 'first_last', 'extend', 'restyle'], description: 'draft: t2v or i2v only' },
      image: ref('first-frame image (JPEG/PNG/MPO, max 10 MiB; EXIF orientation applied)'),
      end_image: ref('last-frame image for first_last (final only)'),
      source: ref('source clip for extend or restyle (final only; MP4/MOV/WebM, max 10 MiB)'),
      seconds: { type: 'integer', description: 'draft 1-5 (default 3); final 1-10 (default 5) for t2v/i2v/first_last' },
      extend_seconds: { type: 'integer', description: 'final only, extend mode, 1-5' },
      style: { type: 'string', enum: ['anime', 'claymation', 'papercut', 'cyberpunk', 'painterly'], description: 'final only; omit for realistic' },
      control: { type: 'string', enum: ['canny', 'depth', 'pose'], description: 'final only, restyle mode' },
      seed: { type: 'integer' }, ...bibleArgs, name: { type: 'string' }
    }, additionalProperties: false } },
  { name: 'contact_sheet', description: 'Make one JPEG grid of numbered thumbnails on this machine with ffmpeg: from images (a list of image job_ids or paths, in order) or from one video (frames evenly sampled, default 12). For a storyboard use approve_storyboard (it makes the sheet). columns 1-8, default 4. Returns job_id; call finish.',
    inputSchema: { type: 'object', properties: {
      images: { type: 'array', items: ref('image') },
      video: ref('video clip'),
      frames: { type: 'integer' }, columns: { type: 'integer' }, name: { type: 'string' }
    }, additionalProperties: false } },
  { name: 'catalog', description: 'Reference text (no job, nothing rendered). topic: "shot-language" (the fixed camera vocabulary and continuity rules for storyboards), "storyboard" (the approval workflow), "bible", "compose", "deck", "captions", "review" (critique), or "projects" (every project bible, with the exact text it adds to prompts).',
    inputSchema: { type: 'object', properties: { topic: { type: 'string', enum: [...Object.keys(CATALOG), 'projects'] } }, required: ['topic'], additionalProperties: false } },
  { name: 'write_bible', description: 'Lock one style and character bible for a project (SKEL studio.json pattern). style_lock 10-80 words; characters [{id "char_<name>", name, identity_lock: the canonical 30-60-word look}]; environments [{id "env_<name>", name, style_lock 8-60 words}]; optional palette (#rrggbb, used by make_deck) and negative. From then on generate_image, generate_video and storyboard with project + ids put this text in front of every prompt, verbatim. A locked bible changes only with replace:true, when Mo asks. catalog "projects" shows existing bibles. Returns the exact text that will be used.',
    inputSchema: { type: 'object', properties: {
      project: str('short lowercase slug, e.g. "fox-tale"'), style_lock: str('the one look of the whole project: medium, palette, light, texture, lens (10-80 words)'),
      characters: { type: 'array', items: { type: 'object', properties: { id: str('char_<name>'), name: str('display name'), identity_lock: str('30-60 words: species/age, build, face, hair, eyes, wardrobe, one or two marks') }, required: ['id', 'name', 'identity_lock'], additionalProperties: false } },
      environments: { type: 'array', items: { type: 'object', properties: { id: str('env_<name>'), name: str('display name'), style_lock: str('8-60 words: place, materials, light, weather') }, required: ['id', 'name', 'style_lock'], additionalProperties: false } },
      palette: { type: 'array', items: { type: 'string' }, description: 'up to 6 colours #rrggbb' }, negative: str('what every picture avoids, e.g. "no text, no watermark"'),
      replace: { type: 'boolean', description: 'only when Mo asked to change an existing locked bible' }
    }, required: ['project', 'style_lock'], additionalProperties: false } },
  { name: 'storyboard', description: `Write (or, with job_id, revise) a storyboard: take's shots.json with the fixed shot vocabulary (catalog "shot-language"). Nothing is rendered and no GPU is used. It checks continuity (warnings, not blocking) and returns the numbered shot list: show it to Mo and ask him to approve or change it. aspect_ratio ${Object.keys(ASPECT_RATIOS).join(' | ')} (default 16:9). With project, characters/environment are bible ids and their look comes from the bible. Revising resets the approval. Returns job_id.`,
    inputSchema: { type: 'object', properties: {
      job_id: { ...job, description: 'only to revise an existing board (the full new board replaces it)' },
      title: str('board title'), project: str('project slug with a bible (recommended)'), aspect_ratio: { type: 'string', enum: Object.keys(ASPECT_RATIOS) },
      style: str('extra style words for this board only (the bible style_lock already applies)'),
      beats: { type: 'array', items: { type: 'object', properties: { summary: str('what happens'), purpose: str('why it is in the story'), emotion: str('feeling') }, required: ['summary', 'purpose'], additionalProperties: false } },
      shots: { type: 'array', items: shot, description: '1-24 shots in order' }, name: str('short label for the job')
    }, required: ['title', 'shots'], additionalProperties: false } },
  T('validate_storyboard', 'Check a storyboard again: take schema errors, plus continuity warnings (establishing shot, jump cuts, lighting per place, prompt vs shot size, bible changes). Warnings never block; tell Mo.'),
  T('approve_storyboard', 'Only after Mo approved the board in his own words: records his approval (mo_said), then renders one image per shot with generate_image (queued on the Dell GPU, each unloads the chat model about a minute, never cancelled) and makes a numbered contact sheet. Call again with only job_id to keep waiting or to retry a failed shot (finished shots are kept). Then critique, then finish.',
    { mo_said: str('Mo\'s own words approving the board (required the first time)') }),
  { name: 'make_captions', description: 'Timed captions on this machine (whisper.cpp small on the CPU; no Dell, no GPU): captions.srt and captions.vtt from a speech, song, video or compose job_id, or an audio/video file. language "auto" (default) or a code like "en". burn_in:true (video only) also writes captioned.mp4 with the captions drawn in. Takes about 1-2x the audio length. Returns job_id; call finish.',
    inputSchema: { type: 'object', properties: { source: ref('audio or video to caption'), language: str('"auto" or a code like "en"'), burn_in: { type: 'boolean' }, name: str('short label') }, required: ['source'], additionalProperties: false } },
  { name: 'compose', description: `Assemble one video from Synth jobs on this machine with editly (no Dell, no GPU): clips in order, each exactly one of image (still), video (with its own sound; cut_from/cut_to) or title (text card); per clip optional text (caption), narration (speech; the clip lasts at least as long), seconds, transition. Whole edit: size ${Object.keys(COMPOSE_SIZES).join(' | ')} (default 1280x720), seconds_per_clip (default 4), transition (default fade), music (song job_id/file) at music_volume (default 0.25), duck (default true with music: music dips under speech and clip sound). Use it for presentations-to-video, animatics and edits. Returns job_id; call finish.`,
    inputSchema: { type: 'object', properties: {
      clips: { type: 'array', items: clip, description: '1-60 clips in order' }, size: { type: 'string', enum: Object.keys(COMPOSE_SIZES) },
      seconds_per_clip: { type: 'number' }, transition: { type: 'string', enum: TRANSITIONS }, music: ref('background music'),
      music_volume: { type: 'number' }, duck: { type: 'boolean' }, name: str('short label')
    }, required: ['clips'], additionalProperties: false } },
  { name: 'make_deck', description: `Build one editable PowerPoint deck (.pptx, 16:9) on this machine with power-pptx: text is sized to fit its box, every slide is linted (overflow, off-slide, contrast) and rendered to check. Layouts: ${LAYOUTS.join(', ')} (catalog "deck" lists each one's fields). theme dark|light; with project the bible palette sets the colours. Images are image job_ids or files. Returns job_id with the deterministic check warnings; then critique, then finish (MEDIA gives the .pptx).`,
    inputSchema: { type: 'object', properties: {
      title: str('deck title'), slides: { type: 'array', items: slide, description: '1-40 slides in order' }, theme: { type: 'string', enum: ['dark', 'light'] },
      project: str('project slug: its bible palette sets the colours'), name: str('short label')
    }, required: ['title', 'slides'], additionalProperties: false } },
  T('critique', 'Review a finished deck, storyboard (after approve_storyboard), compose, contact sheet, image or video: the deterministic checks, then the Dell vision model looks at the rendered slides / contact sheet / sampled frames and lists concrete problems. At most 3 rounds per job. Warnings never block: tell Mo the open warnings and ask whether he wants another round; fix what he asks with the same tool that made it, then critique the new job.',
    { slide: { type: 'integer', description: 'deck only: look at one slide in detail' }, focus: str('what Mo wants checked, e.g. "is the fox the same in every shot?"') }),
  T('finish',
 'Return the lines to reply with for a finished job (outputs are in ~/synth/<job_id>/ on this machine): any open warnings, the Viewer link and MEDIA lines.'),
  T('show_job', 'State and results of a job.'),
  { name: 'list_jobs', description: 'Recent Synth jobs on this machine.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  T('cancel_job', 'Stop one of your own jobs, only when Mo asks to stop. Jobs started elsewhere cannot be cancelled. Song, image and video jobs on the Dell media gateway cannot be cancelled (the tool fails loudly); they finish or fail on their own. Never use it to make room: when the Dell is busy, jobs queue and the other tools wait their turn by themselves.')
];
module.exports = { TOOLS };

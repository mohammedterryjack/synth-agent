# synth-agent (Synth MCP server: media generation bot)

An MCP server plus a Node service that lets a Hermes agent (profile `synth`) make songs, speech, sound
effects, images and video on a LAN GPU box, and assemble them locally into storyboards, captioned edits and
editable slide decks. Everything is local: LAN only, no cloud APIs.

Ink-style design: few verb-first tools with strict schemas, reference text behind `catalog`, results that
start with the `job_id`, and warnings that are flagged to the user instead of blocking.

## Tools

| Tool | What it does |
|---|---|
| `generate_song` | music (ACE-Step 1.5 on the GPU box) |
| `speak`, `clone_voice`, `design_voice` | speech (Qwen3-TTS on the GPU box) |
| `generate_sfx`, `separate_stems` | sound effects, stem separation |
| `generate_image` | images (Z-Image-Turbo) |
| `generate_video` | `quality: draft` = Wan 2.2 TI2V-5B (quick, no sound), `quality: final` = LTX-2.5 |
| `contact_sheet` | numbered thumbnail grid (ffmpeg, local) |
| `catalog` | reference text, e.g. `shot-language` |
| `write_bible` | locked style / character bible per project, put verbatim in front of every prompt |
| `storyboard`, `validate_storyboard`, `approve_storyboard` | take-style shots.json board; no GPU spend until the user approves it |
| `make_captions` | SRT/VTT captions with whisper.cpp on the CPU, optional burn-in |
| `compose` | one timeline (clips, stills, titles, music with ducking, transitions) rendered with editly |
| `make_deck` | one editable 16:9 PPTX with power-pptx (text fitted to its box, contrast checks) |
| `critique` | deterministic checks, then a vision-model review of a rendered deck, board, edit or image |
| `list_jobs`, `show_job`, `cancel_job`, `finish` | job management (`make_slideshow` is a hidden alias of `compose`) |

## How it runs

- `mcp.js`: stateless stdio MCP server started by Hermes; forwards calls over an owner-only unix socket.
- `service.js`: systemd **user** service (`systemd/synth-agent.service`): talks to the GPU box, keeps jobs in
  `~/synth/<job_id>/`, and serves a keyless read-only viewer per job (`/v/<token>/`) on the LAN.
- `media.js` (images, video, contact sheets), `studio.js` + `board.js` (studio tools), `jobs.js`,
  `deck.py` (power-pptx), `normalise_image.py`.

```yaml
# Hermes profile config.yaml
mcp_servers:
  synth:
    command: /usr/bin/node
    args: [/home/<you>/Code/synth-agent/mcp.js]
    timeout: 2400
```

```sh
scripts/setup-vendor.sh                 # whisper.cpp + models, editly docker image, .venv for deck.py
cp systemd/synth-agent.service ~/.config/systemd/user/ && systemctl --user enable --now synth-agent
node --test test/*.test.js && python3 test_normalise_image.py
```

## Dependencies

Node.js 20+ (no npm packages), Python 3 venv (`requirements.txt`), ffmpeg, docker (for editly, run with
`--network none`), and the GPU box's media gateway, TTS service and chat model. `vendor/` is created by
`scripts/setup-vendor.sh` and is not committed. Local CPU renders (captions, compose, deck, contact sheet,
burn-in) take a machine-wide flock via `heavylock.js`, which runs a small `heavylock.py` helper
(`OLDMAC_HEAVYLOCK_PY`, default `~/Code/oldmac-heavy-lock/heavylock.py`; not published here).

## Configuration (environment)

Copy `.env.example` to `.env` (the systemd unit loads it with `EnvironmentFile`).

| Variable | Default | Meaning |
|---|---|---|
| `SYNTH_DIR` | `~/synth` | job outputs |
| `SYNTH_SOCK` | `~/.hermes/synth-agent/worker.sock` | service socket |
| `SYNTH_BIND` / `SYNTH_PORT` | (required) / `8648` | LAN viewer |
| `SYNTH_ENV_FILE` | `~/.hermes/profiles/synth/.env` | holds `DELL_LLM_API_KEY`, read per request |
| `DELL_MEDIA` | (required) | media gateway (music, images, video) |
| `DELL_SYNTH` | (required) | TTS service |
| `DELL_LLM` / `DELL_LLM_MODEL` | (required) / `Qwen3.8-Flash-Next-UD-IQ4_XS` | chat / vision model for `critique` |
| `SYNTH_EDITLY_IMAGE` | `synth-editly:0.15.0-rc.1` | editly docker image |
| `SYNTH_CALL_TIMEOUT_MS` | 40 min | MCP call timeout |

The defaults are private LAN addresses on the author's home network; override them for yours. No keys are in
this repo. Requests carry `X-Client: synth-agent` so the GPU box can schedule them.

## Credits

See `THIRD_PARTY_NOTICES.md`: take (MIT, storyboard schema and shot vocabulary), editly (MIT), whisper.cpp
(MIT), Silero VAD (MIT), power-pptx (MIT).

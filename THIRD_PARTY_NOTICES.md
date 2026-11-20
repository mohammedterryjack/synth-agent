# Third-party notices

| Component | Use in Synth | Licence | Shipped here? |
|---|---|---|---|
| [take](https://github.com/XucroYuri/take) by XucroYuri | shot vocabulary, shot-language rules and the shots.json storyboard schema, adapted in `board.js`; `test/fixtures/take-rain-night.shots.json` | MIT | adapted code (notice below) |
| [editly](https://github.com/mifi/editly) by Mikael Finstad | `compose` timeline renderer, run as a local docker image | MIT | no, built by `scripts/setup-vendor.sh` |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (ggml-org) | `make_captions` speech-to-text on the CPU | MIT | no, built by `scripts/setup-vendor.sh` |
| whisper `ggml-small-q5_1` model (OpenAI Whisper, converted by ggml-org) | caption model | MIT | no, downloaded |
| [Silero VAD](https://github.com/snakers4/silero-vad) v6.2.0 (ggml build) | speech detection for captions | MIT | no, downloaded |
| [power-pptx](https://github.com/codehalwell/power-pptx) | `make_deck` editable PPTX builder (`deck.py`) | MIT | no, `pip install -r requirements.txt` |
| FFmpeg | contact sheets, music ducking, caption burn-in | LGPL/GPL | no, system package |

## take — MIT License

```
MIT License

Copyright (c) 2026 XucroYuri

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

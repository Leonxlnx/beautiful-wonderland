# Rendering the film

Pipeline: `render.mjs` (frames, GPU) → `mix.mjs` (soundtrack) → `encode.mjs` (MP4) → `sheet.mjs` (review).
The film is 40 s × 30 fps = frames `f00000`…`f01199`; frame index = round(t·30). Only one GPU job runs at a
time (`out/.gpu.lock`, shared with `shot.mjs`); a second job waits for it.

## 1. Frames — `tools/render.mjs`
```
node tools/render.mjs --name d1 --size 960x540 --tiles 2x2 --every 10            # quick draft, 120 frames
node tools/render.mjs --name d2 --size 1920x1080 --tiles 2x2 --from 10 --to 20    # one section, half size
node tools/render.mjs --name v1                                                  # final: 3840x2160, 4x4 tiles, all 1200 frames
```
Options: `--from/--to` film seconds (to is exclusive) or `--frames a-b` (inclusive indices), `--every N`,
`--force` (re-render existing), `--parts a,b`, `--q film|high|live`, `--rest 120` (ms pause per frame; there is
also a 4 s pause every 100 frames), `--timeout 300` (s per frame), `--restart 300` (new browser every N frames).

Output: `out/frames/<name>/f%05d.png` plus
- `render.log`: one line per frame (`ms` render in the page, `cap` capture incl. pixel transfer, `png` encode,
  `saved` total) and `#` lines for sessions, retries and failures;
- `status.json`: `{state, done, total, remaining, lastFrame, etaSec, avgFrameSec, failed, pid, updatedAt, …}`, rewritten after
  every frame. Poll it from another process;
- `meta.json`: size/fps/every, read by `encode.mjs` and `sheet.mjs`.

**Resume**: run the same command again. Complete frames of the right size are skipped. Frames are written
to a temp name and renamed, so a killed run never leaves a half-written PNG.
**Stop cleanly** after the current frame: create `out/frames/<name>/STOP` (exit code 3). Ctrl-C also works.
**Robustness**: a capture that throws, takes longer than `--timeout`, or loses the WebGL context closes the
browser, waits 5 s and retries in a new session (3 tries per frame, then the frame is logged as failed and the run
goes on; 5 failed frames in a row abort). Exit code is 0 only if every requested frame exists.

Measured on the Radeon 780M: 960×540 2×2 ≈ 45 ms render, ~0.45 s per saved frame; 3840×2160 4×4 ≈ 1.6–2 s
render, 4.5–8 s per saved frame once warm (first frame of a session +10–45 s for start-up and shader compile).
The full film is therefore roughly 1.5–3 h, depending on the scene and on what else is running.

## 2. Soundtrack — `tools/mix.mjs`
```
node tools/mix.mjs                                         # assets/audio/mix.json -> out/audio/mix.wav
node tools/mix.mjs --spec out/mixtest/mixtest.json --out out/mixtest/mixtest.wav
node tools/mix.mjs --spec assets/audio/mix.json --dry      # validate + print the filter graph only
```
Spec (gains in dB, times in seconds, paths relative to the project root):
```json
{ "duration": 40,
  "music": { "file": "assets/audio/music/x.mp3", "start": 12.3, "gain": 0, "fadeIn": 0.02, "fadeOut": 2.5 },
  "sfx": [ { "file": "assets/audio/sfx/y.wav", "at": 0, "start": 0, "dur": 12, "gain": -18, "fadeIn": 1, "fadeOut": 2,
             "loop": false, "end": null, "pan": 0, "lowpass": null, "highpass": null } ],
  "target": { "lufs": -14, "tp": -1.5 },
  "duck": { "enabled": false, "threshold": -30, "ratio": 4, "attack": 20, "release": 400 } }
```
`at` = where it starts in the film, `start` = offset inside the file, `dur` = length in the film (default: to the end
of the film, or the end of the file). `loop` repeats the file region `start`…`end` (`end` defaults to the file end)
until `dur` is filled. `pan` −1…1. `duck` lowers the music under the sum of the SFX.
Only real audio files are used. The tool refuses any ffmpeg generator (sine, anoisesrc, aevalsrc, anullsrc, …).
Result: 48 kHz stereo 24-bit WAV of exactly `duration` s, normalised with two-pass `loudnorm` in linear mode. If
the peaks don't allow a linear gain, a 4×-oversampled limiter runs first. The tool prints integrated LUFS, LRA and true
peak (loudnorm and ebur128 meters) and writes `<out>_report.json`. Exit code 1 if true peak > target,
loudness is off by more than 0.5 LU, or the length isn't sample-exact.

## 3. Video — `tools/encode.mjs`
```
node tools/encode.mjs --name d1                                                   # draft, no audio
node tools/encode.mjs --name v1 --audio out/audio/mix.wav --scale 1920:-2 --out out/video/v1_1080.mp4
node tools/encode.mjs --name v1 --audio out/audio/mix.wav --x                    # 4K master (CRF 15) + v1_x.mp4 (upload)
```
H.264 High, yuv420p, RGB→YUV with the BT.709 matrix (limited range), stream tagged bt709/bt709/bt709/tv,
closed 2 s GOP, `+faststart`, `-threads 10` at below-normal priority. Frames are piped to ffmpeg in order, so drafts
made with `--every N` play in real time: each frame is held for N frames (`--frames-step N` forces the step;
missing frames are an error unless `--allow-gaps`). Audio (AAC 320k, 48 kHz) starts at the film time of the first
frame and is padded or trimmed to exactly the video length. `--x` adds `<name>_x.mp4` at native frame size, CRF 18,
maxrate 60M / bufsize 120M, AAC 256k. After encoding, an ffprobe summary is printed (codec, size, fps, frames,
duration, pix_fmt, colour tags, keyframes, bitrates, audio).

## 4. Review sheets — `tools/sheet.mjs`
```
node tools/sheet.mjs --name v1 --from 0 --to 40 --step 2 --out out/sheets/v1_a.jpg      # from frames
node tools/sheet.mjs --video out/video/v1.mp4 --from 30 --to 40 --step 0.5 --cols 5       # from a video
```
Nearest frame to each time, labelled `t=… f…`, 4 columns × 640 px by default, capped at 2600 px wide (`--maxw`).

## Typical session
1. Draft: `render --name d1 --size 960x540 --tiles 2x2 --every 10`, then `encode --name d1`, then `sheet --name d1`.
2. Soundtrack: write `assets/audio/mix.json`, `mix --dry`, then `mix`.
3. Final: `render --name v1` (resumable; poll `out/frames/v1/status.json`), `sheet --name v1`, then
   `encode --name v1 --audio out/audio/mix.wav --x`.

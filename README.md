# ViralClips MVP

Upload a long video and automatically generate short vertical clips optimized for TikTok, Instagram Reels, and YouTube Shorts. The tool finds the best moments, adds captions, and suggests hooks.

## Prerequisites

```bash
brew install ffmpeg python yt-dlp
pip install faster-whisper
# Or install Python deps (includes yt-dlp for YouTube links):
pip install -r requirements.txt
```

## Setup

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### YouTube links (optional `yt-dlp` cookies)

Paste links use **yt-dlp** on the server only (no YouTube Data API). YouTube sometimes returns bot-check / sign-in walls; without extra setup, those links may fail and the app shows a short message instead of raw tool output.

Optionally set **`YT_DLP_COOKIES_FILE`** to an absolute path of a **Netscape-format cookies file** (e.g. exported for use with `yt-dlp`). That file is read **only on the server** by `yt-dlp` for metadata and download—not by the browser and not by user accounts in the app. If the variable is unset, behavior matches the previous release (no cookies). If the path is set but the file is missing, cookies are skipped and a warning is logged.

Metadata and download **retry** with several YouTube `player_client` chains (datacenter IPs often fail on the default web client). When cookies are present, `tv_downgraded,web_safari` is tried first. To force one strategy, set **`YT_DLP_YOUTUBE_EXTRACTOR_ARGS`** to a full string such as `youtube:player_client=tv_downgraded,web_safari` (or omit the `youtube:` prefix; it will be added). Keep **`yt-dlp` current** (`pip install -U yt-dlp` or redeploy after bumping `requirements.txt`).

### Premium viral captions (optional word-level timing)

By default, viral caption **timing** uses the existing local **SRT** from the job. For **better sync**, set:

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | Enables **OpenAI Whisper** word-level timestamps on the clip audio (extra API cost per burn). |
| `VIRAL_CAPTION_TIMING_PROVIDER` | `auto` (default): use OpenAI when the key is set, else SRT. `openai`: require OpenAI (falls back to SRT on failure). `local`: always SRT. |

No extra npm packages are required (`fetch` only). Multi-speaker labels are **not** returned by Whisper; `TimedWord.speaker` is reserved for a future diarized provider.

## How It Works

1. Upload a video (MP4, MOV, M4V)
2. Choose platform, goal, and plan
3. Click "Generate Clips"
4. The pipeline:
   - Extracts audio from the video
   - Transcribes using faster-whisper (runs locally)
   - Finds strong shareable moments using text heuristics (Growth & Monetize modes)
   - Cuts vertical clips (1080x1920) with burned-in captions
   - Adds watermark on Free plan
5. Download your clips

## Project Structure

```
app/page.tsx                    — Main UI (upload, settings, results)
app/api/process/init/route.ts   — Create job (returns jobId before file upload)
app/api/process/upload/route.ts — Upload video, ffprobe + budget, then queue job
app/api/files/[...path]/route.ts — File serving for generated clips
lib/ffmpeg.ts                   — FFmpeg wrapper utilities
lib/segmenter.ts                — Viral moment detection algorithm
lib/srt.ts                      — SRT subtitle generation
scripts/transcribe.py           — Python transcription with faster-whisper
storage/                        — Uploads, jobs, and outputs (gitignored)
```

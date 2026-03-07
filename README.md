# ViralClips MVP

Upload a long video and automatically generate short vertical clips optimized for TikTok, Instagram Reels, and YouTube Shorts. The tool finds the best moments, adds captions, and suggests hooks.

## Prerequisites

```bash
brew install ffmpeg python
pip install faster-whisper
```

## Setup

```bash
cd src/data/ClipFArm
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## How It Works

1. Upload a video (MP4, MOV, M4V)
2. Choose platform, goal, and plan
3. Click "Generate Clips"
4. The pipeline:
   - Extracts audio from the video
   - Transcribes using faster-whisper (runs locally)
   - Finds strong/viral moments using text heuristics
   - Cuts vertical clips (1080x1920) with burned-in captions
   - Adds watermark on Free plan
5. Download your clips

## Project Structure

```
app/page.tsx                    — Main UI (upload, settings, results)
app/api/process/route.ts        — Processing pipeline API
app/api/files/[...path]/route.ts — File serving for generated clips
lib/ffmpeg.ts                   — FFmpeg wrapper utilities
lib/segmenter.ts                — Viral moment detection algorithm
lib/srt.ts                      — SRT subtitle generation
scripts/transcribe.py           — Python transcription with faster-whisper
storage/                        — Uploads, jobs, and outputs (gitignored)
```

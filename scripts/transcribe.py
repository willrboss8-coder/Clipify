#!/usr/bin/env python3
"""Transcribe audio using faster-whisper and output JSON."""

import json
import sys

def main():
    if len(sys.argv) < 3:
        print("Usage: transcribe.py <audio_path> <output_json_path>", file=sys.stderr)
        sys.exit(1)

    audio_path = sys.argv[1]
    output_path = sys.argv[2]

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("Error: faster-whisper not installed. Run: pip install faster-whisper", file=sys.stderr)
        sys.exit(1)

    model = WhisperModel("base", device="cpu", compute_type="int8")

    segments_iter, info = model.transcribe(audio_path, beam_size=1)

    segments = []
    for segment in segments_iter:
        segments.append({
            "start": round(segment.start, 2),
            "end": round(segment.end, 2),
            "text": segment.text.strip(),
        })

    result = {
        "duration": round(info.duration, 2),
        "segments": segments,
    }

    with open(output_path, "w") as f:
        json.dump(result, f, indent=2)

    print(json.dumps({"status": "ok", "segments": len(segments), "duration": result["duration"]}))

if __name__ == "__main__":
    main()

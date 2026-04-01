#!/usr/bin/env python3
"""
Long-lived faster-whisper worker: loads the model once, then reads one JSON request per line
from stdin and writes one JSON response line per request to stdout. Writes transcript JSON to
the path given in each request (same shape as transcribe.py).

Protocol:
  Line 1 (stdout): {"type":"ready","model_load_sec":<float>}
  Per request (stdin): {"audio_path":"<abs>","output_json_path":"<abs>"}
  Per response (stdout): {"ok":true,"transcribe_wall_sec":<float>,...} or {"ok":false,"error":"..."}

Logs for operators go to stderr only; stdout is reserved for the protocol.
"""

from __future__ import annotations

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from whisper_env import resolve_whisper_model  # noqa: E402


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def main() -> None:
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        log(
            "Error: faster-whisper not installed. Run: pip install faster-whisper",
        )
        sys.exit(1)

    model_name = resolve_whisper_model()
    log(f"[whisper] loading model={model_name}")

    t0 = time.perf_counter()
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    load_sec = time.perf_counter() - t0

    print(
        json.dumps(
            {
                "type": "ready",
                "model_load_sec": round(load_sec, 3),
                "whisper_model": model_name,
            }
        ),
        flush=True,
    )

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            audio_path = req["audio_path"]
            output_path = req["output_json_path"]
        except (json.JSONDecodeError, KeyError, TypeError) as e:
            print(
                json.dumps({"ok": False, "error": f"bad request: {e}"}),
                flush=True,
            )
            continue

        t1 = time.perf_counter()
        try:
            segments_iter, info = model.transcribe(audio_path, beam_size=1)

            segments = []
            for segment in segments_iter:
                segments.append(
                    {
                        "start": round(segment.start, 2),
                        "end": round(segment.end, 2),
                        "text": segment.text.strip(),
                    }
                )

            result = {
                "duration": round(info.duration, 2),
                "segments": segments,
            }

            with open(output_path, "w") as f:
                json.dump(result, f, indent=2)

            wall = time.perf_counter() - t1
            print(
                json.dumps(
                    {
                        "ok": True,
                        "transcribe_wall_sec": round(wall, 3),
                        "segments": len(segments),
                        "duration": result["duration"],
                    }
                ),
                flush=True,
            )
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}), flush=True)


if __name__ == "__main__":
    main()

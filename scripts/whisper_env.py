"""Shared Whisper model selection via CLIP_WHISPER_MODEL (default: base)."""

from __future__ import annotations

import os
import sys

ENV_KEY = "CLIP_WHISPER_MODEL"
DEFAULT_MODEL = "base"

# Allowlist only — invalid values fall back to DEFAULT_MODEL.
ALLOWED_WHISPER_MODELS = frozenset(
    {
        "tiny",
        "tiny.en",
        "base",
        "base.en",
        "small",
        "small.en",
        "medium",
        "medium.en",
    }
)


def resolve_whisper_model() -> str:
    raw = os.environ.get(ENV_KEY, "").strip()
    if not raw:
        return DEFAULT_MODEL
    if raw not in ALLOWED_WHISPER_MODELS:
        print(
            f"[whisper] {ENV_KEY}={raw!r} not allowed; using {DEFAULT_MODEL}",
            file=sys.stderr,
            flush=True,
        )
        return DEFAULT_MODEL
    return raw

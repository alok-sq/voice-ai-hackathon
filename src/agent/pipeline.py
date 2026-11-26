"""Which speech pipeline a call uses. Encoded in LiveKit job metadata."""
from __future__ import annotations

import json
from typing import Tuple

PIPELINES = ("cascade", "s2s")
DEFAULT_PIPELINE = "cascade"


def parse_dispatch_metadata(raw: str | None) -> Tuple[str, str]:
    """Return (language, pipeline). Accepts JSON or the old plain language code."""
    text = (raw or "hi").strip() or "hi"
    lang, pipeline = text, DEFAULT_PIPELINE
    try:
        data = json.loads(text)
    except ValueError:
        data = None
    if isinstance(data, dict):
        lang = str(data.get("language") or "hi").strip() or "hi"
        pipeline = str(data.get("pipeline") or DEFAULT_PIPELINE).strip() or DEFAULT_PIPELINE
    elif ":" in text:
        left, right = text.split(":", 1)
        lang = left.strip() or "hi"
        pipeline = right.strip() or DEFAULT_PIPELINE
    if pipeline not in PIPELINES:
        pipeline = DEFAULT_PIPELINE
    return lang, pipeline


def dispatch_metadata(language: str, pipeline: str = DEFAULT_PIPELINE) -> str:
    if pipeline not in PIPELINES:
        pipeline = DEFAULT_PIPELINE
    return json.dumps({"language": language, "pipeline": pipeline})

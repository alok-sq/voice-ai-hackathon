"""Per-call latency, tokens and audio seconds. Cost uses rates from env (0 until you set them)."""
from __future__ import annotations

import os
from typing import Any, Dict, List


def _percentile(values: List[float], p: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    # nearest-rank
    k = max(0, min(len(s) - 1, int(round(p / 100.0 * len(s) + 0.5)) - 1))
    return float(s[k])


def _rate(name: str) -> float:
    try:
        return float(os.getenv(name, "0") or 0)
    except ValueError:
        return 0.0


class CallMetrics:
    def __init__(self) -> None:
        self.reply_ms: List[float] = []
        self.tokens_in = 0
        self.tokens_out = 0
        self.stt_seconds = 0.0
        self.tts_characters = 0

    def record_turn(self, reply_ms: float) -> None:
        self.reply_ms.append(reply_ms)

    def cost_inr(self) -> float:
        """Rates (INR): COST_LLM_IN_PER_MTOK, COST_LLM_OUT_PER_MTOK, COST_STT_PER_HOUR, COST_TTS_PER_1K_CHARS."""
        return round(
            self.tokens_in / 1e6 * _rate("COST_LLM_IN_PER_MTOK")
            + self.tokens_out / 1e6 * _rate("COST_LLM_OUT_PER_MTOK")
            + self.stt_seconds / 3600 * _rate("COST_STT_PER_HOUR")
            + self.tts_characters / 1000 * _rate("COST_TTS_PER_1K_CHARS"),
            4,
        )

    def summary(self) -> Dict[str, Any]:
        return {
            "turns": len(self.reply_ms),
            "p50_ms": round(_percentile(self.reply_ms, 50)),
            "p95_ms": round(_percentile(self.reply_ms, 95)),
            "tokens_in": self.tokens_in,
            "tokens_out": self.tokens_out,
            "audio_seconds": round(self.stt_seconds, 1),
            "tts_characters": self.tts_characters,
            "est_cost_inr": self.cost_inr(),
        }

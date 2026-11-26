"""Publishes contract-v1 events on the LiveKit data topic `call-events`.

Source of truth for the shapes: web/src/contract/events.ts.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger("agent.events")

EVENTS_TOPIC = "call-events"
COMMANDS_TOPIC = "console-commands"


class EventPublisher:
    def __init__(self, send: Callable[[bytes, str], "asyncio.Future[Any] | Any"]):
        """`send(payload, topic)` publishes reliably. Injected so tests need no room."""
        self._send = send
        self._seq = 0
        self.transcript: List[Dict[str, Any]] = []  # finals + latest interims, for snapshots
        self.sent: List[Dict[str, Any]] = []

    def emit(self, type_: str, **fields: Any) -> Dict[str, Any]:
        self._seq += 1
        event = {"type": type_, "seq": self._seq, "ts": int(time.time() * 1000), **fields}
        self.sent.append(event)
        try:
            result = self._send(json.dumps(event, ensure_ascii=False).encode("utf-8"), EVENTS_TOPIC)
            if asyncio.iscoroutine(result) or isinstance(result, asyncio.Future):
                asyncio.ensure_future(self._swallow(result))
        except Exception:  # a failed publish must never break the call
            logger.exception("publish failed for %s", type_)
        return event

    @staticmethod
    async def _swallow(awaitable: Any) -> None:
        try:
            await awaitable
        except Exception:
            logger.exception("publish failed")

    # transcript bookkeeping so a console joining mid-call can catch up
    def remember_line(self, line_id: str, role: str, text: str, final: bool) -> None:
        for line in self.transcript:
            if line["id"] == line_id:
                line.update(text=text, final=final)
                return
        self.transcript.append({"id": line_id, "role": role, "text": text, "final": final})

    def snapshot(self, state: Optional[str], lead: Dict[str, Any], outcome: Optional[str]) -> Dict[str, Any]:
        fields: Dict[str, Any] = {"state": state, "lead": lead, "transcript": self.transcript[-60:]}
        if outcome:
            fields["outcome"] = outcome
        return self.emit("snapshot", **fields)

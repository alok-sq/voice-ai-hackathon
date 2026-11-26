"""One recorder per call. Listens to every event the agent publishes and stages the conversation.

The recorder is the backend's source of truth during a call: it does not depend on the console.
- `observe(event)` is synchronous and never raises (a recording problem must not break the call).
- Redis writes go through one ordered queue per call; if Redis is down they wait in memory and
  are retried with backoff, still in order.
- `complete()` closes the conversation: Redis -> PostgreSQL, or memory -> PostgreSQL / disk spool
  when Redis is unavailable.
"""
from __future__ import annotations

import asyncio
import logging
import os
from collections import deque
from typing import Any, Deque, Dict, Optional, Tuple

from .buffer import ConversationBuffer, now_ms
from .models import SPEAKERS, ConversationMeta, ConversationStatus, Message
from .persistence import ConversationPersistenceService, log_event
from .store import PostgresConversationStore

logger = logging.getLogger("agent.conversation")

Op = Tuple[str, Any]


class ConversationRecorder:
    def __init__(
        self,
        conversation_id: str,
        buffer: Optional[ConversationBuffer],
        persistence: Optional[ConversationPersistenceService],
        *,
        language: Optional[str] = None,
        agent_name: Optional[str] = None,
        channel: Optional[str] = None,
        complete_timeout_s: float = 15.0,
        redis_retry_max_s: float = 10.0,
    ):
        self.cid = conversation_id
        self.buffer = buffer
        self.persistence = persistence
        self.complete_timeout_s = complete_timeout_s
        self.redis_retry_max_s = redis_retry_max_s
        t = now_ms()
        self.meta = ConversationMeta(
            conversation_id=conversation_id, call_id=conversation_id, started_at_ms=t, last_activity_ms=t,
            language=language, agent_name=agent_name, channel=channel,
        )
        self._first_seen: Dict[str, Tuple[int, int]] = {}  # line id -> (seq, ts) of its first event
        self._messages: Dict[str, Message] = {}  # in-memory copy of every final message
        self._ops: Deque[Op] = deque()
        self._drainer: Optional["asyncio.Task[None]"] = None
        self._redis_ok = True
        self._completed = False
        self.enabled = buffer is not None or (persistence is not None and persistence.store is not None)
        if buffer is not None:
            self._ops.append(("start", None))
        log_event("conversation_created", conversation_id=conversation_id, redis=buffer is not None,
                  database=bool(persistence and persistence.store is not None))
        self._kick()

    # ---------- factory ----------
    @classmethod
    def from_env(cls, conversation_id: str, **kwargs: Any) -> "ConversationRecorder":
        buffer, persistence = get_services()
        return cls(conversation_id, buffer, persistence, **kwargs)

    # ---------- event intake (sync, never raises) ----------
    def observe(self, event: Dict[str, Any]) -> None:
        if self._completed:
            return
        try:
            self._observe(event)
        except Exception:
            logger.exception("conversation_observe_failed conversation_id=%s", self.cid)

    def _observe(self, e: Dict[str, Any]) -> None:
        kind = e.get("type")
        if kind == "transcript":
            speaker = SPEAKERS.get(str(e.get("role")))
            line_id = e.get("id")
            if not speaker or not line_id:
                return  # not a conversation line we can identify
            seq, ts = int(e.get("seq") or 0), int(e.get("ts") or now_ms())
            first = self._first_seen.setdefault(str(line_id), (seq, ts))
            text = str(e.get("text") or "").strip()
            if e.get("final") is False or not text:
                return  # interim: only remembered for ordering
            if line_id in self._messages:
                log_event("conversation_duplicate_ignored", conversation_id=self.cid, message_id=line_id, where="memory")
                return
            msg = Message(self.cid, str(line_id), first[0], first[1], speaker, text)
            self._messages[str(line_id)] = msg
            self._enqueue(("append", msg))
        elif kind == "lead" and e.get("field"):
            self.meta.lead[str(e["field"])] = e.get("value")
            self._enqueue(("meta", {"lead": dict(self.meta.lead)}))
        elif kind == "outcome" and e.get("outcome"):
            self.meta.outcome = str(e["outcome"])
            self.meta.outcome_reason = e.get("reason") or None
            self.meta.callback_at = e.get("callbackAt") or None
            self._enqueue(("meta", {"outcome": self.meta.outcome, "outcome_reason": self.meta.outcome_reason,
                                    "callback_at": self.meta.callback_at}))
        elif kind == "handoff":
            self.meta.handoff_requested = True
            self._enqueue(("meta", {"handoff_requested": True}))

    def set_channel(self, channel: str) -> None:
        self.meta.channel = channel
        self._enqueue(("meta", {"channel": channel}))

    @property
    def messages(self):
        return sorted(self._messages.values(), key=lambda m: (m.sequence, m.timestamp_ms))

    # ---------- ordered Redis writes ----------
    def _enqueue(self, op: Op) -> None:
        if self.buffer is None:
            return
        self._ops.append(op)
        self._kick()

    def _kick(self) -> None:
        if self.buffer is None or not self._ops or self._completed:
            return
        if self._drainer is not None and not self._drainer.done():
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return  # no loop yet; flush()/complete() will drain
        self._drainer = loop.create_task(self._drain_loop())

    async def _drain_loop(self) -> None:
        delay = 0.5
        while self._ops and not self._completed:
            if await self._drain_once():
                return
            await asyncio.sleep(delay)
            delay = min(delay * 2, self.redis_retry_max_s)

    async def _drain_once(self) -> bool:
        """Apply queued ops in order. Stops at the first failure and keeps the rest queued."""
        assert self.buffer is not None
        while self._ops:
            kind, payload = self._ops[0]
            try:
                if kind == "start":
                    await self.buffer.start(self.meta)
                    log_event("conversation_redis_initialized", conversation_id=self.cid)
                elif kind == "append":
                    if await self.buffer.append(payload):
                        log_event("conversation_message_stored", conversation_id=self.cid, message_id=payload.message_id,
                                  sequence=payload.sequence, speaker=payload.speaker)
                    else:
                        log_event("conversation_duplicate_ignored", conversation_id=self.cid,
                                  message_id=payload.message_id, where="redis")
                elif kind == "meta":
                    await self.buffer.update_meta(self.cid, **payload)
            except Exception as e:
                if self._redis_ok:
                    log_event("conversation_redis_write_failed", logging.WARNING, conversation_id=self.cid,
                              op=kind, queued=len(self._ops), error=type(e).__name__)
                self._redis_ok = False
                return False
            self._ops.popleft()
            if not self._redis_ok:
                self._redis_ok = True
                log_event("conversation_redis_recovered", conversation_id=self.cid)
        return True

    async def flush(self) -> bool:
        """Wait for queued writes (tests and shutdown). True when everything reached Redis."""
        if self.buffer is None:
            return True
        if self._drainer is not None and not self._drainer.done():
            try:
                await asyncio.wait_for(asyncio.shield(self._drainer), timeout=0.05)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                pass
        return await self._drain_once()

    # ---------- end of call ----------
    async def complete(self, end_reason: str, result: Optional[Dict[str, Any]] = None,
                       metrics: Optional[Dict[str, Any]] = None, handoff_requested: Optional[bool] = None) -> bool:
        """Close the conversation and persist it. Idempotent. Returns True once permanently stored."""
        if self._completed:
            return False
        try:
            return await asyncio.wait_for(self._complete(end_reason, result, metrics, handoff_requested), self.complete_timeout_s)
        except asyncio.TimeoutError:
            log_event("conversation_persist_deferred", logging.WARNING, conversation_id=self.cid, reason="complete timed out")
            return False

    async def _complete(self, end_reason, result, metrics, handoff_requested) -> bool:
        # Fold in the authoritative end-of-call record before freezing the event intake.
        if result:
            self.meta.outcome = result.get("outcome") or self.meta.outcome
            self.meta.outcome_reason = result.get("reason") or self.meta.outcome_reason
            self.meta.callback_at = result.get("callback_at") or self.meta.callback_at
        if metrics:
            self.meta.metrics = dict(metrics)
        if handoff_requested:
            self.meta.handoff_requested = True
        self.meta.end_reason = end_reason or None
        self.meta.ended_at_ms = now_ms()
        self.meta.status = ConversationStatus.COMPLETED_PENDING_PERSISTENCE
        log_event("conversation_completed", conversation_id=self.cid, messages=len(self._messages),
                  outcome=self.meta.outcome, reason=_short(end_reason))

        redis_ok = False
        if self.buffer is not None:
            self._ops.append(("meta", {"lead": dict(self.meta.lead), "outcome": self.meta.outcome,
                                       "outcome_reason": self.meta.outcome_reason, "callback_at": self.meta.callback_at,
                                       "metrics": self.meta.metrics, "handoff_requested": self.meta.handoff_requested,
                                       "channel": self.meta.channel}))
            self._completed = True  # stop the background drainer; we drain here
            if self._drainer is not None and not self._drainer.done():
                self._drainer.cancel()
            try:
                redis_ok = await self._drain_once()
                if redis_ok:
                    await self.buffer.complete(self.cid, self.meta.ended_at_ms, end_reason=self.meta.end_reason)
            except Exception as e:
                redis_ok = False
                log_event("conversation_redis_write_failed", logging.WARNING, conversation_id=self.cid,
                          op="complete", error=type(e).__name__)
        self._completed = True

        if redis_ok and self.persistence is not None:
            return await self.persistence.persist_with_retry(self.cid)
        if self.persistence is not None:  # Redis missing or down: the in-memory copy is the source of truth
            log_event("conversation_redis_unavailable", logging.WARNING, conversation_id=self.cid, path="direct")
            result = await self.persistence.persist_direct(self.meta, self.messages)
            if result == "stored" and self.buffer is not None:
                try:  # retire any partial Redis copy so the reconciler does not re-persist it
                    await self.buffer.mark_persisted(self.cid)
                except Exception:
                    pass
            return result == "stored"
        return False


def _short(text: Optional[str]) -> str:
    return (text or "").replace(" ", "_")[:40] or "-"


# ---------- per-process services ----------
_SERVICES: Dict[int, Tuple[Optional[ConversationBuffer], Optional[ConversationPersistenceService]]] = {}
_RECONCILERS: Dict[int, "asyncio.Task[None]"] = {}


def get_services() -> Tuple[Optional[ConversationBuffer], Optional[ConversationPersistenceService]]:
    """One Redis client and one PostgreSQL pool per event loop, built from REDIS_URL / DATABASE_URL."""
    try:
        key = id(asyncio.get_running_loop())
    except RuntimeError:
        key = 0
    if key not in _SERVICES:
        buffer = ConversationBuffer.from_env()
        store = PostgresConversationStore.from_env()
        persistence = ConversationPersistenceService.from_env(buffer, store) if (buffer or store) else None
        if buffer is None:
            log_event("conversation_buffer_disabled", logging.WARNING, reason="REDIS_URL not set")
        if store is None:
            log_event("conversation_store_disabled", logging.WARNING, reason="DATABASE_URL not set")
        _SERVICES[key] = (buffer, persistence)
    return _SERVICES[key]


def ensure_reconciler() -> None:
    """Start one background reconciliation loop per worker process (idempotent)."""
    _, persistence = get_services()
    if persistence is None:
        return
    loop = asyncio.get_running_loop()
    task = _RECONCILERS.get(id(loop))
    if task is None or task.done():
        interval = float(os.getenv("CONVERSATION_RECONCILE_INTERVAL_S", "60"))
        _RECONCILERS[id(loop)] = loop.create_task(persistence.run_forever(interval))

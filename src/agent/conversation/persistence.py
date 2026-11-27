"""Redis buffer -> PostgreSQL, with locking, retries, reconciliation and a last-resort disk spool.

Invariants:
- The Redis copy is removed only after the store confirmed the write (mark_persisted).
- A failed store write leaves the conversation COMPLETED_PENDING_PERSISTENCE in Redis for retry.
- If Redis itself is unavailable at the end of a call, the recorder's in-memory copy is written
  straight to the store; if that fails too, it is spooled to disk and the reconciler retries it.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import asdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from .buffer import ConversationBuffer, now_ms
from .log_builder import build_record
from .models import ConversationMeta, ConversationStatus, Message

logger = logging.getLogger("agent.conversation")


def log_event(event: str, level: int = logging.INFO, **fields: Any) -> None:
    """Structured, content-free log line: `event key=value ...`. Never pass message text here."""
    logger.log(level, "%s %s", event, " ".join(f"{k}={v}" for k, v in fields.items()))


class ConversationPersistenceService:
    def __init__(
        self,
        buffer: Optional[ConversationBuffer],
        store: Any,
        spool_dir: Optional[str] = None,
        retry_delays_s: Iterable[float] = (1.0, 4.0),
        stale_after_s: float = 1800.0,
    ):
        self.buffer = buffer
        self.store = store
        self.spool_dir = Path(spool_dir) if spool_dir else None
        self.retry_delays_s = list(retry_delays_s)
        self.stale_after_s = stale_after_s

    @classmethod
    def from_env(cls, buffer: Optional[ConversationBuffer], store: Any) -> "ConversationPersistenceService":
        out_dir = os.getenv("OUT_DIR", "out")
        return cls(
            buffer,
            store,
            spool_dir=os.getenv("CONVERSATION_SPOOL_DIR", os.path.join(out_dir, "conversation-spool")),
            stale_after_s=float(os.getenv("CONVERSATION_STALE_AFTER_S", "1800")),
        )

    # ---------- Redis -> store ----------
    async def persist(self, cid: str) -> bool:
        """Persist one completed conversation from Redis. True when it is (now or already) persisted."""
        if self.buffer is None:
            return False
        if self.store is None:
            log_event("conversation_persist_skipped", logging.WARNING, conversation_id=cid, reason="DATABASE_URL not set")
            return False
        token = await self.buffer.acquire_lock(cid)
        if token is None:
            log_event("conversation_persist_skipped", conversation_id=cid, reason="locked by another worker")
            return False
        try:
            meta, msgs = await self.buffer.load(cid)
            if meta is None:
                log_event("conversation_persist_skipped", logging.WARNING, conversation_id=cid, reason="not in redis")
                return False
            if meta.status == ConversationStatus.PERSISTED:
                return True
            if meta.status == ConversationStatus.ACTIVE:
                log_event("conversation_persist_skipped", conversation_id=cid, reason="still active")
                return False
            log_event("conversation_persist_started", conversation_id=cid, messages=len(msgs))
            try:
                await self.store.save(build_record(meta, msgs))
            except Exception as e:  # DB down, timeout, constraint error...
                log_event("conversation_persist_failed", logging.ERROR, conversation_id=cid, error=type(e).__name__)
                return False
            await self.buffer.mark_persisted(cid)
            log_event("conversation_persist_succeeded", conversation_id=cid, messages=len(msgs))
            log_event("conversation_redis_cleanup_completed", conversation_id=cid)
            return True
        finally:
            try:
                await self.buffer.release_lock(cid, token)
            except Exception:
                pass

    async def persist_with_retry(self, cid: str) -> bool:
        for attempt, delay in enumerate([0.0, *self.retry_delays_s], start=1):
            if delay:
                log_event("conversation_persist_retry_scheduled", conversation_id=cid, attempt=attempt, delay_s=delay)
                await asyncio.sleep(delay)
            try:
                if await self.persist(cid):
                    return True
            except Exception as e:  # Redis hiccup while loading/marking
                log_event("conversation_persist_failed", logging.ERROR, conversation_id=cid, error=type(e).__name__)
        log_event("conversation_persist_deferred", logging.WARNING, conversation_id=cid, reason="left pending for reconciler")
        return False

    # ---------- Redis unavailable: memory -> store, else disk ----------
    async def persist_direct(self, meta: ConversationMeta, msgs: List[Message]) -> str:
        """Returns "stored" (in the database), "spooled" (on disk, reconciler retries) or "lost"."""
        cid = meta.conversation_id
        if self.store is not None:
            try:
                await self.store.save(build_record(meta, msgs))
                log_event("conversation_persist_succeeded", conversation_id=cid, messages=len(msgs), path="direct")
                return "stored"
            except Exception as e:
                log_event("conversation_persist_failed", logging.ERROR, conversation_id=cid, error=type(e).__name__, path="direct")
        return "spooled" if self.spool(meta, msgs) else "lost"

    def spool(self, meta: ConversationMeta, msgs: List[Message]) -> bool:
        cid = meta.conversation_id
        if self.spool_dir is None:
            log_event("conversation_lost", logging.CRITICAL, conversation_id=cid, reason="no redis, no database, no spool dir")
            return False
        try:
            self.spool_dir.mkdir(parents=True, exist_ok=True)
            data = {"meta": {**asdict(meta), "status": meta.status.value}, "messages": [asdict(m) for m in msgs]}
            final = self.spool_dir / f"{_safe(cid)}.json"
            tmp = final.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, final)  # atomic
            log_event("conversation_spooled", logging.WARNING, conversation_id=cid, messages=len(msgs))
            return True
        except OSError as e:
            log_event("conversation_lost", logging.CRITICAL, conversation_id=cid, error=type(e).__name__)
            return False

    # ---------- reconciliation ----------
    async def reconcile_once(self) -> Dict[str, int]:
        """Finalise abandoned calls, retry pending ones, drain the disk spool. Safe to run on many workers."""
        stats = {"abandoned": 0, "persisted": 0, "pending": 0, "spool_persisted": 0}
        if self.buffer is not None:
            try:
                cutoff = now_ms() - int(self.stale_after_s * 1000)
                for cid in await self.buffer.stale_active_ids(cutoff):
                    meta, _ = await self.buffer.load(cid)
                    if meta is None or meta.status != ConversationStatus.ACTIVE:
                        continue
                    await self.buffer.complete(cid, meta.last_activity_ms or meta.started_at_ms or cutoff,
                                               end_reason="abandoned: no activity, call never finalised")
                    stats["abandoned"] += 1
                    log_event("conversation_completed", conversation_id=cid, reason="abandoned")
                for cid in await self.buffer.pending_ids():
                    if await self.persist(cid):
                        stats["persisted"] += 1
                    else:
                        stats["pending"] += 1
            except Exception as e:
                log_event("conversation_reconcile_failed", logging.ERROR, error=type(e).__name__)
        stats["spool_persisted"] = await self._drain_spool()
        return stats

    async def _drain_spool(self) -> int:
        if self.spool_dir is None or self.store is None or not self.spool_dir.exists():
            return 0
        done = 0
        for path in sorted(self.spool_dir.glob("*.json")):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                m = data["meta"]
                meta = ConversationMeta(**{**m, "status": ConversationStatus(m["status"])})
                msgs = [Message(**x) for x in data["messages"]]
                await self.store.save(build_record(meta, msgs))
                path.unlink()
                done += 1
                log_event("conversation_persist_succeeded", conversation_id=meta.conversation_id, path="spool")
            except Exception as e:
                log_event("conversation_persist_failed", logging.ERROR, file=path.name, error=type(e).__name__, path="spool")
        return done

    async def run_forever(self, interval_s: float = 60.0) -> None:
        while True:
            stats = await self.reconcile_once()
            if any(stats.values()):
                log_event("conversation_reconcile_pass", **stats)
            await asyncio.sleep(interval_s)


def _safe(cid: str) -> str:
    return "".join(c if c.isalnum() or c in "-_." else "_" for c in cid)

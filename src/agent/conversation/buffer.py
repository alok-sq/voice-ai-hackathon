"""Redis staging buffer for live conversations. All Redis-specific logic lives here.

Keys (prefix defaults to "conversation", one set per call so concurrent calls never share data):

    {prefix}:{id}:messages   HASH  message_id -> Message JSON   (HSETNX = atomic, idempotent append)
    {prefix}:{id}:meta       HASH  ConversationMeta fields      (status, times, lead, outcome, ...)
    {prefix}:{id}:lock       STRING, SET NX EX                  (one persister at a time)
    {prefix}s:active         ZSET  id -> last activity ms        (ACTIVE calls, for stale detection)
    {prefix}s:pending        ZSET  id -> ended ms                (COMPLETED_PENDING_PERSISTENCE)

Ordering: each message carries the publisher `seq` of its first event; readers sort by it.
TTL: ACTIVE and pending conversations have NO TTL, so Redis never expires an unpersisted
conversation. Abandoned calls are finalised by the reconciler instead. After a confirmed
PostgreSQL write the messages are deleted and the meta hash is kept as a short-lived
PERSISTED tombstone (CONVERSATION_PERSISTED_TTL_S, default 1 day) so late retries are no-ops.
"""
from __future__ import annotations

import logging
import os
import time
import uuid
from typing import Any, List, Optional, Tuple

from .models import ConversationMeta, ConversationStatus, Message

logger = logging.getLogger("agent.conversation.buffer")


def now_ms() -> int:
    return int(time.time() * 1000)


def _s(v: Any) -> Optional[str]:
    return v.decode() if isinstance(v, bytes) else v


class ConversationBuffer:
    def __init__(self, redis: Any, prefix: str = "conversation", persisted_ttl_s: int = 86400, lock_ttl_s: int = 120):
        self.r = redis
        self.prefix = prefix
        self.persisted_ttl_s = persisted_ttl_s
        self.lock_ttl_s = lock_ttl_s

    @classmethod
    def from_env(cls) -> Optional["ConversationBuffer"]:
        """None when REDIS_URL is not set (conversation buffering is then off)."""
        url = os.getenv("REDIS_URL")
        if not url:
            return None
        import redis.asyncio as aioredis  # imported lazily so the package loads without redis installed

        client = aioredis.from_url(url, decode_responses=True, socket_timeout=2.0, socket_connect_timeout=2.0)
        return cls(
            client,
            prefix=os.getenv("CONVERSATION_KEY_PREFIX", "conversation"),
            persisted_ttl_s=int(os.getenv("CONVERSATION_PERSISTED_TTL_S", "86400")),
        )

    # ---------- keys ----------
    def k_messages(self, cid: str) -> str:
        return f"{self.prefix}:{cid}:messages"

    def k_meta(self, cid: str) -> str:
        return f"{self.prefix}:{cid}:meta"

    def k_lock(self, cid: str) -> str:
        return f"{self.prefix}:{cid}:lock"

    @property
    def k_active(self) -> str:
        return f"{self.prefix}s:active"

    @property
    def k_pending(self) -> str:
        return f"{self.prefix}s:pending"

    # ---------- live call ----------
    async def start(self, meta: ConversationMeta) -> None:
        """Initialise the buffer. Idempotent: an existing conversation keeps its status and start time."""
        cid = meta.conversation_id
        existing = await self.r.hget(self.k_meta(cid), "status")
        if existing:
            return
        fields = meta.to_redis()
        async with self.r.pipeline(transaction=True) as p:
            p.hset(self.k_meta(cid), mapping=fields)
            p.zadd(self.k_active, {cid: meta.last_activity_ms or meta.started_at_ms or now_ms()})
            await p.execute()

    async def append(self, msg: Message) -> bool:
        """Store one final message. Returns False when this message_id is already stored (duplicate)."""
        cid = msg.conversation_id
        stored = await self.r.hsetnx(self.k_messages(cid), msg.message_id, msg.to_json())
        if stored:
            t = now_ms()
            async with self.r.pipeline(transaction=True) as p:
                p.hset(self.k_meta(cid), "last_activity_ms", t)
                p.zadd(self.k_active, {cid: t}, xx=True)  # only while still ACTIVE
                await p.execute()
        return bool(stored)

    async def update_meta(self, cid: str, **fields: Any) -> None:
        partial = ConversationMeta(conversation_id=cid)
        for k, v in fields.items():
            setattr(partial, k, v)
        data = {k: v for k, v in partial.to_redis().items() if k in fields}
        if data:
            await self.r.hset(self.k_meta(cid), mapping=data)

    async def complete(self, cid: str, ended_at_ms: int, **fields: Any) -> None:
        """ACTIVE -> COMPLETED_PENDING_PERSISTENCE. Removes any TTL so nothing expires before it is persisted."""
        await self.update_meta(cid, ended_at_ms=ended_at_ms, status=ConversationStatus.COMPLETED_PENDING_PERSISTENCE, **fields)
        async with self.r.pipeline(transaction=True) as p:
            p.persist(self.k_meta(cid))
            p.persist(self.k_messages(cid))
            p.zrem(self.k_active, cid)
            p.zadd(self.k_pending, {cid: ended_at_ms})
            await p.execute()

    # ---------- reading ----------
    async def load(self, cid: str) -> Tuple[Optional[ConversationMeta], List[Message]]:
        raw_meta = await self.r.hgetall(self.k_meta(cid))
        if not raw_meta:
            return None, []
        meta = ConversationMeta.from_redis(raw_meta)
        raw_msgs = await self.r.hvals(self.k_messages(cid))
        msgs = sorted((Message.from_json(m) for m in raw_msgs), key=lambda m: (m.sequence, m.timestamp_ms))
        return meta, msgs

    async def status(self, cid: str) -> Optional[ConversationStatus]:
        v = _s(await self.r.hget(self.k_meta(cid), "status"))
        return ConversationStatus(v) if v else None

    async def pending_ids(self, limit: int = 100) -> List[str]:
        return [_s(x) for x in await self.r.zrange(self.k_pending, 0, limit - 1)]

    async def stale_active_ids(self, idle_before_ms: int, limit: int = 100) -> List[str]:
        return [_s(x) for x in await self.r.zrangebyscore(self.k_active, "-inf", idle_before_ms, start=0, num=limit)]

    # ---------- persistence handshake ----------
    async def acquire_lock(self, cid: str) -> Optional[str]:
        token = uuid.uuid4().hex
        ok = await self.r.set(self.k_lock(cid), token, nx=True, ex=self.lock_ttl_s)
        return token if ok else None

    async def release_lock(self, cid: str, token: str) -> None:
        # Only release our own lock (it may have expired and been taken by another worker).
        if _s(await self.r.get(self.k_lock(cid))) == token:
            await self.r.delete(self.k_lock(cid))

    async def mark_persisted(self, cid: str) -> None:
        """Only called after PostgreSQL confirmed the write. Drops messages, keeps a short tombstone."""
        async with self.r.pipeline(transaction=True) as p:
            p.hset(self.k_meta(cid), "status", ConversationStatus.PERSISTED.value)
            p.delete(self.k_messages(cid))
            p.expire(self.k_meta(cid), self.persisted_ttl_s)
            p.zrem(self.k_pending, cid)
            p.zrem(self.k_active, cid)
            await p.execute()

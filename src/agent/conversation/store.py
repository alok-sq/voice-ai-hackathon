"""Permanent conversation storage. PostgreSQL-specific logic lives here only."""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional, Protocol

logger = logging.getLogger("agent.conversation.store")

_COLUMNS = [
    "conversation_id", "call_id", "lead_id", "agent_name", "language", "channel", "started_at", "ended_at",
    "duration_s", "outcome", "outcome_reason", "qualification_status", "next_action", "end_reason",
    "message_count", "transcript", "text_log", "lead", "metrics", "metadata",
]
_JSONB = {"transcript", "lead", "metrics", "metadata"}
_TIMESTAMPS = {"started_at", "ended_at"}


class ConversationStore(Protocol):
    async def save(self, record: Dict[str, Any]) -> None:
        """Insert or replace the record. Must be idempotent on conversation_id and raise on failure."""


def _upsert_sql() -> str:
    cols = ", ".join(_COLUMNS)
    vals = ", ".join(f"${i}::jsonb" if c in _JSONB else f"${i}" for i, c in enumerate(_COLUMNS, 1))
    updates = ", ".join(f"{c} = EXCLUDED.{c}" for c in _COLUMNS if c != "conversation_id")
    # A retry or a reconciled partial copy must never replace a fuller log with a shorter one.
    return (
        f"INSERT INTO conversation_logs ({cols}) VALUES ({vals}) "
        f"ON CONFLICT (conversation_id) DO UPDATE SET {updates}, updated_at = now() "
        f"WHERE conversation_logs.message_count <= EXCLUDED.message_count"
    )


class PostgresConversationStore:
    """asyncpg pool, created lazily. DATABASE_URL comes from the environment, never from code."""

    def __init__(self, dsn: str, min_size: int = 1, max_size: int = 4):
        self._dsn = dsn
        self._min, self._max = min_size, max_size
        self._pool: Any = None
        self._schema_ready = False

    @classmethod
    def from_env(cls) -> Optional["PostgresConversationStore"]:
        dsn = os.getenv("DATABASE_URL")
        return cls(dsn) if dsn else None

    async def _get_pool(self) -> Any:
        if self._pool is None:
            import asyncpg  # lazy import: the package loads without asyncpg installed

            self._pool = await asyncpg.create_pool(self._dsn, min_size=self._min, max_size=self._max, command_timeout=10)
        return self._pool

    async def ensure_schema(self) -> None:
        if self._schema_ready:
            return
        pool = await self._get_pool()
        sql = (Path(__file__).with_name("schema.sql")).read_text(encoding="utf-8")
        async with pool.acquire() as conn:
            await conn.execute(sql)
        self._schema_ready = True

    async def save(self, record: Dict[str, Any]) -> None:
        await self.ensure_schema()
        args = []
        for c in _COLUMNS:
            v = record.get(c)
            if c in _JSONB:
                v = json.dumps(v if v is not None else ({} if c != "transcript" else []), ensure_ascii=False)
            elif c in _TIMESTAMPS and isinstance(v, str):
                v = datetime.fromisoformat(v)
            args.append(v)
        pool = await self._get_pool()
        async with pool.acquire() as conn:
            await conn.execute(_upsert_sql(), *args)

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()
            self._pool = None

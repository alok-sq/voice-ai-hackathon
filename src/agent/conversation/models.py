"""Plain data types for the conversation log. No I/O."""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Dict, Optional

# The event contract says "caller"; the stored log says "customer".
SPEAKERS = {"agent": "agent", "caller": "customer"}


class ConversationStatus(str, Enum):
    ACTIVE = "ACTIVE"
    COMPLETED_PENDING_PERSISTENCE = "COMPLETED_PENDING_PERSISTENCE"
    PERSISTED = "PERSISTED"


@dataclass
class Message:
    """One final transcript line. `message_id` is the stable line id from the event contract."""

    conversation_id: str
    message_id: str  # contract line id: a1, a2 (agent), u1, u2 (caller)
    sequence: int  # publisher seq of the line's first event, so lines sort in the order they began
    timestamp_ms: int  # epoch ms of the line's first event
    speaker: str  # "agent" | "customer"
    text: str

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False, separators=(",", ":"))

    @classmethod
    def from_json(cls, raw: "str | bytes") -> "Message":
        data = json.loads(raw)
        return cls(**{k: data[k] for k in ("conversation_id", "message_id", "sequence", "timestamp_ms", "speaker", "text")})


@dataclass
class ConversationMeta:
    """Everything about a call except its messages. Stored as a Redis hash, field by field."""

    conversation_id: str
    status: ConversationStatus = ConversationStatus.ACTIVE
    started_at_ms: int = 0
    ended_at_ms: Optional[int] = None
    last_activity_ms: int = 0
    language: Optional[str] = None
    channel: Optional[str] = None  # "phone" | "browser"
    agent_name: Optional[str] = None
    call_id: Optional[str] = None
    lead: Dict[str, Any] = field(default_factory=dict)
    outcome: Optional[str] = None
    outcome_reason: Optional[str] = None
    callback_at: Optional[str] = None
    end_reason: Optional[str] = None
    handoff_requested: bool = False
    metrics: Dict[str, Any] = field(default_factory=dict)

    _JSON_FIELDS = ("lead", "metrics")

    def to_redis(self) -> Dict[str, str]:
        out: Dict[str, str] = {}
        for k, v in asdict(self).items():
            if v is None:
                continue
            if k == "status":
                out[k] = self.status.value
            elif k in self._JSON_FIELDS:
                out[k] = json.dumps(v, ensure_ascii=False)
            elif isinstance(v, bool):
                out[k] = "1" if v else "0"
            else:
                out[k] = str(v)
        return out

    @classmethod
    def from_redis(cls, raw: Dict[Any, Any]) -> "ConversationMeta":
        d = {(k.decode() if isinstance(k, bytes) else k): (v.decode() if isinstance(v, bytes) else v) for k, v in raw.items()}
        meta = cls(conversation_id=d["conversation_id"])
        for k, v in d.items():
            if k == "conversation_id" or not hasattr(meta, k):
                continue
            if k == "status":
                meta.status = ConversationStatus(v)
            elif k in cls._JSON_FIELDS:
                setattr(meta, k, json.loads(v) if v else {})
            elif k in ("started_at_ms", "ended_at_ms", "last_activity_ms"):
                setattr(meta, k, int(v))
            elif k == "handoff_requested":
                meta.handoff_requested = v == "1"
            else:
                setattr(meta, k, v)
        return meta

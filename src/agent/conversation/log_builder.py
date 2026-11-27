"""Builds the permanent conversation record and its human-readable text log. Pure functions, no I/O.

Qualification status and next action are derived only from the agent's outcome and the
captured lead (the same rules the console uses). Nothing is invented: missing values are omitted.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from .models import ConversationMeta, Message

SPEAKER_LABEL = {"agent": "AI Agent", "customer": "Customer"}

OUTCOME_LABEL = {
    "qualified": "Qualified",
    "not_qualified": "Not qualified",
    "callback": "Callback",
    "wrong_number": "Wrong number",
    "do_not_call": "Do not call",
}

# Lead fields in the order the call collects them, with readable labels.
LEAD_LABELS: List[Tuple[str, str]] = [
    ("identity_confirmed", "Identity confirmed"),
    ("solar_interest", "Interested in solar"),
    ("property_type", "Property type"),
    ("roof_ownership", "Roof ownership"),
    ("roof_access", "Roof access"),
    ("shadow_free_area", "Shadow-free area (sq ft)"),
    ("monthly_bill", "Monthly bill (Rs)"),
    ("discom", "DISCOM"),
    ("city_or_pincode", "City or pincode"),
    ("timeline", "Timeline"),
    ("loan_interest", "Loan interest"),
    ("subsidy_interest", "PM Surya Ghar subsidy interest"),
    ("meeting_slot", "Meeting slot"),
]


def qualification_status(outcome: Optional[str]) -> str:
    if outcome == "qualified":
        return "qualified"
    if outcome in ("not_qualified", "do_not_call"):
        return "not_qualified"
    return "needs_review"  # callback, wrong_number, or no outcome


def _slot_label(lead: Dict[str, Any]) -> Optional[str]:
    slot = lead.get("meeting_slot")
    if isinstance(slot, dict):
        return slot.get("label") or slot.get("iso")
    return str(slot) if slot else None


def next_action(outcome: Optional[str], lead: Dict[str, Any], callback_at: Optional[str] = None) -> str:
    slot = _slot_label(lead)
    if outcome == "qualified":
        return f"Schedule site survey ({slot})" if slot else "Book a site survey"
    if outcome == "callback":
        when = callback_at or slot
        return f"Schedule a callback ({when})" if when else "Schedule a callback"
    if outcome == "wrong_number":
        return "Verify the lead's number"
    if outcome == "not_qualified":
        return "Close the lead"
    if outcome == "do_not_call":
        return "Do not call this number again"
    return "Review the call manually"


def _fmt_time(ms: Optional[int]) -> str:
    if not ms:
        return "unknown"
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def _iso(ms: Optional[int]) -> Optional[str]:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat() if ms else None


def _fmt_duration(seconds: Optional[float]) -> str:
    if seconds is None:
        return "unknown"
    s = int(round(seconds))
    return f"{s // 60}m {s % 60:02d}s"


def _offset(ms: int, start_ms: int) -> str:
    s = max(0, (ms - start_ms) // 1000) if start_ms else 0
    return f"{s // 60:02d}:{s % 60:02d}"


def _fmt_value(v: Any) -> str:
    if isinstance(v, bool):
        return "Yes" if v else "No"
    if isinstance(v, dict):
        return v.get("label") or ", ".join(f"{k}: {x}" for k, x in v.items())
    return str(v).replace("_", " ")


def ordered(messages: List[Message]) -> List[Message]:
    return sorted(messages, key=lambda m: (m.sequence, m.timestamp_ms, m.message_id))


def duration_s(meta: ConversationMeta) -> Optional[float]:
    if meta.started_at_ms and meta.ended_at_ms:
        return round(max(0, meta.ended_at_ms - meta.started_at_ms) / 1000, 1)
    return None


def build_text_log(meta: ConversationMeta, messages: List[Message]) -> str:
    lines = [
        f"Conversation ID: {meta.conversation_id}",
        f"Started: {_fmt_time(meta.started_at_ms)}",
        f"Ended: {_fmt_time(meta.ended_at_ms)}",
        f"Duration: {_fmt_duration(duration_s(meta))}",
    ]
    if meta.channel:
        lines.append(f"Channel: {meta.channel}")
    if meta.language:
        lines.append(f"Language: {meta.language}")
    lines.append("")

    msgs = ordered(messages)
    if not msgs:
        lines += ["(No conversation was recorded.)", ""]
    for m in msgs:
        lines += [f"[{_offset(m.timestamp_ms, meta.started_at_ms)}] {SPEAKER_LABEL.get(m.speaker, m.speaker)}:", m.text, ""]

    captured = [(label, meta.lead[k]) for k, label in LEAD_LABELS if meta.lead.get(k) is not None]
    if captured:
        lines.append("Captured details:")
        lines += [f"- {label}: {_fmt_value(v)}" for label, v in captured]
        lines.append("")

    lines += ["Conversation Outcome:", OUTCOME_LABEL.get(meta.outcome or "", "Not set")]
    if meta.outcome_reason:
        lines.append(f"Reason: {meta.outcome_reason}")
    if meta.handoff_requested:
        lines.append("Handoff to a person was requested.")
    lines += ["", "Next Action:", next_action(meta.outcome, meta.lead, meta.callback_at)]
    if meta.end_reason:
        lines += ["", f"Call ended: {meta.end_reason}"]
    return "\n".join(lines).rstrip() + "\n"


def build_record(meta: ConversationMeta, messages: List[Message]) -> Dict[str, Any]:
    """The row written to PostgreSQL. Structured transcript + readable text log."""
    msgs = ordered(messages)
    return {
        "conversation_id": meta.conversation_id,
        "call_id": meta.call_id or meta.conversation_id,
        "lead_id": None,  # not in the event contract yet
        "agent_name": meta.agent_name,
        "language": meta.language,
        "channel": meta.channel,
        "started_at": _iso(meta.started_at_ms),
        "ended_at": _iso(meta.ended_at_ms),
        "duration_s": duration_s(meta),
        "outcome": meta.outcome,
        "outcome_reason": meta.outcome_reason,
        "qualification_status": qualification_status(meta.outcome),
        "next_action": next_action(meta.outcome, meta.lead, meta.callback_at),
        "end_reason": meta.end_reason,
        "message_count": len(msgs),
        "transcript": [
            {"sequence": m.sequence, "message_id": m.message_id, "timestamp": _iso(m.timestamp_ms), "speaker": m.speaker, "text": m.text}
            for m in msgs
        ],
        "text_log": build_text_log(meta, msgs),
        "lead": meta.lead,
        "metrics": meta.metrics,
        "metadata": {"handoff_requested": meta.handoff_requested, "callback_at": meta.callback_at},
    }

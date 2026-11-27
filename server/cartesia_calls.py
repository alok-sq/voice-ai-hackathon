"""Lead records for Demo v3.

Cartesia holds the conversation. This store saves what the caller says, and any
update_lead / end_call / handoff tool the agent calls, into the same lead record
the other pipelines write.
"""
from __future__ import annotations

import json
import os
import re
import sys
import threading
from pathlib import Path
from typing import Any

_SRC = Path(__file__).resolve().parents[1] / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from agent import normalise as nz  # noqa: E402
from agent.events import EventPublisher  # noqa: E402
from agent.tools import CallSession  # noqa: E402

CALL_ID_RE = re.compile(r"^cart-[0-9a-f]{8}$")
# The caller's reply is saved only for the field the agent just asked about.
# More specific questions are listed first.
_QUESTION_FIELDS = (
    ("roof_ownership", re.compile(r"chhat|छत|\broof\b|kiray|किराय|common roof|own the roof|aapki apni", re.IGNORECASE)),
    ("roof_access", re.compile(r"access|pahunch|पहुँच|चढ़|reach the roof", re.IGNORECASE)),
    ("shadow_free_area", re.compile(r"square|sq\.?\s*ft|वर्ग|shadow|dhup|धूप|kitni (badi|bari)", re.IGNORECASE)),
    ("monthly_bill", re.compile(r"\bbill\b|बिल|mahine ka kitna|electricity bill", re.IGNORECASE)),
    ("discom", re.compile(r"discom|company se|कंपनी|electricity company|bijli kis|बिजली किस", re.IGNORECASE)),
    ("city_or_pincode", re.compile(r"\bcity\b|शहर|pincode|पिनकोड|kahan reht|कहाँ रहत", re.IGNORECASE)),
    ("timeline", re.compile(r"kab tak|कब तक|timeline|by when|install karna chah", re.IGNORECASE)),
    ("loan_interest", re.compile(r"\bloan\b|लोन", re.IGNORECASE)),
    ("subsidy_interest", re.compile(r"subsid|सब्सिडी|surya ghar|सूर्य घर", re.IGNORECASE)),
    ("meeting_slot", re.compile(
        r"site visit|\bvisit\b|मुलाकात|which day|kaun sa din|कौन सा दिन|कौनसा दिन|"
        r"\btime\b|samay|समय|subah|dopahar|shaam|सुबह|शाम|दोपहर|बजे",
        re.IGNORECASE,
    )),
    ("solar_interest", re.compile(r"interest|lagwan|लगवा|दिलचस्पी", re.IGNORECASE)),
    ("property_type", re.compile(r"independent|society|flat|property|प्रॉपर्टी|किस तरह|apartment|ghar hai|घर है", re.IGNORECASE)),
    ("identity_confirmed", re.compile(r"enquir|pooch|पूछ|right person|aap hi|आप ही|same person", re.IGNORECASE)),
)
# "नहीं, सोच रहा हूँ" or "नहीं पता" is not a refusal of solar.
_CONSIDERING = re.compile(
    r"सोच रहा|सोच रही|soch raha|नहीं पता|nahi pata|pata nahi|पता नहीं|not sure|malum nahi|मालूम नहीं",
    re.IGNORECASE,
)
_OWNED_Q = re.compile(r"apni|own|aapki|आपकी|अपनी", re.IGNORECASE)
_RENTED_Q = re.compile(r"kiray|rent|किराय", re.IGNORECASE)
# A slot is a day or a time the caller chose. "कब आएगा?" is a question, not a slot.
_SLOT_WHEN = re.compile(
    r"parson|parso|\baaj\b|\bkal\b|today|tomorrow|"
    r"monday|tuesday|wednesday|thursday|friday|saturday|sunday|"
    r"subah|shaam|sham|dopahar|morning|evening|afternoon|baje|"
    r"परसों|परसो|आज|कल|सुबह|शाम|दोपहर|बजे|"
    r"सोम|मंगल|बुध|गुरु|शुक्र|शनि|रवि",
    re.IGNORECASE,
)
_KNOWN_FIELDS = {
    "identity_confirmed", "solar_interest", "property_type", "roof_ownership", "roof_access",
    "shadow_free_area", "monthly_bill", "discom", "city_or_pincode", "timeline",
    "loan_interest", "subsidy_interest", "meeting_slot",
}


def _arg(params: Any, *keys: str) -> str:
    if not isinstance(params, dict):
        return ""
    for key in keys:
        value = params.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return ""


class CartesiaCalls:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._calls: dict[str, dict[str, Any]] = {}

    def open(self, language: str) -> tuple[str, list[dict[str, Any]]]:
        import secrets

        call_id = f"cart-{secrets.token_hex(4)}"
        publisher = EventPublisher(lambda _payload, _topic: None)
        session = CallSession(call_id, language, publisher, out_dir=os.getenv("OUT_DIR", "out"))
        publisher.emit("state", state=session.flow.current.value)
        with self._lock:
            self._calls[call_id] = {
                "session": session, "publisher": publisher, "cursor": 0, "tools": set(), "question": "",
            }
        return call_id, self._drain(call_id)

    def turn(self, call_id: str, role: str, text: str, tool_calls: list[Any] | None = None) -> dict[str, Any]:
        record = self._get(call_id)
        session: CallSession = record["session"]
        who = "caller" if role in ("user", "caller") else "agent"
        spoken = (text or "").strip()
        if spoken:
            record["publisher"].remember_line(f"{'u' if who == 'caller' else 'a'}{len(record['publisher'].transcript) + 1}", who, spoken, True)
        notes = [self._apply_tool(record, tool) for tool in tool_calls or []]
        saved_by_tool = any(note.startswith("Saved ") for note in notes)
        if who == "agent" and spoken:
            record["question"] = spoken
        elif who == "caller" and spoken and session.result is None and not saved_by_tool:
            self._save_for_question(session, record.get("question") or "", spoken)
        return {"notes": [note for note in notes if note], "events": self._drain(call_id)}

    def tool(self, call_id: str, name: str, arguments: Any, tool_id: str = "") -> dict[str, Any]:
        record = self._get(call_id)
        note = self._apply_tool(record, {"name": name, "arguments": arguments, "id": tool_id})
        return {"result": note, "events": self._drain(call_id)}

    def finish(self, call_id: str, reason: str = "") -> dict[str, Any]:
        record = self._get(call_id)
        session: CallSession = record["session"]
        if session.result is None:
            session.end_call(session.default_outcome(), reason or "call ended")
        if isinstance(session.result, dict):
            session.result["transcript"] = record["publisher"].transcript
            session.result["pipeline"] = "cartesia"
            session._write(session.result)
        return {"outcome": (session.result or {}).get("outcome"), "events": self._drain(call_id)}

    def _get(self, call_id: str) -> dict[str, Any]:
        if not CALL_ID_RE.match(call_id or ""):
            raise KeyError(call_id)
        with self._lock:
            record = self._calls.get(call_id)
        if record is None:
            raise KeyError(call_id)
        return record

    def _drain(self, call_id: str) -> list[dict[str, Any]]:
        record = self._calls[call_id]
        sent = record["publisher"].sent
        events = sent[record["cursor"] :]
        record["cursor"] = len(sent)
        return events

    def _save_for_question(self, session: CallSession, question: str, answer: str) -> None:
        field = _field_for_question(question)
        if not field:
            return
        value = _value_for_field(field, question, answer)
        if not value:
            return
        if field == "meeting_slot":
            self._save_slot(session, value)
            return
        if getattr(session.lead, field) is not None:
            return
        session.update_lead(field, value)

    def _save_slot(self, session: CallSession, piece: str) -> None:
        """A day and a time often arrive in two answers. Keep both."""
        current = session.lead.meeting_slot
        label = current.get("label", "") if isinstance(current, dict) else ""
        if piece.lower() in label.lower():
            return
        session.update_lead("meeting_slot", f"{label}, {piece}".strip(", ") if label else piece)

    def _apply_tool(self, record: dict[str, Any], tool: Any) -> str:
        if not isinstance(tool, dict):
            return ""
        name = str(tool.get("name") or tool.get("tool_name") or "").strip()
        params = tool.get("arguments") if "arguments" in tool else tool.get("parameters")
        tool_id = str(tool.get("id") or tool.get("tool_call_id") or "")
        if tool_id:
            if tool_id in record["tools"]:
                return ""
            record["tools"].add(tool_id)
        session: CallSession = record["session"]
        key = name.lower().replace("-", "_")
        if key in ("update_lead", "save_lead", "save"):
            return _save_explicit(session, params)
        if key in _KNOWN_FIELDS:
            parsed = _params(params)
            value = _arg(parsed, "value", "answer")
            return session.update_lead(key, value) if value else "No value was provided."
        if key in ("end_call", "finish_call", "end"):
            return session.end_call(_arg(params, "outcome") or session.default_outcome(), _arg(params, "reason"))
        if key in ("handoff_to_human", "handoff"):
            reason = _arg(params, "reason") or "caller asked for a person"
            session.handoff(reason)
            if session.result is None:
                return session.end_call("callback", f"handoff: {reason}")
            return "A person will take over."
        if not name:
            return ""
        return f"Unknown tool '{name}'. Use update_lead, end_call, or handoff_to_human."


def _field_for_question(question: str) -> str:
    """Use the last sentence, so an explanation that mentions the bill does not hide the real question."""
    parts = [part.strip() for part in re.split(r"[.?!।]\s*", question or "") if part.strip()]
    for part in reversed(parts or [""]):
        for field, pattern in _QUESTION_FIELDS:
            if pattern.search(part):
                return field
    return ""


def _value_for_field(field: str, question: str, answer: str) -> str:
    """The caller's words, only when they actually answer this field."""
    if field in ("identity_confirmed", "solar_interest", "roof_access", "loan_interest", "subsidy_interest"):
        parsed = nz.parse_yes_no(answer)
        if parsed is True:
            return "haan"
        if parsed is False and not (field == "solar_interest" and _CONSIDERING.search(answer or "")):
            return "nahi"
        return ""
    if field == "property_type":
        return answer if nz.parse_property_type(answer) else ""
    if field == "roof_ownership":
        if nz.parse_roof_ownership(answer):
            return answer
        yn = nz.parse_yes_no(answer)
        if yn is True and _OWNED_Q.search(question):
            return "owned"
        if yn is False and _OWNED_Q.search(question):
            return "rented"
        if yn is True and _RENTED_Q.search(question):
            return "rented"
        if yn is False and _RENTED_Q.search(question):
            return "owned"
        return ""
    if field in ("monthly_bill", "shadow_free_area"):
        return answer if nz.parse_amount(answer) else ""
    if field == "meeting_slot":
        return answer.strip() if _SLOT_WHEN.search(answer or "") else ""
    if field == "discom":
        return answer if nz.parse_discom(answer) or (len(answer.strip()) >= 2 and nz.parse_yes_no(answer) is None) else ""
    if nz.parse_yes_no(answer) is not None and not re.search(r"\d|baje|कल|शाम|सुबह", answer or "", re.IGNORECASE):
        return ""
    return answer.strip()


def _params(raw: Any) -> dict[str, Any]:
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except ValueError:
            return {"value": raw}
        return parsed if isinstance(parsed, dict) else {"value": raw}
    if isinstance(raw, dict):
        return raw
    if raw is None:
        return {}
    return {"value": raw}


def _save_explicit(session: CallSession, raw: Any) -> str:
    """Save only keys the tool named. Never guess a field from a nearby word."""
    params = _params(raw)
    named = _arg(params, "field")
    if named in _KNOWN_FIELDS:
        value = _arg(params, "value", "answer")
        return session.update_lead(named, value) if value else "No value was provided."
    notes = []
    for field, value in params.items():
        if field in _KNOWN_FIELDS and value is not None and str(value).strip():
            notes.append(session.update_lead(field, str(value)))
    if notes:
        return " ".join(notes)
    return "No lead field was named. Nothing was saved."


CALLS = CartesiaCalls()

"""Call session state and the logic behind the LLM tools. No LiveKit imports, so it is unit testable."""
from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from .events import EventPublisher
from .flow import CallFlow, State
from .models import Lead, Outcome, PropertyType, RoofOwnership
from . import normalise as nz

BOOL_FIELDS = {"identity_confirmed", "solar_interest", "roof_access", "loan_interest", "subsidy_interest"}
FIELDS = BOOL_FIELDS | {
    "property_type", "roof_ownership", "shadow_free_area", "monthly_bill", "discom", "city_or_pincode",
    "timeline", "meeting_slot",
}
REASK = "Could not understand that value. Ask the caller again in a simpler way. Nothing was saved."


def _parse_bool(raw: str) -> Optional[bool]:
    t = raw.strip().lower()
    if t == "true":
        return True
    if t == "false":
        return False
    return nz.parse_yes_no(raw)


class CallSession:
    def __init__(self, call_id: str, language: str, publisher: EventPublisher, out_dir: str = "out"):
        self.call_id = call_id
        self.language = language
        self.pub = publisher
        self.out_dir = Path(out_dir)
        self.lead = Lead()
        self.flow = CallFlow(self.lead)
        self.result: Optional[Dict[str, Any]] = None
        self.handoff_requested = False
        self.started_at = time.time()

    # ---- lead ----

    def _parse(self, field: str, raw: str) -> Any:
        raw = raw.strip()
        if field in BOOL_FIELDS:
            return _parse_bool(raw)
        if field == "property_type":
            return nz.parse_property_type(raw)
        if field == "roof_ownership":
            return nz.parse_roof_ownership(raw)
        if field in ("monthly_bill", "shadow_free_area"):
            n = nz.parse_amount(raw)
            return n if n and n > 0 else None
        if field == "discom":
            return nz.parse_discom(raw) or (raw if len(raw) >= 2 and not re.fullmatch(r"[\d\W]+", raw) else None)
        if field == "meeting_slot":
            return {"label": raw} if raw else None
        return raw if raw else None  # city_or_pincode, timeline

    def update_lead(self, field: str, raw_value: str) -> str:
        if self.result is not None:
            return "The call is already finished. Say goodbye."
        if field not in FIELDS:
            return f"Unknown field '{field}'. Valid fields: {', '.join(sorted(FIELDS))}."
        value = self._parse(field, raw_value or "")
        if value is None:
            return REASK
        setattr(self.lead, field, value)
        json_value = value.value if hasattr(value, "value") else value
        self.pub.emit("lead", field=field, value=json_value)
        before = self.flow.current
        after = self.flow.advance()
        if after != before:
            self.pub.emit("state", state=after.value)
        return f"Saved {field}. Now at step {after.value}. Continue with that step's goal."

    # ---- ending ----

    def end_call(self, outcome: str, reason: str = "", callback_at: Optional[str] = None) -> str:
        try:
            out = Outcome(outcome)
        except ValueError:
            return f"Invalid outcome '{outcome}'. Use one of: {', '.join(o.value for o in Outcome)}."
        record = self.flow.finish(out)
        record.update(
            call_id=self.call_id,
            language=self.language,
            reason=reason or None,
            callback_at=callback_at,
            duration_s=round(time.time() - self.started_at, 1),
        )
        self.result = record
        self._write(record)
        fields: Dict[str, Any] = {"outcome": out.value}
        if reason:
            fields["reason"] = reason
        if callback_at:
            fields["callbackAt"] = callback_at
        self.pub.emit("outcome", **fields)
        self.pub.emit("state", state=State.DONE.value)
        return "Call outcome recorded. Say a short goodbye now."

    def handoff(self, reason: str) -> str:
        self.handoff_requested = True
        self.pub.emit("handoff", reason=reason or "caller asked for a person")
        return "A person will take over. Tell the caller politely that a colleague will call them back shortly."

    def attach_metrics(self, summary: Dict[str, Any]) -> None:
        if self.result is not None:
            self.result["metrics"] = summary
            self._write(self.result)

    def _write(self, record: Dict[str, Any]) -> None:
        try:
            self.out_dir.mkdir(parents=True, exist_ok=True)
            (self.out_dir / f"{self.call_id}.json").write_text(
                json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        except OSError:
            pass

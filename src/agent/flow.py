"""Deterministic call flow. The LLM never decides which step comes next."""
from __future__ import annotations

from enum import Enum
from typing import Any, Dict, List, Optional, Set

from .models import Lead, Outcome


class State(str, Enum):
    IDENTITY = "IDENTITY"
    INTEREST = "INTEREST"
    PROPERTY = "PROPERTY"
    BILL = "BILL"
    LOCATION_TIMELINE = "LOCATION_TIMELINE"
    FINANCE = "FINANCE"
    MEETING_PITCH = "MEETING_PITCH"
    WRAP_UP = "WRAP_UP"
    DONE = "DONE"


ORDER: List[State] = list(State)

# State -> lead fields that must be filled before the flow moves on.
STATE_FIELDS: Dict[State, List[str]] = {
    State.IDENTITY: ["identity_confirmed"],
    State.INTEREST: ["solar_interest"],
    State.PROPERTY: ["property_type", "roof_ownership", "roof_access", "shadow_free_area"],
    State.BILL: ["monthly_bill", "discom"],
    State.LOCATION_TIMELINE: ["city_or_pincode", "timeline"],
    State.FINANCE: ["loan_interest", "subsidy_interest"],
    State.MEETING_PITCH: ["meeting_slot"],
    State.WRAP_UP: [],
    State.DONE: [],
}


class CallFlow:
    def __init__(self, lead: Lead):
        self.lead = lead
        self.current: State = State.IDENTITY
        self.outcome: Outcome | None = None
        self._silence = 0
        # Asked once with no usable answer → recap at wrap-up. Missed again → drop.
        self.deferred: List[str] = []
        self.released: Set[str] = set()
        self.current = self.next_state()

    def _ignored(self, field: str) -> bool:
        return field in self.deferred or field in self.released

    def _complete(self, state: State) -> bool:
        return all(getattr(self.lead, f) is not None or self._ignored(f) for f in STATE_FIELDS[state])

    def recap_fields(self) -> List[str]:
        """Deferred fields still empty, in original ask order."""
        return [f for f in self.deferred if getattr(self.lead, f) is None and f not in self.released]

    def pending_field(self) -> Optional[str]:
        if self.current == State.WRAP_UP:
            recap = self.recap_fields()
            return recap[0] if recap else None
        for field in STATE_FIELDS.get(self.current, []):
            if getattr(self.lead, field) is None and not self._ignored(field):
                return field
        return None

    def fields_open_for_ingest(self) -> List[str]:
        if self.current == State.WRAP_UP:
            return self.recap_fields()
        return [
            f
            for f in STATE_FIELDS.get(self.current, [])
            if getattr(self.lead, f) is None and not self._ignored(f)
        ]

    def mark_filled(self, field: str) -> None:
        if field in self.deferred:
            self.deferred.remove(field)
        self.released.discard(field)

    def defer(self, field: str) -> None:
        """Sideline until wrap-up. Call once per unanswered question."""
        if field not in self.deferred and field not in self.released:
            self.deferred.append(field)
        self.advance()

    def release(self, field: str) -> None:
        """Second miss: leave the field blank for good."""
        if field in self.deferred:
            self.deferred.remove(field)
        self.released.add(field)
        self.advance()

    def next_state(self) -> State:
        """First state (from the current one onward) whose fields are not all filled or sidelined."""
        if self.current == State.DONE:
            return State.DONE
        for state in ORDER[ORDER.index(self.current) :]:
            if state == State.DONE:
                return state
            if state == State.WRAP_UP:
                return state
            if not self._complete(state):
                return state
        return State.DONE

    def advance(self) -> State:
        self.current = self.next_state()
        return self.current

    def finish(self, outcome: Outcome) -> Dict[str, Any]:
        """The outcome overrides whatever was captured so far (e.g. do-not-call said late)."""
        self.outcome = Outcome(outcome)
        self.current = State.DONE
        return self.lead.to_record(self.outcome)

    def silence_strike(self) -> bool:
        """Count a silence. True once the second consecutive one is reached."""
        self._silence += 1
        return self._silence >= 2

    @property
    def silence_count(self) -> int:
        return self._silence

    def reset_silence(self) -> None:
        self._silence = 0

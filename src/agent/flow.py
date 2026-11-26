"""Deterministic call flow. The LLM never decides which step comes next."""
from __future__ import annotations

from enum import Enum
from typing import Any, Dict, List

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
        self.current = self.next_state()

    def _complete(self, state: State) -> bool:
        return all(getattr(self.lead, f) is not None for f in STATE_FIELDS[state])

    def next_state(self) -> State:
        """First state (from the current one onward) whose fields are not all filled."""
        if self.current == State.DONE:
            return State.DONE
        for state in ORDER[ORDER.index(self.current) :]:
            if state in (State.WRAP_UP, State.DONE):
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

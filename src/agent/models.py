"""Lead record, outcomes and property types. Pure, no network."""
from __future__ import annotations

from dataclasses import dataclass, fields
from enum import Enum
from typing import Any, Dict, List, Optional


class Outcome(str, Enum):
    qualified = "qualified"
    not_qualified = "not_qualified"
    callback = "callback"
    wrong_number = "wrong_number"
    do_not_call = "do_not_call"


class PropertyType(str, Enum):
    independent_house = "independent_house"
    housing_society = "housing_society"
    commercial = "commercial"


class RoofOwnership(str, Enum):
    owned = "owned"
    rented = "rented"
    shared = "shared"


# Required before a lead can be called `qualified`.
REQUIRED_FOR_QUALIFIED = [
    "identity_confirmed",
    "solar_interest",
    "property_type",
    "monthly_bill",
    "discom",
    "city_or_pincode",
]


@dataclass
class Lead:
    identity_confirmed: Optional[bool] = None
    solar_interest: Optional[bool] = None
    property_type: Optional[PropertyType] = None
    roof_ownership: Optional[RoofOwnership] = None
    roof_access: Optional[bool] = None
    shadow_free_area: Optional[float] = None  # sq ft
    monthly_bill: Optional[int] = None  # rupees
    discom: Optional[str] = None
    city_or_pincode: Optional[str] = None
    timeline: Optional[str] = None
    loan_interest: Optional[bool] = None
    subsidy_interest: Optional[bool] = None
    meeting_slot: Optional[Dict[str, Any]] = None  # {label, iso?, location?}

    def missing_required(self) -> List[str]:
        return [f for f in REQUIRED_FOR_QUALIFIED if getattr(self, f) is None]

    def filled(self) -> Dict[str, Any]:
        return {f.name: getattr(self, f.name) for f in fields(self) if getattr(self, f.name) is not None}

    def to_json(self) -> Dict[str, Any]:
        """Filled fields only, enums as plain strings. Matches the console contract."""
        return {k: (v.value if isinstance(v, Enum) else v) for k, v in self.filled().items()}

    def to_record(self, outcome: Outcome) -> Dict[str, Any]:
        record: Dict[str, Any] = {f.name: None for f in fields(self)}
        record.update(self.to_json())
        record["outcome"] = Outcome(outcome).value
        return record

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from agent import guardrails as g  # noqa: E402
from agent import normalise as nz  # noqa: E402
from agent.events import EventPublisher  # noqa: E402
from agent.flow import CallFlow, State  # noqa: E402
from agent.metrics import CallMetrics  # noqa: E402
from agent.models import Lead, Outcome, PropertyType, RoofOwnership  # noqa: E402
from agent.pipeline import parse_dispatch_metadata  # noqa: E402
from agent.prompts import build_system_prompt, next_spoken_question  # noqa: E402
from agent.tools import CallSession  # noqa: E402


# ---- models ----
def test_missing_required_lists_unfilled_fields():
    assert "monthly_bill" in Lead().missing_required()
    assert Lead(monthly_bill=3000).missing_required() != Lead().missing_required()


def test_to_record_includes_outcome_value():
    assert Lead().to_record(Outcome.callback)["outcome"] == "callback"


def test_outcome_rejects_unknown_value():
    with pytest.raises(ValueError):
        Outcome("maybe")


# ---- flow ----
def test_skips_filled_states():
    flow = CallFlow(Lead(identity_confirmed=True, solar_interest=True, property_type=PropertyType.independent_house,
                         roof_ownership="owned", roof_access=True, shadow_free_area=300,
                         monthly_bill=3000, discom="MSEDCL"))
    assert flow.current == State.LOCATION_TIMELINE


def test_two_silences_triggers_callback():
    flow = CallFlow(Lead())
    assert flow.silence_strike() is False
    assert flow.silence_strike() is True
    flow.reset_silence()
    assert flow.silence_strike() is False


def test_finish_do_not_call_overrides_captured_fields():
    lead = Lead(identity_confirmed=True, solar_interest=True, monthly_bill=3000, discom="MSEDCL", city_or_pincode="Pune",
                property_type=PropertyType.independent_house)
    assert CallFlow(lead).finish(Outcome.do_not_call)["outcome"] == "do_not_call"


def test_next_state_after_done_stays_done():
    flow = CallFlow(Lead())
    flow.finish(Outcome.callback)
    assert flow.next_state() == State.DONE


# ---- normalisers (real phrases from the plan) ----
@pytest.mark.parametrize("text,expected", [
    ("bill around 3 hazaar aata hai", 3000),
    ("paanch sau", 500),
    ("dhai hazaar", 2500),
    ("3,500 rupaye", 3500),
    ("teen sau pachas", 350),
    ("तीन हज़ार", 3000),
    ("pata nahi", None),
])
def test_parse_amount(text, expected):
    assert nz.parse_amount(text) == expected


@pytest.mark.parametrize("text,expected", [
    ("haan ji", True), ("nahi chahiye", False), ("hmm shayad", None), ("हाँ", True), ("नहीं", False),
])
def test_parse_yes_no(text, expected):
    assert nz.parse_yes_no(text) is expected


def test_parse_property_type():
    assert nz.parse_property_type("society mein flat hai") == PropertyType.housing_society
    assert nz.parse_property_type("mera apna ghar hai") == PropertyType.independent_house
    assert nz.parse_property_type("dukaan hai") == PropertyType.commercial


@pytest.mark.parametrize("text,expected", [
    ("roof is common in society", RoofOwnership.shared),
    ("chhat common hai", RoofOwnership.shared),
    ("कॉमन है", RoofOwnership.shared),
    ("society ki chhat hai", RoofOwnership.shared),
    ("meri hai", RoofOwnership.owned),
    ("common nahi, meri hai", RoofOwnership.owned),
    ("society mein flat hai", None),
])
def test_parse_roof_ownership(text, expected):
    assert nz.parse_roof_ownership(text) is expected


def test_parse_discom():
    assert nz.parse_discom("Torrent Power") == "Torrent Power"
    assert nz.parse_discom("pata nahi") is None


# ---- guardrails ----
@pytest.mark.parametrize("text", ["mat call karo", "do not call me", "band karo", "कॉल मत करो"])
def test_stop_request_detected(text):
    assert g.is_stop_request(text)


def test_normal_no_is_not_stop():
    assert not g.is_stop_request("abhi nahi")


@pytest.mark.parametrize("text", [
    "aapko 78,000 ki subsidy milegi", "आपको 78 हज़ार की सब्सिडी मिलेगी", "aap 2000 rupaye bachayenge, bachat hogi",
])
def test_forbidden_claim_blocks_figures(text):
    assert g.contains_forbidden_claim(text)


@pytest.mark.parametrize("text", [
    "PM Surya Ghar ke baare mein interest hai?", "आपका मासिक बिल कितना आता है?", "सोलर पैनल के बारे में पूछताछ की थी?",
])
def test_forbidden_claim_allows_generic_mention(text):
    assert not g.contains_forbidden_claim(text)


def test_greeting_contains_recording_notice():
    assert "रिकॉर्ड" in g.greeting("hi")
    assert "recorded" in g.greeting("en")


# ---- tools / session ----
def make_session(tmp_path):
    pub = EventPublisher(lambda payload, topic: None)
    return CallSession("call-test", "hi", pub, out_dir=str(tmp_path)), pub


def test_ingest_utterance_fills_current_step_without_tool_call(tmp_path):
    cs, _ = make_session(tmp_path)
    assert cs.flow.current.name == "IDENTITY"
    assert cs.ingest_utterance("haan ji") == ["identity_confirmed"]
    assert cs.lead.identity_confirmed is True


def test_ingest_common_society_roof_saves_shared(tmp_path):
    cs, _ = make_session(tmp_path)
    cs.update_lead("identity_confirmed", "haan")
    cs.update_lead("solar_interest", "haan")
    cs.update_lead("property_type", "society")
    assert cs.ingest_utterance("roof is common in society") == ["roof_ownership"]
    assert cs.lead.roof_ownership == RoofOwnership.shared
    q = next_spoken_question(cs.flow, "hi")
    assert q and "कॉमन" not in q and "छत आपकी" not in q


def test_update_lead_normalises_bill(tmp_path):
    cs, _ = make_session(tmp_path)
    cs.update_lead("monthly_bill", "3 hazaar")
    assert cs.lead.monthly_bill == 3000


def test_update_lead_unparseable_reasks_and_leaves_field_empty(tmp_path):
    cs, _ = make_session(tmp_path)
    msg = cs.update_lead("monthly_bill", "pata nahi")
    assert cs.lead.monthly_bill is None and "Nothing was saved" in msg


def test_update_lead_advances_state_and_emits_events(tmp_path):
    cs, pub = make_session(tmp_path)
    cs.update_lead("identity_confirmed", "haan ji")
    types = [e["type"] for e in pub.sent]
    assert types == ["lead", "state"]
    assert cs.flow.current == State.INTEREST


def test_end_call_do_not_call_writes_record(tmp_path):
    cs, _ = make_session(tmp_path)
    cs.update_lead("identity_confirmed", "haan")
    cs.end_call("do_not_call", "asked to stop")
    data = json.loads((tmp_path / "call-test.json").read_text())
    assert data["outcome"] == "do_not_call"


def test_end_call_rejects_invalid_outcome(tmp_path):
    cs, _ = make_session(tmp_path)
    assert "Invalid" in cs.end_call("maybe")
    assert cs.result is None


def test_handoff_sets_flag(tmp_path):
    cs, pub = make_session(tmp_path)
    cs.handoff("asked for a person")
    assert cs.handoff_requested and pub.sent[-1]["type"] == "handoff"


def test_events_match_contract_shapes(tmp_path):
    cs, pub = make_session(tmp_path)
    cs.update_lead("property_type", "society mein flat")
    lead = [e for e in pub.sent if e["type"] == "lead"][0]
    assert lead["field"] == "property_type" and lead["value"] == "housing_society"
    assert isinstance(lead["seq"], int) and isinstance(lead["ts"], int)


# ---- prompts ----
def test_next_spoken_question_after_identity():
    lead = Lead(identity_confirmed=True)
    flow = CallFlow(lead)
    q = next_spoken_question(flow, "hi")
    assert q and "सोलर" in q


def test_unanswered_question_is_deferred_then_dropped(tmp_path):
    cs, _ = make_session(tmp_path)
    cs.update_lead("identity_confirmed", "haan")
    cs.update_lead("solar_interest", "haan")
    cs.update_lead("property_type", "society")
    assert cs.flow.pending_field() == "roof_ownership"
    cs.apply_turn("hmm I don't remember")
    assert cs.lead.roof_ownership is None
    assert "roof_ownership" in cs.flow.deferred
    assert cs.flow.pending_field() == "roof_access"
    q = next_spoken_question(cs.flow, "hi")
    assert q and "पहुँच" in q
    while cs.flow.current != State.WRAP_UP:
        pending = cs.flow.pending_field()
        assert pending
        cs.apply_turn("pata nahi")
    assert "roof_ownership" in cs.flow.recap_fields()
    recap = next_spoken_question(cs.flow, "hi")
    assert recap and recap.startswith("एक बार पक्का")
    cs.apply_turn("pata nahi")
    assert "roof_ownership" in cs.flow.released
    assert cs.lead.roof_ownership is None


def test_prompt_includes_forbidden_claims_rule():
    assert "Never state or promise any price" in build_system_prompt(State.BILL, Lead())


def test_prompt_only_mentions_current_state_goal():
    p = build_system_prompt(State.BILL, Lead())
    assert "monthly electricity bill" in p and "PM Surya Ghar" not in p.split("CURRENT STEP")[1]


def test_prompt_lists_filled_fields_so_agent_does_not_reask():
    p = build_system_prompt(State.BILL, Lead(monthly_bill=3000))
    assert "monthly bill (Rs): 3000" in p


# ---- metrics ----
def test_summary_percentiles():
    m = CallMetrics()
    for v in (100, 200, 300, 400, 1000):
        m.record_turn(v)
    s = m.summary()
    assert s["p50_ms"] == 300 and s["p95_ms"] == 1000


def test_summary_cost_uses_configured_rates(monkeypatch):
    monkeypatch.setenv("COST_LLM_IN_PER_MTOK", "100")
    m = CallMetrics()
    m.tokens_in = 1_000_000
    assert m.summary()["est_cost_inr"] == 100


def test_dispatch_metadata_defaults_to_cascade():
    assert parse_dispatch_metadata("hi") == ("hi", "cascade")
    assert parse_dispatch_metadata(None) == ("hi", "cascade")
    assert parse_dispatch_metadata('{"language": "mr", "pipeline": "s2s"}') == ("mr", "s2s")
    assert parse_dispatch_metadata("en:s2s") == ("en", "s2s")
    assert parse_dispatch_metadata('{"language": "ta", "pipeline": "nope"}') == ("ta", "cascade")

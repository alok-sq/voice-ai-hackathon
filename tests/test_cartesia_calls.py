import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from server.cartesia_calls import CartesiaCalls  # noqa: E402


def test_caller_answer_is_saved_and_finish_writes_the_record(tmp_path, monkeypatch):
    monkeypatch.setenv("OUT_DIR", str(tmp_path))
    calls = CartesiaCalls()
    call_id, opened = calls.open("hi")
    assert opened[0]["type"] == "state" and opened[0]["state"] == "IDENTITY"

    calls.turn(call_id, "assistant", "Kya aapne solar ke baare mein enquiry ki thi?")
    saved = calls.turn(call_id, "user", "haan ji")
    lead = [event for event in saved["events"] if event["type"] == "lead"]
    assert lead[0]["field"] == "identity_confirmed" and lead[0]["value"] is True

    done = calls.finish(call_id, "caller hung up")
    assert done["outcome"] == "callback"
    record = json.loads((tmp_path / f"{call_id}.json").read_text())
    assert record["identity_confirmed"] is True
    assert record["pipeline"] == "cartesia"
    assert record["transcript"][1]["text"] == "haan ji"


def test_tool_saves_a_bill_and_a_repeat_tool_is_ignored(tmp_path, monkeypatch):
    monkeypatch.setenv("OUT_DIR", str(tmp_path))
    calls = CartesiaCalls()
    call_id, _ = calls.open("hi")
    first = calls.tool(call_id, "update_lead", {"field": "monthly_bill", "value": "3 hazaar"}, "tool-1")
    assert first["result"].startswith("Saved monthly_bill")
    assert any(event["type"] == "lead" and event["value"] == 3000 for event in first["events"])
    second = calls.tool(call_id, "update_lead", {"field": "monthly_bill", "value": "9 hazaar"}, "tool-1")
    assert second["result"] == ""
    assert second["events"] == []


def test_reply_is_saved_only_for_the_question_just_asked(tmp_path, monkeypatch):
    monkeypatch.setenv("OUT_DIR", str(tmp_path))
    calls = CartesiaCalls()
    call_id, _ = calls.open("hi")

    calls.turn(call_id, "assistant", "Kya aapke paas do minute hain?")
    agreed = calls.turn(call_id, "user", "Okay.")
    assert not any(event["type"] == "lead" for event in agreed["events"])

    calls.turn(call_id, "assistant", "Kya aap rooftop solar lagwane mein interested hain?")
    yes = calls.turn(call_id, "user", "हाँ जी")
    assert any(event["field"] == "solar_interest" and event["value"] is True for event in yes["events"] if event["type"] == "lead")

    calls.turn(call_id, "assistant", "Aapka ghar independent hai, ya society mein flat hai?")
    house = calls.turn(call_id, "user", "मेरा घर independent है")
    lead = [event for event in house["events"] if event["type"] == "lead"]
    assert [event["field"] for event in lead] == ["property_type"]
    assert lead[0]["value"] == "independent_house"

    calls.turn(
        call_id,
        "assistant",
        "Hum bill kam karte hain. Achha, woh chhat aapki apni hai na?",
    )
    roof = calls.turn(call_id, "user", "जी")
    assert any(event["field"] == "roof_ownership" and event["value"] == "owned" for event in roof["events"] if event["type"] == "lead")
    assert not any(event["field"] == "monthly_bill" for event in roof["events"] if event["type"] == "lead")


def test_tool_does_not_treat_name_as_a_field(tmp_path, monkeypatch):
    monkeypatch.setenv("OUT_DIR", str(tmp_path))
    calls = CartesiaCalls()
    call_id, _ = calls.open("hi")
    saved = calls.tool(call_id, "update_lead", {"name": "Pune", "value": "city"}, "tool-2")
    assert saved["result"] == "No lead field was named. Nothing was saved."
    assert saved["events"] == []
    explicit = calls.tool(call_id, "update_lead", {"city_or_pincode": "Pune", "monthly_bill": "3 hazaar"}, "tool-3")
    fields = {event["field"]: event["value"] for event in explicit["events"] if event["type"] == "lead"}
    assert fields["city_or_pincode"] == "Pune"
    assert fields["monthly_bill"] == 3000


def test_a_no_and_a_denied_house_land_on_the_right_fields(tmp_path, monkeypatch):
    """The last live call: 'नहीं।' is interest, and 'मेरा अपना घर नहीं है' is not ownership=owned."""
    monkeypatch.setenv("OUT_DIR", str(tmp_path))
    calls = CartesiaCalls()
    call_id, _ = calls.open("hi")

    calls.turn(call_id, "assistant", "Kya aap rooftop solar lagwane mein interested hain?")
    no = calls.turn(call_id, "user", "Uh, नहीं।")
    assert any(event["field"] == "solar_interest" and event["value"] is False for event in no["events"] if event["type"] == "lead")

    calls.turn(
        call_id,
        "assistant",
        "Koi baat nahi. Bahut se log sirf yeh dekhte hain ki chhat sahi hai ya nahi, "
        "aur lagane ki koi majboori nahi hoti. Kya aap ek baar free mein yeh check karwana chahenge?",
    )
    house = calls.turn(call_id, "user", "लेकिन मेरा अपना घर नहीं है, तो मैं check करवा के भी क्या करूँ?")
    lead = {event["field"]: event["value"] for event in house["events"] if event["type"] == "lead"}
    assert lead == {"roof_ownership": "rented"}

    done = calls.finish(call_id, "Call ended by you")
    assert done["outcome"] == "not_qualified"


def test_thinking_about_it_is_not_a_refusal(tmp_path, monkeypatch):
    monkeypatch.setenv("OUT_DIR", str(tmp_path))
    calls = CartesiaCalls()
    call_id, _ = calls.open("hi")
    calls.turn(call_id, "assistant", "क्या आप अपने घर पर रूफटॉप सोलर लगवाने के बारे में सोच रहे हैं?")
    hedged = calls.turn(call_id, "user", "नहीं, मैं सोच रहा हूँ, लेकिन solar square के बारे में मुझे नहीं पता कुछ भी।")
    assert not any(event["type"] == "lead" for event in hedged["events"])
    calls.turn(call_id, "assistant", "Bataiye kaun sa din theek rahega?")
    calls.turn(call_id, "user", "परसों शाम छह बजे।")
    done = calls.finish(call_id, "Call ended by you")
    assert done["outcome"] == "qualified"
    assert any(event["type"] == "outcome" and event["outcome"] == "qualified" for event in done["events"])


def test_a_slot_is_the_day_and_time_not_the_question_when(tmp_path, monkeypatch):
    monkeypatch.setenv("OUT_DIR", str(tmp_path))
    calls = CartesiaCalls()
    call_id, _ = calls.open("hi")

    calls.turn(call_id, "assistant", "Kya aap chahenge ki hamara expert aakar dekh le, yeh bilkul free visit hai?")
    asked = calls.turn(call_id, "user", "कब आएगा?")
    assert not any(event["type"] == "lead" for event in asked["events"])

    calls.turn(call_id, "assistant", "Bataiye kaun sa din theek rahega?")
    day = calls.turn(call_id, "user", "परसों ठीक है।")
    assert any(
        event["field"] == "meeting_slot" and event["value"]["label"] == "परसों ठीक है।"
        for event in day["events"] if event["type"] == "lead"
    )

    calls.turn(call_id, "assistant", "Aur time kya rahega, subah ya dopahar?")
    clock = calls.turn(call_id, "user", "छह बजे शाम को।")
    assert any(
        event["field"] == "meeting_slot" and event["value"]["label"] == "परसों ठीक है।, छह बजे शाम को।"
        for event in clock["events"] if event["type"] == "lead"
    )


def test_unknown_call_is_rejected():
    calls = CartesiaCalls()
    try:
        calls.finish("call-0a1b2c3d", "nope")
    except KeyError:
        return
    raise AssertionError("expected an unknown call to be rejected")

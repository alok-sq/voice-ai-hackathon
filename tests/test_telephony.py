from server.telephony import (
    cartesia_status,
    elevenlabs_outbound_body,
    elevenlabs_status,
    pipeline_for,
)


def test_phone_agent_picks_the_livekit_pipeline():
    assert pipeline_for("demo") == "cascade"
    assert pipeline_for("demo_v2") == "s2s"


def test_elevenlabs_outbound_sends_no_prompt():
    assert elevenlabs_outbound_body("agent_abc", "phn_1", "+919800000001") == {
        "agent_id": "agent_abc",
        "agent_phone_number_id": "phn_1",
        "to_number": "+919800000001",
    }


def test_vendor_transcripts_keep_the_speaker_and_the_tool():
    lines, ended, _reason = cartesia_status({
        "status": "completed",
        "end_reason": "agent_hangup",
        "transcript": [{"role": "assistant", "text": "Alvida.", "tool_calls": [{"id": "t1", "name": "end_call", "arguments": {"outcome": "callback"}}]}],
    })
    assert ended is True
    assert lines == [{
        "role": "agent",
        "text": "Alvida.",
        "tools": [{"id": "t1", "name": "end_call", "arguments": {"outcome": "callback"}}],
    }]
    eleven, done, _reason = elevenlabs_status({
        "status": "in-progress",
        "transcript": [{"role": "agent", "message": "Bill kitna hai?", "tool_calls": []}, {"role": "user", "message": "6000."}],
    })
    assert done is False
    assert [line["role"] for line in eleven] == ["agent", "caller"]
    assert eleven[1]["text"] == "6000."

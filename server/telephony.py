"""Outbound phone calls for the four demo agents.

Demo and Demo v2 stay on the LiveKit SIP trunk. Demo v3 places the call through
Cartesia, and Demo v4 through ElevenLabs. Neither of those requests sends a prompt.
"""
from __future__ import annotations

import json
from typing import Any

PHONE_AGENTS = ("demo", "demo_v2", "demo_v3", "demo_v4")
LIVEKIT_AGENTS = ("demo", "demo_v2")
CARTESIA_CALLS_URL = "https://api.cartesia.ai/agents/calls"
ELEVENLABS_OUTBOUND_URL = "https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call"
ELEVENLABS_CONVERSATION_URL = "https://api.elevenlabs.io/v1/convai/conversations/{conversation_id}"


def pipeline_for(agent: str) -> str:
    """The LiveKit worker pipeline a phone call should dispatch."""
    if agent == "demo_v2":
        return "s2s"
    if agent == "demo":
        return "cascade"
    raise ValueError(agent)


def cartesia_outbound_body(agent_id: str, from_number_id: str, to_number: str) -> dict[str, Any]:
    return {
        "from_number_id": from_number_id,
        "agent_id": agent_id,
        "outbound_calls": [{"to_number": to_number}],
    }


def elevenlabs_outbound_body(agent_id: str, phone_number_id: str, to_number: str) -> dict[str, Any]:
    return {
        "agent_id": agent_id,
        "agent_phone_number_id": phone_number_id,
        "to_number": to_number,
    }


def cartesia_vendor_id(payload: Any) -> tuple[str, str]:
    """Return (agent_call_id, error). One of the two is empty."""
    calls = payload.get("calls") if isinstance(payload, dict) else None
    item = calls[0] if isinstance(calls, list) and calls and isinstance(calls[0], dict) else None
    if item is None:
        return "", "Cartesia did not start the call."
    error = item.get("error")
    if error:
        return "", _clip(error if isinstance(error, str) else json.dumps(error))
    vendor = item.get("agent_call_id")
    if not isinstance(vendor, str) or not vendor.strip():
        return "", "Cartesia did not return a call id."
    return vendor.strip(), ""


def elevenlabs_vendor_id(payload: Any) -> tuple[str, str]:
    if not isinstance(payload, dict):
        return "", "ElevenLabs did not start the call."
    if payload.get("success") is False:
        return "", _clip(payload.get("message") or "ElevenLabs did not start the call.")
    vendor = payload.get("conversation_id")
    if not isinstance(vendor, str) or not vendor.strip():
        return "", "ElevenLabs did not return a conversation id."
    return vendor.strip(), ""


def cartesia_status(payload: Any) -> tuple[list[dict[str, Any]], bool, str]:
    if not isinstance(payload, dict):
        return [], False, ""
    ended = payload.get("status") in ("completed", "failed")
    reason = _reason(payload.get("end_reason") or payload.get("error_message"), "Call ended" if ended else "")
    return _cartesia_lines(payload.get("transcript")), ended, reason


def elevenlabs_status(payload: Any) -> tuple[list[dict[str, Any]], bool, str]:
    if not isinstance(payload, dict):
        return [], False, ""
    ended = payload.get("status") in ("done", "failed")
    reason = "Call failed" if payload.get("status") == "failed" else ("Call ended" if ended else "")
    return _elevenlabs_lines(payload.get("transcript")), ended, reason


def _cartesia_lines(transcript: Any) -> list[dict[str, Any]]:
    lines = []
    for item in transcript or []:
        if not isinstance(item, dict):
            continue
        role = _role(item.get("role"), assistant="assistant")
        if not role:
            continue
        tools = []
        for tool in item.get("tool_calls") or []:
            if not isinstance(tool, dict) or not tool.get("name"):
                continue
            tools.append({
                "id": str(tool.get("id") or ""),
                "name": tool.get("name"),
                "arguments": tool.get("arguments") or {},
            })
        lines.append({"role": role, "text": item.get("text") or "", "tools": tools})
    return lines


def _elevenlabs_lines(transcript: Any) -> list[dict[str, Any]]:
    lines = []
    for item in transcript or []:
        if not isinstance(item, dict):
            continue
        role = _role(item.get("role"), assistant="agent")
        if not role:
            continue
        tools = []
        for tool in item.get("tool_calls") or []:
            if not isinstance(tool, dict):
                continue
            name = tool.get("tool_name") or tool.get("name") or ""
            if not name:
                continue
            tools.append({
                "id": str(tool.get("request_id") or tool.get("id") or ""),
                "name": name,
                "arguments": _json_object(tool.get("params_as_json") if "params_as_json" in tool else tool.get("arguments")),
            })
        lines.append({"role": role, "text": item.get("message") or item.get("text") or "", "tools": tools})
    return lines


def _role(raw: Any, assistant: str) -> str:
    if raw in ("user", "caller"):
        return "caller"
    if raw == assistant:
        return "agent"
    return ""


def _json_object(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except ValueError:
            return {"value": raw}
        return parsed if isinstance(parsed, dict) else {"value": raw}
    return {}


def _reason(value: Any, fallback: str) -> str:
    text = str(value or "").replace("_", " ").strip()
    return _clip(text) if text else fallback


def _clip(value: Any) -> str:
    return str(value).strip()[:200]

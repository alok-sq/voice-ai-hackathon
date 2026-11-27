"""Backend for the voice agent console.

Holds every secret. The browser only ever receives a short-lived room token.

  GET  /api/health   -> which settings are configured (names only, never values)
  POST /api/token    -> LiveKit room token for the browser (also dispatches the agent)
  POST /api/call     -> dial a test number through the SIP trunk into a new room
  POST /api/end      -> close a call room for everyone (hangs up the phone leg)

Run: uvicorn server.main:app --reload --port 8000   (from the repo root)
LiveKit API names verified against livekit-api 2.0.1 (pinned in requirements.txt).
"""
from __future__ import annotations

import json
import os
import re
import secrets
from typing import Any, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from server.cartesia_calls import CALLS, ELEVEN_CALLS
from server.telephony import (
    CARTESIA_CALLS_URL,
    ELEVENLABS_CONVERSATION_URL,
    ELEVENLABS_OUTBOUND_URL,
    LIVEKIT_AGENTS,
    PHONE_AGENTS,
    cartesia_outbound_body,
    cartesia_status,
    cartesia_vendor_id,
    elevenlabs_outbound_body,
    elevenlabs_status,
    elevenlabs_vendor_id,
    pipeline_for,
)

try:  # optional: load a local .env if python-dotenv is installed
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

REQUIRED_BASE = ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"]
REQUIRED_PHONE = ["SIP_OUTBOUND_TRUNK_ID"]
REQUIRED_CARTESIA = ["TTS_API_KEY", "CARTESIA_AGENT_ID"]
REQUIRED_CARTESIA_PHONE = REQUIRED_CARTESIA + ["CARTESIA_FROM_NUMBER_ID"]
REQUIRED_ELEVENLABS = ["ELEVENLABS_API_KEY", "ELEVENLABS_AGENT_ID"]
REQUIRED_ELEVENLABS_PHONE = REQUIRED_ELEVENLABS + ["ELEVENLABS_PHONE_NUMBER_ID"]
ELEVENLABS_SIGNED_URL = "https://api.elevenlabs.io/v1/convai/conversation/get-signed-url"
CARTESIA_VERSION = "2026-08-14"
CARTESIA_SESSION_URL = "https://api.cartesia.ai/v1/agents/websocket/{agent_id}/sessions"
PHONE_RE = re.compile(r"^\+?[0-9]{10,15}$")
# Only rooms this backend creates (see _new_room) may be closed through /api/end.
ROOM_RE = re.compile(r"^call-[0-9a-f]{8}$")
LANGUAGES = {"hi", "mr", "ta", "kn", "en"}
PIPELINES = {"cascade", "s2s"}

app = FastAPI(title="Voice agent console backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o for o in os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:8080").split(",") if o],
    allow_methods=["POST", "GET"],
    allow_headers=["Content-Type"],
)


def _env(name: str) -> Optional[str]:
    return os.getenv(name) or None


def _missing(names: list[str]) -> list[str]:
    return [n for n in names if not _env(n)]


def _require(names: list[str]) -> None:
    missing = _missing(names)
    if missing:
        raise HTTPException(503, detail=f"Backend not configured. Missing: {', '.join(missing)}")


def _agent_name() -> str:
    return _env("AGENT_NAME") or "solarsquare-lrm"


def _new_room() -> str:
    return f"call-{secrets.token_hex(4)}"


class TokenRequest(BaseModel):
    language: str = "hi"
    room: Optional[str] = None
    listenOnly: bool = False
    pipeline: str = "cascade"


def _dispatch_metadata(language: str, pipeline: str = "cascade") -> str:
    if pipeline not in PIPELINES:
        pipeline = "cascade"
    return json.dumps({"language": language, "pipeline": pipeline})


class CallRequest(BaseModel):
    phone: str
    language: str = "hi"
    agent: str = "demo"


class EndRequest(BaseModel):
    room: str


class CartesiaSessionRequest(BaseModel):
    language: str = "hi"


class CartesiaTurnRequest(BaseModel):
    callId: str
    role: str = "user"
    text: str = ""
    toolCalls: list = []


class CartesiaToolRequest(BaseModel):
    callId: str
    name: str
    arguments: dict = {}
    toolId: str = ""


class CartesiaEndRequest(BaseModel):
    callId: str
    reason: str = ""


def cartesia_session_body(_language: str) -> dict:
    """No prompt and no language override.

    The dashboard agent already has a primary language. Sending `hi` on top of a saved
    `hi-IN` is rejected, because Cartesia treats them as the same language.
    """
    return {}


@app.get("/api/health")
def health():
    return {
        "livekit": not _missing(REQUIRED_BASE),
        "phone": not _missing(REQUIRED_BASE + REQUIRED_PHONE),
        "cartesia": not _missing(REQUIRED_CARTESIA),
        "elevenlabs": not _missing(REQUIRED_ELEVENLABS),
        "cartesiaPhone": not _missing(REQUIRED_CARTESIA_PHONE),
        "elevenlabsPhone": not _missing(REQUIRED_ELEVENLABS_PHONE),
        "missing": _missing(REQUIRED_BASE + REQUIRED_PHONE),
    }


@app.post("/api/token")
async def token(req: TokenRequest):
    _require(REQUIRED_BASE)
    if req.language not in LANGUAGES:
        raise HTTPException(400, detail="Unsupported language.")
    if req.pipeline not in PIPELINES:
        raise HTTPException(400, detail="Unsupported pipeline.")
    from livekit import api  # imported late so /api/health works without the package

    room = req.room or _new_room()
    # The agent treats `console-*` (browser mic) and SIP participants as the caller. `listener-*` never is.
    identity = f"{'listener' if req.listenOnly else 'console'}-{secrets.token_hex(3)}"
    grants = api.VideoGrants(
        room_join=True,
        room=room,
        can_publish=not req.listenOnly,
        can_subscribe=True,
        # The console sends commands (e.g. handoff_request) on the data topic `console-commands`.
        can_publish_data=True,
    )
    jwt = api.AccessToken(_env("LIVEKIT_API_KEY"), _env("LIVEKIT_API_SECRET")).with_identity(identity).with_grants(grants)
    if not req.room:  # browser call: dispatch the agent into the new room with the chosen language
        async with api.LiveKitAPI(_env("LIVEKIT_URL"), _env("LIVEKIT_API_KEY"), _env("LIVEKIT_API_SECRET")) as lk:
            await lk.agent_dispatch.create_dispatch(
                api.CreateAgentDispatchRequest(
                    agent_name=_agent_name(),
                    room=room,
                    metadata=_dispatch_metadata(req.language, req.pipeline),
                )
            )
    return {"url": _env("LIVEKIT_URL"), "token": jwt.to_jwt(), "room": room}


@app.post("/api/cartesia/session")
async def cartesia_session(req: CartesiaSessionRequest):
    """A short-lived browser session for the agent saved in the Cartesia dashboard.

    The browser talks audio to Cartesia directly. This server never sends a system prompt,
    so the dashboard prompt is what answers.
    """
    _require(REQUIRED_CARTESIA)
    if req.language not in LANGUAGES:
        raise HTTPException(400, detail="Unsupported language.")
    agent_id = _env("CARTESIA_AGENT_ID") or ""
    if not re.fullmatch(r"[A-Za-z0-9_-]+", agent_id):
        raise HTTPException(503, detail="Backend not configured. CARTESIA_AGENT_ID is not a valid agent id.")
    import httpx

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(
                CARTESIA_SESSION_URL.format(agent_id=agent_id),
                headers={
                    "Cartesia-Version": CARTESIA_VERSION,
                    "X-API-Key": _env("TTS_API_KEY") or "",
                    "Content-Type": "application/json",
                },
                json=cartesia_session_body(req.language),
            )
    except httpx.HTTPError as exc:
        raise HTTPException(502, detail="Could not reach Cartesia.") from exc
    if response.status_code >= 400:
        detail = "Cartesia refused the session."
        try:
            payload = response.json()
            message = payload.get("message") or payload.get("detail") if isinstance(payload, dict) else None
            if isinstance(message, str) and message.strip():
                detail = message.strip()[:200]
        except ValueError:
            pass
        raise HTTPException(502, detail=detail)
    try:
        payload = response.json()
    except ValueError as exc:
        raise HTTPException(502, detail="Cartesia returned an unreadable session.") from exc
    url = payload.get("url") if isinstance(payload, dict) else None
    token = payload.get("token") if isinstance(payload, dict) else None
    if not isinstance(url, str) or not isinstance(token, str) or not url or not token:
        raise HTTPException(502, detail="Cartesia returned a session without a url and token.")
    call_id, events = CALLS.open(req.language)
    return {"url": url, "token": token, "callId": call_id, "events": events}


@app.post("/api/cartesia/turn")
def cartesia_turn(req: CartesiaTurnRequest):
    try:
        return CALLS.turn(req.callId, req.role, req.text, req.toolCalls)
    except KeyError:
        raise HTTPException(404, detail="Unknown Cartesia call.") from None


@app.post("/api/cartesia/tool")
def cartesia_tool(req: CartesiaToolRequest):
    try:
        return CALLS.tool(req.callId, req.name, req.arguments, req.toolId)
    except KeyError:
        raise HTTPException(404, detail="Unknown Cartesia call.") from None


@app.post("/api/cartesia/end")
def cartesia_end(req: CartesiaEndRequest):
    try:
        return CALLS.finish(req.callId, req.reason)
    except KeyError:
        raise HTTPException(404, detail="Unknown Cartesia call.") from None


@app.post("/api/elevenlabs/session")
async def elevenlabs_session(req: CartesiaSessionRequest):
    """A signed websocket for the agent saved in the ElevenLabs dashboard.

    The browser talks audio to ElevenLabs directly. This server does not send a prompt,
    so the dashboard agent is what answers.
    """
    _require(REQUIRED_ELEVENLABS)
    if req.language not in LANGUAGES:
        raise HTTPException(400, detail="Unsupported language.")
    agent_id = _env("ELEVENLABS_AGENT_ID") or ""
    if not re.fullmatch(r"[A-Za-z0-9_-]+", agent_id):
        raise HTTPException(503, detail="Backend not configured. ELEVENLABS_AGENT_ID is not a valid agent id.")
    import httpx

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(
                ELEVENLABS_SIGNED_URL,
                params={"agent_id": agent_id},
                headers={"xi-api-key": _env("ELEVENLABS_API_KEY") or ""},
            )
    except httpx.HTTPError as exc:
        raise HTTPException(502, detail="Could not reach ElevenLabs.") from exc
    if response.status_code >= 400:
        detail = "ElevenLabs refused the session."
        try:
            payload = response.json()
            message = payload.get("detail") if isinstance(payload, dict) else None
            if isinstance(message, dict):
                message = message.get("message") or message.get("status")
            if isinstance(message, str) and message.strip():
                detail = message.strip()[:200]
        except ValueError:
            pass
        raise HTTPException(502, detail=detail)
    try:
        payload = response.json()
    except ValueError as exc:
        raise HTTPException(502, detail="ElevenLabs returned an unreadable session.") from exc
    url = payload.get("signed_url") if isinstance(payload, dict) else None
    if not isinstance(url, str) or not url.startswith("wss://"):
        raise HTTPException(502, detail="ElevenLabs returned a session without a signed url.")
    call_id, events = ELEVEN_CALLS.open(req.language)
    return {"url": url, "callId": call_id, "events": events}


@app.post("/api/elevenlabs/turn")
def elevenlabs_turn(req: CartesiaTurnRequest):
    try:
        return ELEVEN_CALLS.turn(req.callId, req.role, req.text, req.toolCalls)
    except KeyError:
        raise HTTPException(404, detail="Unknown ElevenLabs call.") from None


@app.post("/api/elevenlabs/tool")
def elevenlabs_tool(req: CartesiaToolRequest):
    try:
        return ELEVEN_CALLS.tool(req.callId, req.name, req.arguments, req.toolId)
    except KeyError:
        raise HTTPException(404, detail="Unknown ElevenLabs call.") from None


@app.post("/api/elevenlabs/end")
def elevenlabs_end(req: CartesiaEndRequest):
    try:
        return ELEVEN_CALLS.finish(req.callId, req.reason)
    except KeyError:
        raise HTTPException(404, detail="Unknown ElevenLabs call.") from None


def _checked_phone(req: CallRequest) -> str:
    phone = re.sub(r"[\s()-]", "", req.phone)
    if not PHONE_RE.match(phone):
        raise HTTPException(400, detail="Enter a valid phone number.")
    if req.language not in LANGUAGES:
        raise HTTPException(400, detail="Unsupported language.")
    if req.agent not in PHONE_AGENTS:
        raise HTTPException(400, detail="Unsupported agent.")
    allow = [re.sub(r"[\s()-]", "", p) for p in (_env("TEST_NUMBER_ALLOWLIST") or "").split(",") if p.strip()]
    if not allow:
        raise HTTPException(503, detail="Backend not configured. Set TEST_NUMBER_ALLOWLIST (team numbers only).")
    if phone not in allow:
        raise HTTPException(403, detail="That number is not on the test allowlist. Real customers are never called.")
    return phone


def _hosted_store(call_id: str):
    if call_id.startswith("elab-"):
        return ELEVEN_CALLS
    if call_id.startswith("cart-"):
        return CALLS
    raise KeyError(call_id)


def _id_ok(value: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z0-9_-]+", value or ""))


async def _read_json(response) -> Any:
    try:
        return response.json()
    except ValueError:
        return None


def _upstream_message(response, fallback: str) -> str:
    payload = None
    try:
        payload = response.json()
    except ValueError:
        payload = None
    message = None
    if isinstance(payload, dict):
        message = payload.get("message") or payload.get("detail")
    if not isinstance(message, str) or not message.strip():
        return fallback
    return message.strip()[:200]


@app.post("/api/call")
async def call(req: CallRequest):
    phone = _checked_phone(req)
    if req.agent in LIVEKIT_AGENTS:
        return await _livekit_call(phone, req.language, pipeline_for(req.agent))
    if req.agent == "demo_v3":
        return await _cartesia_call(phone, req.language)
    return await _elevenlabs_call(phone, req.language)


async def _livekit_call(phone: str, language: str, pipeline: str) -> dict:
    _require(REQUIRED_BASE + REQUIRED_PHONE)
    from livekit import api

    room = _new_room()
    async with api.LiveKitAPI(_env("LIVEKIT_URL"), _env("LIVEKIT_API_KEY"), _env("LIVEKIT_API_SECRET")) as lk:
        await lk.agent_dispatch.create_dispatch(
            api.CreateAgentDispatchRequest(
                agent_name=_agent_name(),
                room=room,
                metadata=_dispatch_metadata(language, pipeline),
            )
        )
        await lk.sip.create_sip_participant(
            api.CreateSIPParticipantRequest(
                sip_trunk_id=_env("SIP_OUTBOUND_TRUNK_ID"),
                sip_call_to=phone,
                room_name=room,
                participant_identity=f"phone-{secrets.token_hex(3)}",
            )
        )
    return {"mode": "livekit", "room": room}


async def _cartesia_call(phone: str, language: str) -> dict:
    _require(REQUIRED_CARTESIA_PHONE)
    agent_id = _env("CARTESIA_AGENT_ID") or ""
    from_id = _env("CARTESIA_FROM_NUMBER_ID") or ""
    if not _id_ok(agent_id) or not _id_ok(from_id):
        raise HTTPException(503, detail="Backend not configured. CARTESIA_AGENT_ID or CARTESIA_FROM_NUMBER_ID is not valid.")
    import httpx

    try:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(
                CARTESIA_CALLS_URL,
                headers={
                    "Cartesia-Version": CARTESIA_VERSION,
                    "X-API-Key": _env("TTS_API_KEY") or "",
                    "Content-Type": "application/json",
                },
                json=cartesia_outbound_body(agent_id, from_id, phone),
            )
    except httpx.HTTPError as exc:
        raise HTTPException(502, detail="Could not reach Cartesia.") from exc
    payload = await _read_json(response)
    if response.status_code >= 400:
        raise HTTPException(502, detail=_upstream_message(response, "Cartesia refused the call."))
    vendor, error = cartesia_vendor_id(payload)
    if error or not _id_ok(vendor):
        raise HTTPException(502, detail=error or "Cartesia returned an unusable call id.")
    call_id, events = CALLS.open(language)
    CALLS.bind_vendor(call_id, vendor)
    return {"mode": "hosted", "callId": call_id, "events": events}


async def _elevenlabs_call(phone: str, language: str) -> dict:
    _require(REQUIRED_ELEVENLABS_PHONE)
    agent_id = _env("ELEVENLABS_AGENT_ID") or ""
    phone_id = _env("ELEVENLABS_PHONE_NUMBER_ID") or ""
    if not _id_ok(agent_id) or not _id_ok(phone_id):
        raise HTTPException(503, detail="Backend not configured. ELEVENLABS_AGENT_ID or ELEVENLABS_PHONE_NUMBER_ID is not valid.")
    import httpx

    try:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(
                ELEVENLABS_OUTBOUND_URL,
                headers={"xi-api-key": _env("ELEVENLABS_API_KEY") or "", "Content-Type": "application/json"},
                json=elevenlabs_outbound_body(agent_id, phone_id, phone),
            )
    except httpx.HTTPError as exc:
        raise HTTPException(502, detail="Could not reach ElevenLabs.") from exc
    payload = await _read_json(response)
    if response.status_code >= 400:
        raise HTTPException(502, detail=_upstream_message(response, "ElevenLabs refused the call."))
    vendor, error = elevenlabs_vendor_id(payload)
    if error or not _id_ok(vendor):
        raise HTTPException(502, detail=error or "ElevenLabs returned an unusable conversation id.")
    call_id, events = ELEVEN_CALLS.open(language)
    ELEVEN_CALLS.bind_vendor(call_id, vendor)
    return {"mode": "hosted", "callId": call_id, "events": events}


class PhoneRequest(BaseModel):
    callId: str


@app.post("/api/phone/sync")
async def phone_sync(req: PhoneRequest):
    try:
        store = _hosted_store(req.callId)
        vendor = store.vendor_id(req.callId)
    except KeyError:
        raise HTTPException(404, detail="Unknown phone call.") from None
    import httpx

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            if store is CALLS:
                response = await client.get(
                    f"{CARTESIA_CALLS_URL}/{vendor}",
                    headers={"Cartesia-Version": CARTESIA_VERSION, "X-API-Key": _env("TTS_API_KEY") or ""},
                )
            else:
                response = await client.get(
                    ELEVENLABS_CONVERSATION_URL.format(conversation_id=vendor),
                    headers={"xi-api-key": _env("ELEVENLABS_API_KEY") or ""},
                )
    except httpx.HTTPError as exc:
        raise HTTPException(502, detail="Could not reach the phone agent.") from exc
    if response.status_code >= 400:
        raise HTTPException(502, detail=_upstream_message(response, "The phone agent did not return the call."))
    payload = await _read_json(response)
    lines, ended, reason = cartesia_status(payload) if store is CALLS else elevenlabs_status(payload)
    events = store.ingest(req.callId, lines)
    if ended:
        events.extend(store.finish(req.callId, reason)["events"])
    return {"events": events, "ended": ended, "reason": reason}


@app.post("/api/phone/end")
async def phone_end(req: PhoneRequest):
    try:
        store = _hosted_store(req.callId)
        vendor = store.vendor_id(req.callId)
    except KeyError:
        raise HTTPException(404, detail="Unknown phone call.") from None
    import httpx

    if store is CALLS:
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                await client.post(
                    f"{CARTESIA_CALLS_URL}/{vendor}/cancel",
                    headers={"Cartesia-Version": CARTESIA_VERSION, "X-API-Key": _env("TTS_API_KEY") or ""},
                )
        except httpx.HTTPError:
            pass
    try:
        synced = await phone_sync(req)
    except HTTPException:
        synced = {"events": [], "ended": False, "reason": ""}
    events = list(synced["events"])
    if not synced["ended"]:
        events.extend(store.finish(req.callId, "Call ended by you")["events"])
        if store is ELEVEN_CALLS:
            events.append({
                "type": "system",
                "text": "Saved the transcript so far. The phone stays up until someone hangs up.",
            })
    return {"events": events, "ended": True, "reason": synced["reason"] or "Call ended by you"}


@app.post("/api/end")
async def end(req: EndRequest):
    """Deleting the room disconnects everyone: the phone caller, the agent and any console."""
    _require(REQUIRED_BASE)
    if not ROOM_RE.match(req.room):
        raise HTTPException(400, detail="Unknown room.")
    from livekit import api

    async with api.LiveKitAPI(_env("LIVEKIT_URL"), _env("LIVEKIT_API_KEY"), _env("LIVEKIT_API_SECRET")) as lk:
        await lk.room.delete_room(api.DeleteRoomRequest(room=req.room))
    return {"ok": True}

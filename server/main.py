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

import asyncio
import json
import logging
import os
import re
import secrets
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from server.cartesia_calls import CartesiaCalls

try:  # optional: load a local .env if python-dotenv is installed
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

REQUIRED_BASE = ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"]
REQUIRED_PHONE = ["SIP_OUTBOUND_TRUNK_ID"]
REQUIRED_CARTESIA = ["TTS_API_KEY", "CARTESIA_AGENT_ID"]
CARTESIA_VERSION = "2026-08-14"
CARTESIA_SESSION_URL = "https://api.cartesia.ai/v1/agents/websocket/{agent_id}/sessions"
PHONE_RE = re.compile(r"^\+?[0-9]{10,15}$")
# Only rooms this backend creates (see _new_room) may be closed through /api/end.
ROOM_RE = re.compile(r"^call-[0-9a-f]{8}$")
LANGUAGES = {"hi", "mr", "ta", "kn", "en"}
PIPELINES = {"cascade", "s2s"}

logger = logging.getLogger("server")


def _conversation_recorder(call_id: str, language: str):
    """Record a Demo v3 (Cartesia) call: Redis during the call, PostgreSQL after.

    Off (returns a disabled recorder) when neither REDIS_URL nor DATABASE_URL is set.
    Must run on the server's event loop, so the Cartesia endpoints are async.
    """
    from agent.conversation.recorder import ConversationRecorder, ensure_reconciler

    recorder = ConversationRecorder.from_env(
        call_id, language=language, agent_name=f"{_agent_name()} (cartesia)", channel="browser",
    )
    if recorder.enabled:
        ensure_reconciler()  # retries pending conversations, finalises abandoned ones
    return recorder


CALLS = CartesiaCalls(recorder_factory=_conversation_recorder)
# Persist tasks run after /api/cartesia/end has answered; keep references so they are not collected.
_PERSIST_TASKS: set[asyncio.Task] = set()

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
async def cartesia_turn(req: CartesiaTurnRequest):
    try:
        return CALLS.turn(req.callId, req.role, req.text, req.toolCalls)
    except KeyError:
        raise HTTPException(404, detail="Unknown Cartesia call.") from None


@app.post("/api/cartesia/tool")
async def cartesia_tool(req: CartesiaToolRequest):
    try:
        return CALLS.tool(req.callId, req.name, req.arguments, req.toolId)
    except KeyError:
        raise HTTPException(404, detail="Unknown Cartesia call.") from None


@app.post("/api/cartesia/end")
async def cartesia_end(req: CartesiaEndRequest):
    try:
        done = CALLS.finish(req.callId, req.reason)
    except KeyError:
        raise HTTPException(404, detail="Unknown Cartesia call.") from None
    # Store the conversation without making the console wait. If this process dies first,
    # the conversation is still in Redis and the reconciler stores it later.
    task = asyncio.create_task(CALLS.persist(req.callId, req.reason))
    _PERSIST_TASKS.add(task)
    task.add_done_callback(_PERSIST_TASKS.discard)
    return done


@app.post("/api/call")
async def call(req: CallRequest):
    _require(REQUIRED_BASE + REQUIRED_PHONE)
    phone = re.sub(r"[\s()-]", "", req.phone)
    if not PHONE_RE.match(phone):
        raise HTTPException(400, detail="Enter a valid phone number.")
    if req.language not in LANGUAGES:
        raise HTTPException(400, detail="Unsupported language.")
    allow = [re.sub(r"[\s()-]", "", p) for p in (_env("TEST_NUMBER_ALLOWLIST") or "").split(",") if p.strip()]
    if not allow:
        raise HTTPException(503, detail="Backend not configured. Set TEST_NUMBER_ALLOWLIST (team numbers only).")
    if phone not in allow:
        raise HTTPException(403, detail="That number is not on the test allowlist. Real customers are never called.")
    from livekit import api

    room = _new_room()
    async with api.LiveKitAPI(_env("LIVEKIT_URL"), _env("LIVEKIT_API_KEY"), _env("LIVEKIT_API_SECRET")) as lk:
        await lk.agent_dispatch.create_dispatch(
            api.CreateAgentDispatchRequest(
                agent_name=_agent_name(),
                room=room,
                metadata=_dispatch_metadata(req.language, "cascade"),
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
    return {"room": room}


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

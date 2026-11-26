"""Backend for the voice agent console.

Holds every secret. The browser only ever receives a short-lived room token.

  GET  /api/health   -> which settings are configured (names only, never values)
  POST /api/token    -> LiveKit room token for the browser (also dispatches the agent)
  POST /api/call     -> dial a test number through the SIP trunk into a new room

Run: uvicorn server.main:app --reload --port 8000   (from the repo root)
LiveKit API names follow livekit-api; verify them against the version you pin.
"""
from __future__ import annotations

import os
import re
import secrets
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

try:  # optional: load a local .env if python-dotenv is installed
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

REQUIRED_BASE = ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"]
REQUIRED_PHONE = ["SIP_OUTBOUND_TRUNK_ID"]
PHONE_RE = re.compile(r"^\+?[0-9]{10,15}$")
LANGUAGES = {"hi", "mr", "ta", "kn", "en"}

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


class TokenRequest(BaseModel):
    language: str = "hi"
    room: Optional[str] = None
    listenOnly: bool = False


class CallRequest(BaseModel):
    phone: str
    language: str = "hi"


@app.get("/api/health")
def health():
    return {
        "livekit": not _missing(REQUIRED_BASE),
        "phone": not _missing(REQUIRED_BASE + REQUIRED_PHONE),
        "missing": _missing(REQUIRED_BASE + REQUIRED_PHONE),
    }


@app.post("/api/token")
async def token(req: TokenRequest):
    _require(REQUIRED_BASE)
    if req.language not in LANGUAGES:
        raise HTTPException(400, detail="Unsupported language.")
    from livekit import api  # imported late so /api/health works without the package

    room = req.room or f"call-{secrets.token_hex(4)}"
    identity = f"console-{secrets.token_hex(3)}"
    grants = api.VideoGrants(
        room_join=True,
        room=room,
        can_publish=not req.listenOnly,
        can_subscribe=True,
        can_publish_data=False,
    )
    jwt = api.AccessToken(_env("LIVEKIT_API_KEY"), _env("LIVEKIT_API_SECRET")).with_identity(identity).with_grants(grants)
    if not req.room:  # browser call: dispatch the agent into the new room with the chosen language
        async with api.LiveKitAPI(_env("LIVEKIT_URL"), _env("LIVEKIT_API_KEY"), _env("LIVEKIT_API_SECRET")) as lk:
            await lk.agent_dispatch.create_dispatch(
                api.CreateAgentDispatchRequest(agent_name=_agent_name(), room=room, metadata=req.language)
            )
    return {"url": _env("LIVEKIT_URL"), "token": jwt.to_jwt(), "room": room}


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

    room = f"call-{secrets.token_hex(4)}"
    async with api.LiveKitAPI(_env("LIVEKIT_URL"), _env("LIVEKIT_API_KEY"), _env("LIVEKIT_API_SECRET")) as lk:
        await lk.agent_dispatch.create_dispatch(
            api.CreateAgentDispatchRequest(agent_name=_agent_name(), room=room, metadata=req.language)
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

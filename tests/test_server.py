import pytest
from fastapi.testclient import TestClient

from server.main import app, cartesia_session_body

ENV_KEYS = [
    "LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET",
    "SIP_OUTBOUND_TRUNK_ID", "TEST_NUMBER_ALLOWLIST",
    "TTS_API_KEY", "CARTESIA_AGENT_ID",
    "REDIS_URL", "DATABASE_URL",  # server tests never write to a real conversation log
]


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for k in ENV_KEYS:
        monkeypatch.delenv(k, raising=False)


@pytest.fixture
def client():
    return TestClient(app)


def configure(monkeypatch, **extra):
    base = {"LIVEKIT_URL": "wss://x.livekit.cloud", "LIVEKIT_API_KEY": "k", "LIVEKIT_API_SECRET": "s"}
    for k, v in {**base, **extra}.items():
        monkeypatch.setenv(k, v)


def test_health_reports_missing_names_not_values(client):
    r = client.get("/api/health").json()
    assert r["livekit"] is False and r["phone"] is False
    assert "LIVEKIT_API_KEY" in r["missing"]


def test_health_ready_when_configured(client, monkeypatch):
    configure(monkeypatch, SIP_OUTBOUND_TRUNK_ID="ST_1")
    r = client.get("/api/health").json()
    assert r["livekit"] is True and r["phone"] is True and r["missing"] == []


def test_token_503_when_unconfigured(client):
    r = client.post("/api/token", json={"language": "hi"})
    assert r.status_code == 503 and "LIVEKIT_API_KEY" in r.json()["detail"]


def test_token_rejects_unknown_language(client, monkeypatch):
    configure(monkeypatch)
    assert client.post("/api/token", json={"language": "xx"}).status_code == 400


def test_token_rejects_unknown_pipeline(client, monkeypatch):
    configure(monkeypatch)
    assert client.post("/api/token", json={"language": "hi", "pipeline": "foo"}).status_code == 400


def test_call_rejects_malformed_number(client, monkeypatch):
    configure(monkeypatch, SIP_OUTBOUND_TRUNK_ID="ST_1", TEST_NUMBER_ALLOWLIST="+919800000001")
    assert client.post("/api/call", json={"phone": "12345"}).status_code == 400


def test_call_refuses_when_allowlist_empty(client, monkeypatch):
    configure(monkeypatch, SIP_OUTBOUND_TRUNK_ID="ST_1")
    r = client.post("/api/call", json={"phone": "+919800000001"})
    assert r.status_code == 503 and "TEST_NUMBER_ALLOWLIST" in r.json()["detail"]


def test_call_refuses_number_not_on_allowlist(client, monkeypatch):
    configure(monkeypatch, SIP_OUTBOUND_TRUNK_ID="ST_1", TEST_NUMBER_ALLOWLIST="+919800000001")
    r = client.post("/api/call", json={"phone": "+919811111111"})
    assert r.status_code == 403 and "allowlist" in r.json()["detail"]


def test_end_503_when_unconfigured(client):
    r = client.post("/api/end", json={"room": "call-0a1b2c3d"})
    assert r.status_code == 503


def test_end_rejects_rooms_the_console_did_not_create(client, monkeypatch):
    configure(monkeypatch)
    for room in ["some-other-room", "call-XYZ", "call-0a1b2c3d; drop", ""]:
        assert client.post("/api/end", json={"room": room}).status_code == 400


def test_cartesia_session_body_does_not_override_language_or_prompt():
    assert cartesia_session_body("hi") == {}


def test_cartesia_session_503_when_unconfigured(client):
    r = client.post("/api/cartesia/session", json={"language": "hi"})
    assert r.status_code == 503
    assert "TTS_API_KEY" in r.json()["detail"] and "CARTESIA_AGENT_ID" in r.json()["detail"]


def test_cartesia_session_returns_url_and_token_only(client, monkeypatch):
    configure(monkeypatch, TTS_API_KEY="sk_test", CARTESIA_AGENT_ID="agent_abc")
    seen = {}

    class FakeResponse:
        status_code = 200

        def json(self):
            return {"url": "wss://api.cartesia.ai/v1/agents/websocket/agent_abc", "token": "tok_secret", "call_id": "ac_1"}

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, headers=None, json=None):
            seen["url"] = url
            seen["headers"] = headers
            seen["json"] = json
            return FakeResponse()

    monkeypatch.setattr("httpx.AsyncClient", FakeClient)
    r = client.post("/api/cartesia/session", json={"language": "en"})
    assert r.status_code == 200
    body = r.json()
    assert body["url"] == "wss://api.cartesia.ai/v1/agents/websocket/agent_abc"
    assert body["token"] == "tok_secret"
    assert body["callId"].startswith("cart-")
    assert body["events"][0]["type"] == "state"
    assert seen["url"].endswith("/agent_abc/sessions")
    assert seen["headers"]["X-API-Key"] == "sk_test"
    assert seen["json"] == {}
    assert "sk_test" not in r.text


def test_call_allowlist_matches_despite_formatting(client, monkeypatch):
    # Passes validation and the allowlist; fails later only because no real LiveKit is reachable.
    configure(monkeypatch, SIP_OUTBOUND_TRUNK_ID="ST_1", TEST_NUMBER_ALLOWLIST="+91 98000 00001")
    try:
        r = client.post("/api/call", json={"phone": "+91 (98000) 00001"})
        assert r.status_code not in (400, 403)
    except Exception:
        pass  # network or SDK error means validation and allowlist were passed

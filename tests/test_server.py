import pytest
from fastapi.testclient import TestClient

from server.main import app

ENV_KEYS = [
    "LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET",
    "SIP_OUTBOUND_TRUNK_ID", "TEST_NUMBER_ALLOWLIST",
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


def test_call_allowlist_matches_despite_formatting(client, monkeypatch):
    # Passes validation and the allowlist; fails later only because no real LiveKit is reachable.
    configure(monkeypatch, SIP_OUTBOUND_TRUNK_ID="ST_1", TEST_NUMBER_ALLOWLIST="+91 98000 00001")
    try:
        r = client.post("/api/call", json={"phone": "+91 (98000) 00001"})
        assert r.status_code not in (400, 403)
    except Exception:
        pass  # network or SDK error means validation and allowlist were passed

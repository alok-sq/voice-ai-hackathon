"""Conversation persistence (SSE-15536): Redis buffer -> PostgreSQL log. Uses fakeredis and an in-memory store."""
import asyncio
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

fakeredis = pytest.importorskip("fakeredis")
from redis.exceptions import ConnectionError as RedisConnectionError  # noqa: E402

from agent.conversation.buffer import ConversationBuffer  # noqa: E402
from agent.conversation.log_builder import build_record, build_text_log, next_action, qualification_status  # noqa: E402
from agent.conversation.models import ConversationMeta, ConversationStatus, Message  # noqa: E402
from agent.conversation.persistence import ConversationPersistenceService  # noqa: E402
from agent.conversation.recorder import ConversationRecorder  # noqa: E402
from agent.conversation.store import _upsert_sql  # noqa: E402
from agent.events import EventPublisher  # noqa: E402


def run(coro):
    return asyncio.run(coro)


# ---------- test doubles ----------
class MemoryStore:
    """Stands in for PostgreSQL. Idempotent on conversation_id, like the real upsert."""

    def __init__(self, fail=False):
        self.fail = fail
        self.rows = {}
        self.calls = 0

    async def save(self, record):
        self.calls += 1
        if self.fail:
            raise ConnectionRefusedError("database down")
        existing = self.rows.get(record["conversation_id"])
        if existing is None or existing["message_count"] <= record["message_count"]:
            self.rows[record["conversation_id"]] = record


class FlakyRedis:
    """Wraps fakeredis; when `down` is True every command fails like a lost connection."""

    def __init__(self, real):
        self.real, self.down = real, False

    def _check(self):
        if self.down:
            raise RedisConnectionError("redis down")

    def pipeline(self, *a, **k):
        return _FlakyPipe(self, self.real.pipeline(*a, **k))

    def __getattr__(self, name):
        attr = getattr(self.real, name)
        if not callable(attr):
            return attr

        def call(*a, **k):
            self._check()
            return attr(*a, **k)

        return call


class _FlakyPipe:
    def __init__(self, owner, pipe):
        self.owner, self.pipe = owner, pipe

    async def __aenter__(self):
        await self.pipe.__aenter__()
        return self

    async def __aexit__(self, *exc):
        return await self.pipe.__aexit__(*exc)

    async def execute(self):
        self.owner._check()
        return await self.pipe.execute()

    def __getattr__(self, name):
        return getattr(self.pipe, name)


def setup(store=None, flaky=False, spool_dir=None, stale_after_s=1800.0):
    real = fakeredis.FakeAsyncRedis(decode_responses=True)
    client = FlakyRedis(real) if flaky else real
    buffer = ConversationBuffer(client, persisted_ttl_s=3600)
    store = store if store is not None else MemoryStore()
    service = ConversationPersistenceService(buffer, store, spool_dir=spool_dir, retry_delays_s=(), stale_after_s=stale_after_s)
    return client, real, buffer, store, service


def recorder_for(cid, buffer, service, send=lambda payload, topic: None):
    rec = ConversationRecorder(cid, buffer, service, language="hi", agent_name="solarsquare-lrm", channel="browser")
    pub = EventPublisher(send, listeners=[rec.observe])
    return rec, pub


def say(pub, role, line_id, text, interim=None):
    if interim:
        pub.emit("transcript", role=role, text=interim, final=False, id=line_id)
    pub.emit("transcript", role=role, text=text, final=True, id=line_id)


def short_call(pub):
    pub.emit("system", text="Caller connected")
    pub.emit("state", state="IDENTITY")
    say(pub, "agent", "a1", "Namaste, kya meri baat Mr. Nair se ho rahi hai?", interim="Namaste,")
    say(pub, "caller", "u1", "Haan ji.", interim="Haan")
    pub.emit("lead", field="identity_confirmed", value=True)
    say(pub, "agent", "a2", "Aapka mahine ka bill kitna aata hai?")
    say(pub, "caller", "u2", "Teen hazaar.")
    pub.emit("lead", field="monthly_bill", value=3000)


# ---------- normal conversation ----------
def test_normal_conversation_is_buffered_then_persisted_and_redis_cleaned():
    async def go():
        _, real, buffer, store, service = setup()
        rec, pub = recorder_for("call-1", buffer, service)
        short_call(pub)
        assert await rec.flush()
        assert await real.hlen("conversation:call-1:messages") == 4  # incremental, before the call ends
        assert await buffer.status("call-1") == ConversationStatus.ACTIVE

        pub.emit("outcome", outcome="qualified", reason="all set")
        assert await rec.complete("agent ended the call", result={"outcome": "qualified", "reason": "all set"})

        row = store.rows["call-1"]
        assert row["message_count"] == 4 and row["outcome"] == "qualified"
        assert row["qualification_status"] == "qualified" and row["next_action"] == "Book a site survey"
        assert [m["speaker"] for m in row["transcript"]] == ["agent", "customer", "agent", "customer"]
        assert "AI Agent:" in row["text_log"] and "Customer:" in row["text_log"]
        assert row["lead"] == {"identity_confirmed": True, "monthly_bill": 3000}
        # Redis cleaned only after the DB write: messages gone, short PERSISTED tombstone, not pending.
        assert not await real.exists("conversation:call-1:messages")
        assert await buffer.status("call-1") == ConversationStatus.PERSISTED
        assert 0 < await real.ttl("conversation:call-1:meta") <= 3600
        assert await buffer.pending_ids() == []

    run(go())


def test_message_order_follows_when_each_line_began():
    async def go():
        _, _, buffer, store, service = setup()
        rec, pub = recorder_for("call-order", buffer, service)
        # The agent starts a line, the customer barges in, and the customer's line finishes first.
        pub.emit("transcript", role="agent", text="Aapka ghar", final=False, id="a1")
        pub.emit("transcript", role="caller", text="Ek", final=False, id="u1")
        pub.emit("transcript", role="caller", text="Ek minute.", final=True, id="u1")
        pub.emit("transcript", role="agent", text="Aapka ghar independent hai?", final=True, id="a1")
        say(pub, "caller", "u2", "Haan.")
        await rec.complete("done")
        assert [m["message_id"] for m in store.rows["call-order"]["transcript"]] == ["a1", "u1", "u2"]
        seqs = [m["sequence"] for m in store.rows["call-order"]["transcript"]]
        assert seqs == sorted(seqs)

    run(go())


def test_duplicate_final_event_is_stored_once():
    async def go():
        _, real, buffer, store, service = setup()
        rec, pub = recorder_for("call-dup", buffer, service)
        say(pub, "agent", "a1", "Namaste.")
        pub.emit("transcript", role="agent", text="Namaste.", final=True, id="a1")  # re-sent
        await rec.flush()
        # A second recorder for the same call (e.g. a restarted worker) hits Redis-level dedup.
        rec2, pub2 = recorder_for("call-dup", buffer, service)
        say(pub2, "agent", "a1", "Namaste.")
        await rec2.flush()
        assert await real.hlen("conversation:call-dup:messages") == 1

    run(go())


def test_interim_updates_are_not_stored_as_messages():
    async def go():
        _, real, buffer, _, service = setup()
        rec, pub = recorder_for("call-interim", buffer, service)
        for partial in ("Na", "Nama", "Namaste"):
            pub.emit("transcript", role="agent", text=partial, final=False, id="a1")
        await rec.flush()
        assert await real.hlen("conversation:call-interim:messages") == 0

    run(go())


# ---------- frontend independence ----------
def test_persistence_continues_when_the_console_is_gone():
    async def go():
        _, _, buffer, store, service = setup()

        def broken_send(payload, topic):
            raise RuntimeError("no console subscribed")

        rec, pub = recorder_for("call-noui", buffer, service, send=broken_send)
        short_call(pub)
        assert await rec.complete("caller left")
        assert store.rows["call-noui"]["message_count"] == 4

    run(go())


def test_a_failing_listener_never_breaks_publishing():
    def bad_listener(event):
        raise ValueError("boom")

    pub = EventPublisher(lambda payload, topic: None, listeners=[bad_listener])
    event = pub.emit("transcript", role="agent", text="hi", final=True, id="a1")
    assert event["seq"] == 1 and pub.sent == [event]


# ---------- Redis failures ----------
def test_redis_down_for_the_whole_call_falls_back_to_a_direct_database_write():
    async def go():
        client, _, buffer, store, service = setup(flaky=True)
        client.down = True
        rec, pub = recorder_for("call-noredis", buffer, service)
        short_call(pub)  # must not raise
        assert await rec.flush() is False
        assert await rec.complete("done", result={"outcome": "callback"})
        assert store.rows["call-noredis"]["message_count"] == 4
        assert store.rows["call-noredis"]["qualification_status"] == "needs_review"

    run(go())


def test_redis_outage_mid_call_is_replayed_in_order_after_recovery():
    async def go():
        client, real, buffer, store, service = setup(flaky=True)
        rec, pub = recorder_for("call-blip", buffer, service)
        say(pub, "agent", "a1", "Line one.")
        await rec.flush()
        client.down = True
        say(pub, "caller", "u1", "Line two.")
        say(pub, "agent", "a2", "Line three.")
        assert await rec.flush() is False
        client.down = False
        assert await rec.flush() is True
        assert await real.hlen("conversation:call-blip:messages") == 3
        await rec.complete("done")
        assert [m["text"] for m in store.rows["call-blip"]["transcript"]] == ["Line one.", "Line two.", "Line three."]

    run(go())


# ---------- database failures ----------
def test_database_failure_keeps_the_conversation_in_redis_until_a_retry_succeeds():
    async def go():
        _, real, buffer, store, service = setup(store=MemoryStore(fail=True))
        rec, pub = recorder_for("call-nodb", buffer, service)
        short_call(pub)
        assert await rec.complete("done", result={"outcome": "qualified"}) is False

        assert await buffer.status("call-nodb") == ConversationStatus.COMPLETED_PENDING_PERSISTENCE
        assert await buffer.pending_ids() == ["call-nodb"]
        assert await real.hlen("conversation:call-nodb:messages") == 4
        assert await real.ttl("conversation:call-nodb:messages") == -1  # no TTL while unpersisted
        assert await real.ttl("conversation:call-nodb:meta") == -1

        store.fail = False
        stats = await service.reconcile_once()
        assert stats["persisted"] == 1
        assert store.rows["call-nodb"]["message_count"] == 4
        assert await buffer.status("call-nodb") == ConversationStatus.PERSISTED
        assert not await real.exists("conversation:call-nodb:messages")

    run(go())


def test_persist_is_idempotent_and_locked():
    async def go():
        _, _, buffer, store, service = setup(store=MemoryStore(fail=True))
        rec, pub = recorder_for("call-lock", buffer, service)
        short_call(pub)
        await rec.complete("done")
        store.fail = False
        token = await buffer.acquire_lock("call-lock")  # another worker is persisting it
        assert await service.persist("call-lock") is False
        await buffer.release_lock("call-lock", token)
        assert await service.persist("call-lock") is True
        assert await service.persist("call-lock") is True  # already persisted: no-op
        assert store.calls == 2  # the failed attempt + one successful write

    run(go())


def test_redis_and_database_both_down_spools_to_disk_and_reconciler_recovers(tmp_path):
    async def go():
        client, _, buffer, store, service = setup(store=MemoryStore(fail=True), flaky=True, spool_dir=str(tmp_path))
        client.down = True
        rec, pub = recorder_for("call-spool", buffer, service)
        short_call(pub)
        assert await rec.complete("done") is False
        files = list(tmp_path.glob("*.json"))
        assert len(files) == 1 and json.loads(files[0].read_text())["meta"]["conversation_id"] == "call-spool"

        store.fail, client.down = False, False
        stats = await service.reconcile_once()
        assert stats["spool_persisted"] == 1
        assert store.rows["call-spool"]["message_count"] == 4
        assert list(tmp_path.glob("*.json")) == []

    run(go())


def test_abandoned_active_call_is_finalised_and_persisted_by_the_reconciler():
    async def go():
        _, real, buffer, store, service = setup(stale_after_s=0)
        rec, pub = recorder_for("call-crash", buffer, service)
        short_call(pub)
        await rec.flush()  # worker "crashes" here: complete() never runs
        await asyncio.sleep(0.01)
        stats = await service.reconcile_once()
        assert stats["abandoned"] == 1 and stats["persisted"] == 1
        row = store.rows["call-crash"]
        assert row["message_count"] == 4 and row["end_reason"].startswith("abandoned")
        assert row["qualification_status"] == "needs_review"

    run(go())


def test_upsert_never_replaces_a_fuller_log_with_a_shorter_one():
    assert "WHERE conversation_logs.message_count <= EXCLUDED.message_count" in _upsert_sql()


# ---------- concurrency ----------
def test_simultaneous_calls_are_isolated():
    async def go():
        _, real, buffer, store, service = setup()
        recs = [recorder_for(f"call-{i}", buffer, service) for i in range(3)]

        async def talk(i, rec, pub):
            for n in range(5):
                say(pub, "agent", f"a{n}", f"call {i} agent {n}")
                await asyncio.sleep(0)
                say(pub, "caller", f"u{n}", f"call {i} customer {n}")
                await asyncio.sleep(0)
            return await rec.complete("done")

        assert all(await asyncio.gather(*(talk(i, r, p) for i, (r, p) in enumerate(recs))))
        for i in range(3):
            texts = [m["text"] for m in store.rows[f"call-{i}"]["transcript"]]
            assert len(texts) == 10 and all(t.startswith(f"call {i} ") for t in texts)

    run(go())


# ---------- edge cases ----------
def test_empty_conversation_is_persisted_safely():
    async def go():
        _, _, buffer, store, service = setup()
        rec, _ = recorder_for("call-empty", buffer, service)
        assert await rec.complete("caller hung up")
        row = store.rows["call-empty"]
        assert row["message_count"] == 0 and row["transcript"] == []
        assert "(No conversation was recorded.)" in row["text_log"]
        assert row["next_action"] == "Review the call manually"

    run(go())


def test_complete_is_idempotent():
    async def go():
        _, _, buffer, store, service = setup()
        rec, pub = recorder_for("call-twice", buffer, service)
        say(pub, "agent", "a1", "Hello.")
        assert await rec.complete("done")
        assert await rec.complete("done again") is False
        assert store.calls == 1

    run(go())


def test_recorder_without_redis_or_database_is_a_safe_no_op():
    async def go():
        rec = ConversationRecorder("call-off", None, None)
        assert rec.enabled is False
        rec.observe({"type": "transcript", "role": "agent", "text": "hi", "final": True, "id": "a1", "seq": 1, "ts": 1})
        assert await rec.complete("done") is False

    run(go())


# ---------- text log ----------
def test_text_log_matches_the_agreed_format():
    meta = ConversationMeta(conversation_id="conv_123", started_at_ms=1_790_000_000_000, ended_at_ms=1_790_000_452_000,
                            channel="phone", language="hi", lead={"monthly_bill": 3000, "meeting_slot": {"label": "Tomorrow, 5 pm"}},
                            outcome="qualified")
    msgs = [Message("conv_123", "a1", 1, 1_790_000_000_000, "agent", "Hello, am I speaking with Mr. Nair?"),
            Message("conv_123", "u1", 3, 1_790_000_005_000, "customer", "Yes.")]
    log = build_text_log(meta, msgs)
    assert log.startswith("Conversation ID: conv_123\n")
    assert "Duration: 7m 32s" in log
    assert "[00:00] AI Agent:\nHello, am I speaking with Mr. Nair?" in log
    assert "[00:05] Customer:\nYes." in log
    assert "Conversation Outcome:\nQualified" in log
    assert "Next Action:\nSchedule site survey (Tomorrow, 5 pm)" in log
    assert "- Monthly bill (Rs): 3000" in log


def test_record_contains_structured_and_text_transcript():
    meta = ConversationMeta(conversation_id="c", started_at_ms=1000, ended_at_ms=5000)
    rec = build_record(meta, [Message("c", "a1", 1, 1000, "agent", "Hi")])
    assert rec["transcript"][0]["speaker"] == "agent" and rec["transcript"][0]["timestamp"].endswith("+00:00")
    assert rec["duration_s"] == 4.0 and rec["lead_id"] is None and rec["text_log"]


@pytest.mark.parametrize("outcome,status,action", [
    ("qualified", "qualified", "Book a site survey"),
    ("callback", "needs_review", "Schedule a callback"),
    ("wrong_number", "needs_review", "Verify the lead's number"),
    ("not_qualified", "not_qualified", "Close the lead"),
    ("do_not_call", "not_qualified", "Do not call this number again"),
    (None, "needs_review", "Review the call manually"),
])
def test_outcome_mapping(outcome, status, action):
    assert qualification_status(outcome) == status
    assert next_action(outcome, {}) == action


# ---------- real PostgreSQL (opt-in) ----------
@pytest.mark.skipif(not os.getenv("TEST_DATABASE_URL"), reason="set TEST_DATABASE_URL to run against PostgreSQL")
def test_postgres_store_round_trip():
    from agent.conversation.store import PostgresConversationStore

    async def go():
        store = PostgresConversationStore(os.environ["TEST_DATABASE_URL"])
        meta = ConversationMeta(conversation_id="pytest-roundtrip", started_at_ms=1000, ended_at_ms=2000, outcome="callback")
        await store.save(build_record(meta, [Message("pytest-roundtrip", "a1", 1, 1000, "agent", "Hi")]))
        await store.save(build_record(meta, []))  # shorter retry must not replace the fuller row
        pool = await store._get_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow("SELECT message_count, qualification_status FROM conversation_logs WHERE conversation_id = $1",
                                      "pytest-roundtrip")
            await conn.execute("DELETE FROM conversation_logs WHERE conversation_id = $1", "pytest-roundtrip")
        await store.close()
        assert row["message_count"] == 1 and row["qualification_status"] == "needs_review"

    run(go())


# ---------- agent wiring (needs livekit-agents installed) ----------
def test_call_runtime_finalize_persists_the_conversation():
    pytest.importorskip("livekit.agents")
    from types import SimpleNamespace

    from agent.agent import CallRuntime
    from agent.metrics import CallMetrics
    from agent.tools import CallSession

    async def go(tmp):
        _, _, buffer, store, service = setup()
        rec = ConversationRecorder("room-xyz", buffer, service, language="hi")
        pub = EventPublisher(lambda payload, topic: None, listeners=[rec.observe])
        cs = CallSession("room-xyz", "hi", pub, out_dir=tmp)
        deleted = []

        async def delete_room():
            deleted.append(True)

        runtime = CallRuntime(SimpleNamespace(delete_room=delete_room), SimpleNamespace(), cs, CallMetrics(), recorder=rec)
        say(pub, "agent", "a1", "Namaste.")
        say(pub, "caller", "u1", "Haan ji.")
        await runtime.finalize("caller left")  # no outcome yet: the agent records "callback"
        await runtime.wait_persisted()  # shutdown callback path: must be a no-op now
        return store, deleted

    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        store, deleted = run(go(tmp))
    row = store.rows["room-xyz"]
    assert deleted and row["message_count"] == 2 and row["outcome"] == "callback"
    assert row["end_reason"] == "caller left" and store.calls == 1

"""LiveKit agent worker.

Two pipelines, chosen by job metadata:
  cascade  Sarvam STT -> Gemini -> Cartesia Sonic TTS  (Demo / Live)
  s2s      Gemini native audio, speech in and speech out  (Demo v2)

Run from the repo root:
    PYTHONPATH=src .venv-agent/bin/python -m agent.agent start
The worker registers as AGENT_NAME; the backend dispatches it into each call room
(room metadata = {"language", "pipeline"}).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, AsyncIterable, Dict, Optional

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / ".env", override=True)

from livekit import rtc  # noqa: E402
from livekit.agents import (  # noqa: E402
    Agent,
    AgentSession,
    JobContext,
    JobProcess,
    ModelSettings,
    RunContext,
    StopResponse,
    WorkerOptions,
    cli,
    function_tool,
    llm,
    metrics as lk_metrics,
)
from livekit.agents.types import APIConnectOptions  # noqa: E402
from livekit.agents.voice.agent_session import SessionConnectOptions  # noqa: E402
from livekit.agents.voice.room_io import RoomOptions  # noqa: E402
from livekit.plugins import cartesia, google, sarvam, silero  # noqa: E402

from . import guardrails  # noqa: E402
from .events import COMMANDS_TOPIC, EventPublisher  # noqa: E402
from .metrics import CallMetrics  # noqa: E402
from .pipeline import parse_dispatch_metadata  # noqa: E402
from .prompts import build_system_prompt, next_spoken_question  # noqa: E402
from .tools import CallSession  # noqa: E402

logger = logging.getLogger("agent")

STT_LANGUAGE = {"hi": "hi-IN", "mr": "mr-IN", "ta": "ta-IN", "kn": "kn-IN", "en": "en-IN"}
CARTESIA_LANGUAGE = {"hi": "hi", "mr": "mr", "ta": "ta", "kn": "kn", "en": "en"}
SIP_KIND = rtc.ParticipantKind.PARTICIPANT_KIND_SIP

SILENCE_NUDGE = {
    "hi": "हैलो, क्या आप मुझे सुन पा रहे हैं?",
    "en": "Hello, can you still hear me?",
}
SILENCE_GOODBYE = {
    "hi": "लगता है अभी आप व्यस्त हैं। हम आपको बाद में कॉल करेंगे। धन्यवाद!",
    "en": "It seems you are busy right now. We will call you back later. Thank you!",
}


def _env(name: str, default: str = "") -> str:
    return os.getenv(name) or default


def build_models(language: str):
    """One place to change vendors or models. Keys come from STT_API_KEY / LLM_API_KEY / TTS_API_KEY."""
    stt = sarvam.STT(
        language=STT_LANGUAGE.get(language, "hi-IN"),
        model=_env("STT_MODEL", "saaras:v4"),  # saarika:v2.5 is sunset
        mode=_env("STT_MODE", "codemix"),  # codemix: Hindi in Devanagari, English words in Latin
        api_key=_env("STT_API_KEY") or None,
        high_vad_sensitivity=True,
        flush_signal=True,
    )
    llm_ = google.LLM(
        model=_env("LLM_MODEL", "gemini-3.5-flash-lite"),
        api_key=_env("LLM_API_KEY") or None,
        max_output_tokens=int(_env("LLM_MAX_TOKENS", "80")),
        temperature=0.3,
        # Gemini 3.x thinks by default; that alone is often 1–3 s. "minimal" turns it off.
        thinking_config={"thinking_level": "minimal"},
    )
    tts_kwargs: Dict[str, Any] = dict(
        model=_env("TTS_MODEL", "sonic-3"),
        language=CARTESIA_LANGUAGE.get(language, "hi"),
        api_key=_env("TTS_API_KEY") or None,
        word_timestamps=False,  # Hindi is not supported for aligned timestamps
        text_pacing=False,
    )
    if _env("CARTESIA_VOICE_ID"):
        tts_kwargs["voice"] = _env("CARTESIA_VOICE_ID")
    tts = cartesia.TTS(**tts_kwargs)
    return stt, llm_, tts


def build_s2s(language: str):
    """Gemini Live native audio: one model hears the caller and speaks back."""
    gender = _env("VOICE_GENDER", "female").lower()
    voice = _env("S2S_VOICE") or ("Puck" if gender == "male" else "Kore")
    return google.realtime.RealtimeModel(
        model=_env("S2S_MODEL", "gemini-3.8-live"),
        voice=voice,
        language=STT_LANGUAGE.get(language, "hi-IN"),
        api_key=_env("LLM_API_KEY") or None,
        temperature=0.6,
        vertexai=False,
        api_version="v1beta",
    )


class LeadAgent(Agent):
    def __init__(self, cs: CallSession, ctx: JobContext, call: "CallRuntime") -> None:
        super().__init__(instructions=build_system_prompt(cs.flow.current, cs.lead, cs.language, cs.flow))
        self.cs = cs
        self._ctx = ctx
        self._call = call

    # ---------- tools the LLM may call ----------

    @function_tool
    async def update_lead(self, context: RunContext, field: str, value: str) -> str:
        """Save one answer the caller gave. Call this as soon as you learn a value.

        Args:
            field: One of identity_confirmed, solar_interest, property_type, roof_ownership, roof_access, shadow_free_area, monthly_bill, discom, city_or_pincode, timeline, loan_interest, subsidy_interest, meeting_slot.
            value: The caller's answer in their own words (for example "haan", "3 hazaar", "society mein flat", "MSEDCL"). It is normalised for you.
        """
        before = self.cs.flow.current
        message = self.cs.update_lead(field, value)
        if self.cs.flow.current != before:
            await self._refresh_instructions()
        return message

    @function_tool
    async def end_call(self, context: RunContext, outcome: str, reason: str = "") -> str:
        """End the call with its outcome. Then say a short goodbye.

        Args:
            outcome: One of qualified, not_qualified, callback, wrong_number, do_not_call.
            reason: A few words on why.
        """
        message = self.cs.end_call(outcome, reason)
        if self.cs.result is not None:
            self._call.begin_closing(reason or outcome)
        return message

    @function_tool
    async def handoff_to_human(self, context: RunContext, reason: str) -> str:
        """Hand the call to a person when the caller asks for one or you are stuck.

        Args:
            reason: Why a person is needed.
        """
        message = self.cs.handoff(reason)
        self.cs.end_call("callback", f"handoff: {reason}")
        self._call.begin_closing("handoff")
        return message

    async def _refresh_instructions(self) -> None:
        await self.update_instructions(
            build_system_prompt(self.cs.flow.current, self.cs.lead, self.cs.language, self.cs.flow)
        )

    # ---------- turn hook: hard stop before the LLM answers ----------

    async def on_user_turn_completed(self, turn_ctx: llm.ChatContext, new_message: llm.ChatMessage) -> None:
        text = new_message.text_content or ""
        if text and self.cs.result is None:
            saved = self.cs.apply_turn(text, allow_defer=not _looks_like_side_question(text))
            await self._refresh_instructions()
            if not _looks_like_side_question(text):
                spoken = next_spoken_question(self.cs.flow, self.cs.language)
                if spoken:
                    logger.info("LATENCY skip_llm canned after %s pending=%s", ",".join(saved) or "-", self.cs.flow.pending_field())
                    self._call.speak(spoken, allow_interruptions=True)
                    if self.cs.flow.pending_field() is None and self.cs.result is None:
                        outcome = self.cs.default_outcome()
                        self.cs.end_call(outcome, "wrap-up")
                        self._call.begin_closing(outcome)
                    raise StopResponse()
        if guardrails.is_stop_request(text) and self.cs.result is None:
            self.cs.end_call("do_not_call", "caller asked to stop")
            self._call.begin_closing("do_not_call")
            self._call.speak(guardrails.CLOSING_DNC, allow_interruptions=False, add_to_chat_ctx=False)
            raise StopResponse()

    # ---------- output node: screen every sentence, mirror it to the console ----------

    async def tts_node(self, text: AsyncIterable[str], model_settings: ModelSettings):
        return Agent.default.tts_node(self, self._screen(text), model_settings)

    async def _screen(self, text: AsyncIterable[str]) -> AsyncIterable[str]:
        line_id = self._call.next_agent_line_id()
        spoken = ""
        buf = ""
        flushed = False
        try:
            async for chunk in text:
                buf += chunk
                while True:
                    cut = _flush_at(buf, first=not flushed)
                    if cut is None:
                        break
                    piece, buf = buf[:cut], buf[cut:]
                    flushed = True
                    out = self._check(piece)
                    spoken += out
                    self._call.publish_agent_line(line_id, spoken, final=False)
                    yield out
            if buf.strip():
                out = self._check(buf)
                spoken += out
                yield out
        finally:
            if spoken:
                self._call.publish_agent_line(line_id, spoken, final=True)

    def _check(self, sentence: str) -> str:
        if guardrails.contains_forbidden_claim(sentence):
            self.cs.pub.emit("guardrail", kind=guardrails.claim_kind(sentence), text=sentence.strip()[:200])
            return guardrails.safe_deflection() + " "
        return sentence


def _looks_like_side_question(text: str) -> bool:
    t = (text or "").lower()
    return "?" in t or "kitna" in t or "kitni" in t or "कितना" in t or "कितनी" in t or "क्यों" in t


def _sentence_end(buf: str) -> Optional[int]:
    """Index just past the first sentence boundary in buf, or None. A '.' counts only before whitespace."""
    for i, ch in enumerate(buf):
        if ch in "।?!":
            return i + 1
        if ch == "." and i + 1 < len(buf) and buf[i + 1].isspace():
            return i + 1
    return None


def _flush_at(buf: str, first: bool) -> Optional[int]:
    """Flush TTS as soon as we can. The first chunk starts Cartesia; later chunks wait for a sentence."""
    cut = _sentence_end(buf)
    if cut is not None:
        return cut
    if not first:
        return None
    for i, ch in enumerate(buf):
        if ch in ",;،":
            return i + 1
    if len(buf) >= 12:
        return len(buf)
    return None


class CallRuntime:
    """Wires the session, room and console together for one call."""

    def __init__(
        self,
        ctx: JobContext,
        session: AgentSession,
        cs: CallSession,
        metrics: CallMetrics,
        pipeline: str = "cascade",
    ):
        self.ctx = ctx
        self.session = session
        self.cs = cs
        self.pub = cs.pub
        self.metrics = metrics
        self.pipeline = pipeline
        self._agent_lines = 0
        self._user_lines = 0
        self._user_open: Optional[str] = None
        self._t_user_stop: Optional[float] = None
        self._last_ttft: Optional[float] = None
        self._last_ttfb: Optional[float] = None
        self._last_llm_total: Optional[float] = None
        self._llm_sum: float = 0.0
        self._llm_n: int = 0
        self._last_eou: Optional[float] = None
        self._last_stt_delay: Optional[float] = None
        self._turn_n = 0
        self._closing = False
        self._finalized = False
        self._bye_started = asyncio.Event()
        self._bye_done = asyncio.Event()
        self._silence_busy = False

    # ----- transcript lines -----

    def next_agent_line_id(self) -> str:
        self._agent_lines += 1
        return f"a{self._agent_lines}"

    def publish_agent_line(self, line_id: str, text: str, final: bool) -> None:
        self.pub.remember_line(line_id, "agent", text, final)
        self.pub.emit("transcript", role="agent", text=text, final=final, id=line_id)

    # ----- session events -----

    def attach(self) -> None:
        s = self.session
        s.on("user_input_transcribed", self._on_user_text)
        s.on("user_state_changed", self._on_user_state)
        s.on("agent_state_changed", self._on_agent_state)
        s.on("metrics_collected", self._on_metrics)
        s.on("error", self._on_error)
        s.on("close", lambda ev: asyncio.ensure_future(self.finalize("caller left")))
        if self.pipeline == "s2s":
            s.on("conversation_item_added", self._on_item)

    def speak(self, text: str, *, allow_interruptions: bool = True, add_to_chat_ctx: bool = True) -> None:
        """Cascade uses Cartesia via say(); S2S asks Gemini Live to speak the line."""
        if self.pipeline == "s2s":
            self.session.generate_reply(
                instructions=f"Speak exactly this to the caller, then wait. Do not add extra questions: {text}"
            )
        else:
            self.session.say(text, allow_interruptions=allow_interruptions, add_to_chat_ctx=add_to_chat_ctx)

    def _on_item(self, ev) -> None:
        item = ev.item
        role = getattr(item, "role", None)
        text = (getattr(item, "text_content", None) or "").strip()
        if role != "assistant" or not text:
            return
        if guardrails.contains_forbidden_claim(text):
            self.cs.pub.emit("guardrail", kind=guardrails.claim_kind(text), text=text[:200])
        line_id = self.next_agent_line_id()
        self.publish_agent_line(line_id, text, final=True)

    def _on_user_text(self, ev) -> None:
        text = (ev.transcript or "").strip()
        if not text:
            return
        if self._user_open is None:
            self._user_lines += 1
            self._user_open = f"u{self._user_lines}"
        line_id = self._user_open
        self.pub.remember_line(line_id, "caller", text, ev.is_final)
        self.pub.emit("transcript", role="caller", text=text, final=ev.is_final, id=line_id)
        if ev.is_final:
            self._user_open = None
            self.cs.flow.reset_silence()

    def _on_user_state(self, ev) -> None:
        if ev.new_state == "speaking":
            self.pub.emit("speaking", who="caller")
        elif ev.old_state == "speaking":
            self._t_user_stop = ev.created_at
            self._llm_sum = 0.0
            self._llm_n = 0
            if self.session.agent_state != "speaking":
                self.pub.emit("speaking", who="none")
        if ev.new_state == "away":
            asyncio.ensure_future(self._on_silence())

    def _on_agent_state(self, ev) -> None:
        if ev.new_state == "speaking":
            self.pub.emit("speaking", who="agent")
            if self._t_user_stop is not None:
                reply_ms = max(0.0, (ev.created_at - self._t_user_stop) * 1000)
                self._t_user_stop = None
                self.metrics.record_turn(reply_ms)
                fields: Dict[str, Any] = {"replyMs": round(reply_ms)}
                if self._last_stt_delay is not None:
                    fields["sttMs"] = round(self._last_stt_delay * 1000)
                if self._last_ttft is not None:
                    fields["llmTtftMs"] = round(self._last_ttft * 1000)
                if self._last_ttfb is not None:
                    fields["ttsTtfbMs"] = round(self._last_ttfb * 1000)
                self.pub.emit("metric", **fields)
                self._log_turn(reply_ms)
            if self.cs.result is not None:
                self._bye_started.set()
        elif ev.old_state == "speaking":
            if self.session.user_state == "speaking" and ev.new_state == "listening":
                self.pub.emit("interrupted")
            if self.session.user_state != "speaking":
                self.pub.emit("speaking", who="none")
            if self._bye_started.is_set() and ev.new_state in ("listening", "idle"):
                self._bye_done.set()

    def _on_error(self, ev) -> None:
        err = getattr(ev, "error", ev)
        text = str(err)
        if "credit" in text.lower() or "too low" in text.lower() or "quota" in text.lower():
            text = "The LLM has no quota. Check Gemini billing at aistudio.google.com, then restart the worker."
        elif "404" in text or "Not Found" in text:
            text = (
                "Gemini Live returned 404 for this speech-to-speech model. "
                "Demo v2 needs gemini-3.8-live (set S2S_MODEL). Restart the worker after changing it."
            )
        else:
            text = f"Agent error: {text[:240]}"
        logger.error("session error: %s", err)
        self.pub.emit("system", text=text)

    def _ms(self, seconds: Optional[float]) -> Optional[int]:
        if seconds is None:
            return None
        return round(max(0.0, seconds) * 1000)

    def _log_turn(self, reply_ms: float) -> None:
        self._turn_n += 1
        eou = self._ms(self._last_eou)
        stt = self._ms(self._last_stt_delay)
        llm_ttft = self._ms(self._last_ttft)
        llm_total = self._ms(self._last_llm_total)
        tts = self._ms(self._last_ttfb)
        llm_sum = self._ms(self._llm_sum) if self._llm_n else llm_total
        logger.info(
            "LATENCY turn=%s reply_ms=%s eou_ms=%s stt_ms=%s llm_n=%s llm_ttft_ms=%s llm_sum_ms=%s tts_ttfb_ms=%s",
            self._turn_n,
            round(reply_ms),
            eou,
            stt,
            self._llm_n,
            llm_ttft,
            llm_sum,
            tts,
        )
        parts = [f"reply {round(reply_ms)}ms"]
        if self.pipeline == "s2s":
            parts.append("s2s")
        if eou is not None:
            parts.append(f"eou {eou}")
        if stt is not None:
            parts.append(f"stt {stt}")
        if self._llm_n:
            parts.append(f"llm_n {self._llm_n}")
        if llm_ttft is not None:
            parts.append(f"llm_ttft {llm_ttft}")
        if llm_sum is not None:
            parts.append(f"llm_sum {llm_sum}")
        if tts is not None:
            parts.append(f"tts {tts}")
        self.pub.emit("system", text="LATENCY  " + " · ".join(parts) + "  (ms)")

    def _on_metrics(self, ev) -> None:
        m = ev.metrics
        if isinstance(m, lk_metrics.LLMMetrics):
            self.metrics.tokens_in += m.prompt_tokens
            self.metrics.tokens_out += m.completion_tokens
            if not m.cancelled and m.ttft > 0:
                self._last_ttft = m.ttft
            if not m.cancelled and m.duration > 0:
                self._last_llm_total = m.duration
                self._llm_sum += m.duration
                self._llm_n += 1
            logger.info(
                "LATENCY llm n=%s ttft_ms=%s total_ms=%s tokens_in=%s tokens_out=%s cancelled=%s",
                self._llm_n,
                self._ms(m.ttft),
                self._ms(m.duration),
                m.prompt_tokens,
                m.completion_tokens,
                m.cancelled,
            )
            self._emit_usage()
        elif isinstance(m, lk_metrics.RealtimeModelMetrics):
            self.metrics.tokens_in += m.input_tokens
            self.metrics.tokens_out += m.output_tokens
            if not m.cancelled and m.ttft > 0:
                self._last_ttft = m.ttft
            if not m.cancelled and m.duration > 0:
                self._last_llm_total = m.duration
                self._llm_sum += m.duration
                self._llm_n += 1
            logger.info(
                "LATENCY s2s n=%s ttft_ms=%s total_ms=%s tokens_in=%s tokens_out=%s cancelled=%s",
                self._llm_n,
                self._ms(m.ttft),
                self._ms(m.duration),
                m.input_tokens,
                m.output_tokens,
                m.cancelled,
            )
            self._emit_usage()
        elif isinstance(m, lk_metrics.TTSMetrics):
            self.metrics.tts_characters += m.characters_count
            if m.ttfb > 0:
                self._last_ttfb = m.ttfb
            logger.info(
                "LATENCY tts ttfb_ms=%s audio_ms=%s chars=%s cancelled=%s",
                self._ms(m.ttfb),
                self._ms(m.audio_duration),
                m.characters_count,
                m.cancelled,
            )
            self._emit_usage()
        elif isinstance(m, lk_metrics.STTMetrics):
            self.metrics.stt_seconds += m.audio_duration
            logger.info(
                "LATENCY stt duration_ms=%s audio_ms=%s streamed=%s",
                self._ms(m.duration),
                self._ms(m.audio_duration),
                m.streamed,
            )
            self._emit_usage()
        elif isinstance(m, lk_metrics.EOUMetrics):
            self._last_stt_delay = m.transcription_delay
            self._last_eou = m.end_of_utterance_delay
            logger.info(
                "LATENCY eou wait_ms=%s stt_after_speech_ms=%s turn_hook_ms=%s",
                self._ms(m.end_of_utterance_delay),
                self._ms(m.transcription_delay),
                self._ms(m.on_user_turn_completed_delay),
            )

    def _emit_usage(self) -> None:
        self.pub.emit(
            "usage",
            costInr=self.metrics.cost_inr(),
            llmTokensIn=self.metrics.tokens_in,
            llmTokensOut=self.metrics.tokens_out,
            sttSeconds=round(self.metrics.stt_seconds, 1),
            ttsCharacters=self.metrics.tts_characters,
        )

    # ----- silence: re-prompt, then end with callback -----

    async def _on_silence(self) -> None:
        if self._closing or self._silence_busy:
            return
        self._silence_busy = True
        try:
            if self.cs.flow.silence_strike():
                self.pub.emit("reprompt", attempt=2)
                self.cs.end_call("callback", "caller silent")
                self.begin_closing("silence")
                msg = SILENCE_GOODBYE.get(self.cs.language, SILENCE_GOODBYE["hi"])
                self.speak(msg, allow_interruptions=False, add_to_chat_ctx=False)
            else:
                self.pub.emit("reprompt", attempt=self.cs.flow.silence_count)
                msg = SILENCE_NUDGE.get(self.cs.language, SILENCE_NUDGE["hi"])
                self.speak(msg, allow_interruptions=True, add_to_chat_ctx=True)
        finally:
            await asyncio.sleep(1.0)
            self._silence_busy = False

    # ----- console commands and joins -----

    def on_data(self, packet: rtc.DataPacket) -> None:
        if packet.topic != COMMANDS_TOPIC:
            return
        try:
            cmd = json.loads(packet.data.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return
        if isinstance(cmd, dict) and cmd.get("type") == "handoff_request" and not self._closing:
            reason = str(cmd.get("reason") or "requested from console")
            self.cs.handoff(reason)
            self.cs.end_call("callback", f"handoff: {reason}")
            self.begin_closing("handoff")
            self.session.generate_reply(
                instructions="Politely tell the caller a colleague will take over and call them back shortly. One short sentence, then goodbye."
            )

    def send_snapshot(self) -> None:
        outcome = self.cs.flow.outcome.value if self.cs.flow.outcome else None
        self.pub.snapshot(self.cs.flow.current.value, self.cs.lead.to_json(), outcome)

    def on_participant(self, p: rtc.RemoteParticipant) -> None:
        self.send_snapshot()
        asyncio.get_event_loop().call_later(1.5, self.send_snapshot)  # in case the console was not subscribed yet

    # ----- ending -----

    def begin_closing(self, reason: str) -> None:
        if self._closing:
            return
        self._closing = True
        asyncio.ensure_future(self._close_when_done(reason))

    async def _close_when_done(self, reason: str) -> None:
        try:
            await asyncio.wait_for(self._bye_started.wait(), timeout=12)
            await asyncio.wait_for(self._bye_done.wait(), timeout=25)
        except asyncio.TimeoutError:
            pass
        await asyncio.sleep(0.6)  # let the last audio drain
        await self.finalize(reason)

    async def finalize(self, reason: str) -> None:
        if self._finalized:
            return
        self._finalized = True
        if self.cs.result is None:  # caller hung up before an outcome was recorded
            self.cs.end_call("callback", "caller hung up")
        self.cs.attach_metrics(self.metrics.summary())
        self._emit_usage()
        self.pub.emit("call_ended", reason=reason)
        await asyncio.sleep(0.4)  # give the data packet time to flush
        try:
            await self.ctx.delete_room()
        except Exception:
            logger.exception("delete_room failed")


async def _wait_for_caller(room: rtc.Room, timeout: float = 180.0) -> rtc.RemoteParticipant:
    """The caller is a SIP participant or a `console-*` browser participant. `listener-*` is listen-only."""

    def eligible(p: rtc.RemoteParticipant) -> bool:
        return p.kind == SIP_KIND or p.identity.startswith("console-")

    for p in room.remote_participants.values():
        if eligible(p):
            return p
    fut: "asyncio.Future[rtc.RemoteParticipant]" = asyncio.get_event_loop().create_future()

    def on_join(p: rtc.RemoteParticipant) -> None:
        if eligible(p) and not fut.done():
            fut.set_result(p)

    room.on("participant_connected", on_join)
    try:
        return await asyncio.wait_for(fut, timeout)
    finally:
        room.off("participant_connected", on_join)


async def _wait_until_answered(room: rtc.Room, p: rtc.RemoteParticipant, timeout: float = 90.0) -> None:
    """For phone calls, do not speak until the callee has picked up (sip.callStatus == active)."""
    if p.kind != SIP_KIND or p.attributes.get("sip.callStatus") == "active":
        return
    done: "asyncio.Future[None]" = asyncio.get_event_loop().create_future()

    def on_attrs(_changed: Dict[str, str], who: rtc.Participant) -> None:
        if who.identity == p.identity and who.attributes.get("sip.callStatus") == "active" and not done.done():
            done.set_result(None)

    room.on("participant_attributes_changed", on_attrs)
    try:
        await asyncio.wait_for(done, timeout)
    except asyncio.TimeoutError:
        logger.warning("callee did not answer within %ss", timeout)
    finally:
        room.off("participant_attributes_changed", on_attrs)


def prewarm(proc: JobProcess) -> None:
    proc.userdata["vad"] = silero.VAD.load()


def _build_session(language: str, pipeline: str, vad) -> AgentSession:
    conn = SessionConnectOptions(
        llm_conn_options=APIConnectOptions(max_retry=1, retry_interval=0.4, timeout=6.0),
    )
    if pipeline == "s2s":
        return AgentSession(
            llm=build_s2s(language),
            vad=vad,
            allow_interruptions=True,
            min_interruption_duration=0.3,
            user_away_timeout=float(_env("SILENCE_TIMEOUT_S", "10")),
            max_tool_steps=1,
            conn_options=conn,
        )
    stt, llm_, tts = build_models(language)
    return AgentSession(
        stt=stt,
        llm=llm_,
        tts=tts,
        vad=vad,
        turn_detection="vad",
        allow_interruptions=True,
        min_interruption_duration=0.3,
        min_endpointing_delay=float(_env("MIN_ENDPOINTING_DELAY", "0.15")),
        max_endpointing_delay=float(_env("MAX_ENDPOINTING_DELAY", "0.45")),
        preemptive_generation=True,
        user_away_timeout=float(_env("SILENCE_TIMEOUT_S", "10")),
        max_tool_steps=1,
        conn_options=conn,
    )


async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()
    language, pipeline = parse_dispatch_metadata(ctx.job.metadata)
    call_id = ctx.room.name

    def send(payload: bytes, topic: str):
        return ctx.room.local_participant.publish_data(payload, reliable=True, topic=topic)

    pub = EventPublisher(send)
    cs = CallSession(call_id, language, pub, out_dir=_env("OUT_DIR", "out"))
    metrics = CallMetrics()

    session = _build_session(language, pipeline, ctx.proc.userdata["vad"])
    runtime = CallRuntime(ctx, session, cs, metrics, pipeline=pipeline)
    agent = LeadAgent(cs, ctx, runtime)
    runtime.attach()
    ctx.room.on("data_received", runtime.on_data)
    ctx.room.on("participant_connected", runtime.on_participant)

    pub.emit("system", text=f"Agent joined ({language}, {pipeline}); waiting for the caller")
    caller = await _wait_for_caller(ctx.room)
    await _wait_until_answered(ctx.room, caller)
    pub.emit("system", text="Caller connected")
    pub.emit("state", state=cs.flow.current.value)
    runtime.send_snapshot()

    await session.start(agent=agent, room=ctx.room, room_options=RoomOptions(participant_identity=caller.identity))
    runtime.speak(guardrails.greeting(language), allow_interruptions=False)


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            prewarm_fnc=prewarm,
            agent_name=_env("AGENT_NAME", "solarsquare-lrm"),
        )
    )

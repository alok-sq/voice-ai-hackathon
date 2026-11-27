import { describe, expect, it } from "vitest";
import { eventsFromElevenLabs, outputSampleRate, type ElevenClock } from "./elevenLabsEvents";

const clock = (): ElevenClock => ({ since: null, n: 0 });

describe("eventsFromElevenLabs", () => {
  it("keeps the caller line and the agent line", () => {
    const c = clock();
    expect(
      eventsFromElevenLabs({ type: "user_transcript", user_transcription_event: { user_transcript: "हाँ जी" } }, c, 10),
    ).toEqual([
      { type: "transcript", role: "caller", text: "हाँ जी", final: true, id: "u1" },
      { type: "speaking", who: "none" },
    ]);
    expect(
      eventsFromElevenLabs({ type: "agent_response", agent_response_event: { agent_response: "बताइए।" } }, c, 20)[0],
    ).toMatchObject({ type: "transcript", role: "agent", text: "बताइए।", id: "a2" });
  });

  it("times a reply from the caller transcript to the first audio", () => {
    const c = clock();
    eventsFromElevenLabs({ type: "user_transcript", user_transcription_event: { user_transcript: "Hello" } }, c, 1000);
    expect(eventsFromElevenLabs({ type: "audio", audio_event: { audio_base_64: "aaa" } }, c, 1640)).toEqual([
      { type: "metric", replyMs: 640 },
    ]);
    expect(eventsFromElevenLabs({ type: "audio", audio_event: { audio_base_64: "bbb" } }, c, 1800)).toEqual([]);
  });

  it("marks an interruption and ignores pings", () => {
    const c = clock();
    expect(eventsFromElevenLabs({ type: "interruption" }, c, 1).map((e) => e.type)).toEqual(["interrupted", "speaking"]);
    expect(eventsFromElevenLabs({ type: "ping", ping_event: { event_id: 3 } }, c, 1)).toEqual([]);
  });
});

describe("outputSampleRate", () => {
  it("reads a pcm rate and falls back to 16 kHz", () => {
    expect(outputSampleRate("pcm_24000")).toBe(24000);
    expect(outputSampleRate("ulaw_8000")).toBe(16000);
    expect(outputSampleRate(undefined)).toBe(16000);
  });
});

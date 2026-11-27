import { describe, expect, it } from "vitest";
import { eventsFromCartesia, replyLatency, type OpenTurn, type ReplyClock } from "./cartesiaEvents";

describe("eventsFromCartesia", () => {
  it("streams the agent's words, then keeps the final line", () => {
    const open = new Map<number, OpenTurn>();
    expect(eventsFromCartesia({ type: "turn_started", turn: 2, role: "assistant", start_time: 1 }, open)).toEqual([
      { type: "speaking", who: "agent" },
    ]);
    const partial = eventsFromCartesia({ type: "turn_output_text_delta", turn: 2, role: "assistant", text: "नमस्ते" }, open);
    expect(partial).toEqual([{ type: "transcript", role: "agent", text: "नमस्ते", final: false, id: "a2" }]);
    const more = eventsFromCartesia({ type: "turn_output_text_delta", turn: 2, role: "assistant", text: " जी" }, open);
    expect(more[0]).toMatchObject({ text: "नमस्ते जी", final: false });
    const done = eventsFromCartesia(
      { type: "turn_ended", turn: 2, role: "assistant", text: "नमस्ते जी।", interrupted: false, tool_calls: [] },
      open,
    );
    expect(done).toEqual([
      { type: "transcript", role: "agent", text: "नमस्ते जी।", final: true, id: "a2" },
      { type: "speaking", who: "none" },
    ]);
    expect(open.size).toBe(0);
  });

  it("shows the caller's finished line, not a stream", () => {
    const open = new Map<number, OpenTurn>();
    eventsFromCartesia({ type: "turn_started", turn: 1, role: "user", start_time: 0 }, open);
    const done = eventsFromCartesia(
      { type: "turn_ended", turn: 1, role: "user", text: "नहीं चाहिए", interrupted: false, tool_calls: [] },
      open,
    );
    expect(done[0]).toEqual({ type: "transcript", role: "caller", text: "नहीं चाहिए", final: true, id: "u1" });
  });

  it("marks an interrupted agent line", () => {
    const open = new Map<number, OpenTurn>();
    const done = eventsFromCartesia(
      { type: "turn_ended", turn: 4, role: "assistant", text: "एक फ्री", interrupted: true, tool_calls: [] },
      open,
    );
    expect(done.map((e) => e.type)).toEqual(["transcript", "interrupted", "speaking"]);
  });

  it("times a reply from the caller finishing to the first audio", () => {
    const clock: ReplyClock = { since: null };
    expect(replyLatency({ type: "audio_output", audio: "greet" }, clock, 100)).toBeNull();
    expect(replyLatency({ type: "turn_ended", role: "user", text: "नहीं।", ignored: false }, clock, 1000)).toBeNull();
    expect(replyLatency({ type: "audio_output", audio: "a" }, clock, 1720)).toEqual({ type: "metric", replyMs: 720 });
    expect(replyLatency({ type: "audio_output", audio: "b" }, clock, 1900)).toBeNull();
  });

  it("ignores audio and unknown events", () => {
    const open = new Map<number, OpenTurn>();
    expect(eventsFromCartesia({ type: "audio_output", audio: "abc" }, open)).toEqual([]);
    expect(eventsFromCartesia({ type: "session_ready" }, open)).toEqual([]);
    expect(eventsFromCartesia(null, open)).toEqual([]);
  });
});

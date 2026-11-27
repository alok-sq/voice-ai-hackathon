import { describe, expect, it } from "vitest";
import { initialCallView, type CallView, type TimelineItem } from "./callReducer";
import { addSession, historyStats, parseSessions, sourceLabel, toSession, type SessionMeta, type SessionRecord } from "./sessions";

const meta: SessionMeta = {
  source: "scripted",
  language: "hi",
  scenarioTitle: "Qualified lead",
  caller: { name: "Mr. Nair", phone: "+9198•••521", city: "Pune", source: "Website" },
};
const line = (id: string, final = true): TimelineItem => ({ kind: "line", id, role: "agent", text: "Namaste", final, at: 0 });
const endedView = (patch: Partial<CallView> = {}): CallView => ({
  ...initialCallView,
  phase: "ended",
  startedAt: 1_000,
  endedAt: 27_000,
  timeline: [line("a")],
  lastSeq: 12,
  ...patch,
});
const rec = (id: number, outcome?: "qualified" | "callback", replyMs = 700): SessionRecord =>
  toSession(endedView({ startedAt: id, outcome: outcome ? { outcome } : null, turns: [{ replyMs }] }), meta)!;

describe("toSession", () => {
  it("saves an ended call that has a conversation", () => {
    const s = toSession(endedView(), meta)!;
    expect(s.id).toBe("1000");
    expect(s.caller.name).toBe("Mr. Nair");
    expect(s.view.phase).toBe("ended");
  });
  it("saves a call that failed after talking", () => expect(toSession(endedView({ phase: "error", error: "x" }), meta)).not.toBeNull());
  it("skips a call still in progress", () => expect(toSession(endedView({ phase: "live", endedAt: null }), meta)).toBeNull());
  it("skips a call ended before anyone spoke", () => expect(toSession(endedView({ timeline: [] }), meta)).toBeNull());
  it("drops interim lines and keeps final ones", () =>
    expect(toSession(endedView({ timeline: [line("a"), line("b", false)] }), meta)!.view.timeline.map((t) => t.id)).toEqual(["a"]));
  it("survives a JSON round trip", () => {
    const s = toSession(endedView(), meta)!;
    expect(parseSessions(JSON.stringify([s]))).toEqual([s]);
  });
});

describe("addSession", () => {
  it("puts the newest first", () => expect(addSession([rec(1)], rec(2)).map((s) => s.id)).toEqual(["2", "1"]));
  it("does not save the same call twice", () => expect(addSession([rec(1)], rec(1))).toHaveLength(1));
  it("keeps only the most recent ones", () =>
    expect(addSession([rec(3), rec(2), rec(1)], rec(4), 3).map((s) => s.id)).toEqual(["4", "3", "2"]));
});

describe("parseSessions", () => {
  it("returns nothing for empty or broken storage", () => {
    expect(parseSessions(null)).toEqual([]);
    expect(parseSessions("not json")).toEqual([]);
    expect(parseSessions('{"a":1}')).toEqual([]);
  });
  it("drops malformed records and keeps good ones", () =>
    expect(parseSessions(JSON.stringify([{ id: 5 }, rec(1)])).map((s) => s.id)).toEqual(["1"]));
  // Before the four-source model, "demo" meant scripted playback. Those records always carry a scenario title.
  it("reads an old scripted record saved as demo as scripted", () =>
    expect(parseSessions(JSON.stringify([{ ...rec(1), source: "demo" }]))[0]!.source).toBe("scripted"));
  it("keeps a real-agent demo record (no scenario title) as demo", () =>
    expect(parseSessions(JSON.stringify([{ ...rec(1), source: "demo", scenarioTitle: null }]))[0]!.source).toBe("demo"));
});

describe("sourceLabel", () => {
  it("names the scenario for scripted calls", () => expect(sourceLabel("scripted", "Qualified lead")).toBe("Scripted · Qualified lead"));
  it("names each real-agent path", () => {
    expect(sourceLabel("demo", null)).toBe("Demo · cascaded");
    expect(sourceLabel("demo_v2", null)).toBe("Demo v2 · speech to speech");
    expect(sourceLabel("demo_v3", null)).toBe("Demo v3 · Cartesia agent");
    expect(sourceLabel("demo_v4", null)).toBe("Demo v4 · ElevenLabs agent");
    expect(sourceLabel("live", null)).toBe("Live call");
    expect(sourceLabel("live", "Demo v4")).toBe("Live call · Demo v4");
  });
});

describe("historyStats", () => {
  it("counts outcomes and takes the median reply across every turn", () =>
    expect(historyStats([rec(1, "qualified", 700), rec(2, "qualified", 900), rec(3, "callback", 760), rec(4)])).toEqual({
      total: 4,
      outcomes: { qualified: 2, callback: 1, none: 1 },
      medianReplyMs: 730, // replies 700, 700, 760, 900
    }));
  it("has no median before any reply", () => expect(historyStats([]).medianReplyMs).toBeNull());
});

import { describe, expect, it } from "vitest";
import type { CallEvent } from "../contract/events";
import {
  callReducer,
  initialCallView,
  medianReplyMs,
  momentCounts,
  orbState,
  recordingDisclosed,
  stepStatuses,
  type CallView,
} from "./callReducer";

const T = 1_000;
const live = (): CallView =>
  callReducer(callReducer(initialCallView, { type: "connect", at: T }), { type: "connected", at: T });
const apply = (view: CallView, ...events: CallEvent[]) =>
  events.reduce((v, event) => callReducer(v, { type: "event", event, at: T }), view);
const statusOf = (view: CallView, state: string) => stepStatuses(view).find((s) => s.state === state)?.status;

describe("call lifecycle", () => {
  it("connect starts a fresh call and clears the previous one", () => {
    const old = apply(live(), { type: "lead", field: "monthly_bill", value: 3000 });
    const next = callReducer(old, { type: "connect", at: T + 5 });
    expect(next.phase).toBe("connecting");
    expect(next.lead).toEqual({});
    expect(next.timeline).toEqual([]);
  });

  it("ignores events when no call is running", () => {
    expect(apply(initialCallView, { type: "state", state: "BILL" })).toBe(initialCallView);
    const ended = callReducer(live(), { type: "end", reason: "Call ended by you", at: T });
    expect(apply(ended, { type: "lead", field: "monthly_bill", value: 3000 }).lead).toEqual({});
  });

  it("accepts events that arrive while still connecting", () => {
    const connecting = callReducer(initialCallView, { type: "connect", at: T });
    expect(apply(connecting, { type: "state", state: "IDENTITY" }).flowState).toBe("IDENTITY");
  });

  it("a call_ended event ends the call with its reason", () => {
    const v = apply(live(), { type: "call_ended", reason: "Caller hung up" });
    expect(v.phase).toBe("ended");
    expect(v.endReason).toBe("Caller hung up");
  });

  it("shows why the call ended in the timeline", () => {
    const byAgent = apply(live(), { type: "call_ended", reason: "Caller hung up" });
    expect(byAgent.timeline.at(-1)).toMatchObject({ kind: "system", text: "Caller hung up" });
    const byYou = callReducer(live(), { type: "end", reason: "Call ended by you", at: T });
    expect(byYou.timeline.at(-1)).toMatchObject({ kind: "system", text: "Call ended by you" });
  });

  it("end is a no-op once the call is over", () => {
    const ended = callReducer(live(), { type: "end", reason: "first", at: T });
    expect(callReducer(ended, { type: "end", reason: "second", at: T })).toBe(ended);
  });
});

describe("events", () => {
  it("drops events whose seq was already seen", () => {
    const v = apply(
      live(),
      { type: "lead", field: "monthly_bill", value: 3000, seq: 2 },
      { type: "lead", field: "monthly_bill", value: 9999, seq: 2 },
      { type: "lead", field: "monthly_bill", value: 1, seq: 1 },
    );
    expect(v.lead.monthly_bill).toBe(3000);
  });

  it("updates an interim transcript line in place when the id repeats", () => {
    const v = apply(
      live(),
      { type: "transcript", role: "caller", text: "bill around", final: false, id: "u1" },
      { type: "transcript", role: "caller", text: "bill around 3 hazaar aata hai", final: true, id: "u1" },
    );
    expect(v.timeline).toHaveLength(1);
    expect(v.timeline[0]).toMatchObject({ kind: "line", text: "bill around 3 hazaar aata hai", final: true });
  });

  it("gives lines without an id their own entry", () => {
    const v = apply(
      live(),
      { type: "transcript", role: "agent", text: "Namaste", final: true },
      { type: "transcript", role: "caller", text: "Haan ji", final: true },
    );
    expect(v.timeline).toHaveLength(2);
  });

  it("records robustness moments as timeline markers", () => {
    const v = apply(
      live(),
      { type: "interrupted" },
      { type: "guardrail", kind: "subsidy" },
      { type: "reprompt", attempt: 1 },
      { type: "handoff", reason: "Caller asked for a person" },
    );
    expect(v.timeline.map((i) => (i.kind === "marker" ? i.marker : i.kind))).toEqual([
      "interrupted",
      "guardrail",
      "reprompt",
      "handoff",
    ]);
    expect(v.handoff).toBe("Caller asked for a person");
  });

  it("a late do_not_call outcome replaces an earlier qualified one", () => {
    const v = apply(live(), { type: "outcome", outcome: "qualified" }, { type: "outcome", outcome: "do_not_call" });
    expect(v.outcome?.outcome).toBe("do_not_call");
  });

  it("a snapshot replaces the lead, state, outcome and transcript", () => {
    const v = apply(
      apply(live(), { type: "lead", field: "discom", value: "Stale" }),
      {
        type: "snapshot",
        state: "BILL",
        lead: { identity_confirmed: true, solar_interest: true },
        outcome: null,
        transcript: [{ id: "a1", role: "agent", text: "Namaste", final: true }],
        seq: 10,
      },
    );
    expect(v.flowState).toBe("BILL");
    expect(v.lead).toEqual({ identity_confirmed: true, solar_interest: true });
    expect(v.timeline.some((i) => i.kind === "line" && i.text === "Namaste")).toBe(true);
    expect(apply(v, { type: "state", state: "IDENTITY", seq: 9 }).flowState).toBe("BILL");
  });
});

describe("step statuses", () => {
  it("marks the current state as current", () => {
    expect(statusOf(apply(live(), { type: "state", state: "BILL" }), "BILL")).toBe("current");
  });

  it("derives done and partial from captured fields, not from state order", () => {
    const v = apply(
      live(),
      { type: "state", state: "BILL" },
      { type: "lead", field: "identity_confirmed", value: true },
      { type: "lead", field: "property_type", value: "independent_house" },
    );
    expect(statusOf(v, "IDENTITY")).toBe("done");
    expect(statusOf(v, "PROPERTY")).toBe("partial");
    expect(statusOf(v, "INTEREST")).toBe("pending");
  });

  it("does not paint unvisited steps green when a short call ends", () => {
    const v = apply(
      live(),
      { type: "state", state: "IDENTITY" },
      { type: "outcome", outcome: "wrong_number" },
      { type: "state", state: "DONE" },
    );
    expect(statusOf(v, "IDENTITY")).toBe("skipped");
    expect(statusOf(v, "MEETING_PITCH")).toBe("skipped");
    expect(statusOf(v, "WRAP_UP")).toBe("skipped");
  });

  it("marks wrap-up done once it was visited and the call moved on", () => {
    const v = apply(live(), { type: "state", state: "WRAP_UP" }, { type: "state", state: "DONE" });
    expect(statusOf(v, "WRAP_UP")).toBe("done");
  });
});

describe("orb state", () => {
  it("follows the call phase and who is speaking", () => {
    expect(orbState(initialCallView)).toBe("idle");
    expect(orbState(callReducer(initialCallView, { type: "connect", at: T }))).toBe("connecting");
    expect(orbState(live())).toBe("listening");
    expect(orbState(apply(live(), { type: "speaking", who: "agent" }))).toBe("agent");
    expect(orbState(apply(live(), { type: "speaking", who: "caller" }))).toBe("caller");
    expect(orbState(apply(live(), { type: "speaking", who: "agent" }, { type: "call_ended", reason: "x" }))).toBe("ended");
  });
});

describe("recording disclosure", () => {
  it("is detected once the agent says the call is recorded, in Hindi or English", () => {
    expect(recordingDisclosed(live())).toBe(false);
    expect(recordingDisclosed(apply(live(), { type: "transcript", role: "caller", text: "kya yeh record ho raha hai?", final: true }))).toBe(false);
    expect(recordingDisclosed(apply(live(), { type: "transcript", role: "agent", text: "Yeh call record ho rahi hai.", final: true }))).toBe(true);
    expect(recordingDisclosed(apply(live(), { type: "transcript", role: "agent", text: "This call is being recorded.", final: true }))).toBe(true);
  });
});

describe("moment counts", () => {
  it("counts robustness moments by kind", () => {
    const v = apply(live(), { type: "interrupted" }, { type: "interrupted" }, { type: "guardrail", kind: "subsidy" });
    expect(momentCounts(v)).toEqual({ interrupted: 2, guardrail: 1, reprompt: 0, handoff: 0 });
  });
});

describe("metrics", () => {
  it("computes the median reply time", () => {
    const v = apply(live(), { type: "metric", replyMs: 900 }, { type: "metric", replyMs: 500 }, { type: "metric", replyMs: 700 });
    expect(medianReplyMs(v.turns)).toBe(700);
    const even = apply(v, { type: "metric", replyMs: 600 });
    expect(medianReplyMs(even.turns)).toBe(650);
    expect(medianReplyMs([])).toBeNull();
  });
});

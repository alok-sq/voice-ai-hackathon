import { describe, expect, it } from "vitest";
import { parseEvent, type CallEvent, type Outcome } from "../../contract/events";
import { callReducer, initialCallView, momentCounts } from "../../state/callReducer";
import { SCENARIOS } from "./scenarios";

/** Plays a scenario straight through the reducer, as the console would. */
function play(id: string) {
  const scenario = SCENARIOS.find((s) => s.id === id)!;
  let view = callReducer(callReducer(initialCallView, { type: "connect", at: 0 }), { type: "connected", at: 0 });
  for (const [, events] of scenario.script) for (const event of events) view = callReducer(view, { type: "event", event, at: 0 });
  return view;
}

const EXPECTED: Record<string, Outcome> = {
  "happy-path": "qualified",
  "interrupts-code-mix": "qualified",
  "subsidy-question": "qualified",
  silence: "callback",
  "ask-my-son": "callback",
  "do-not-call": "do_not_call",
  "wrong-number": "wrong_number",
  "not-qualified": "not_qualified",
};

describe("demo scenarios", () => {
  it("covers every outcome in the brief", () => {
    expect(new Set(Object.values(EXPECTED))).toEqual(new Set(["qualified", "not_qualified", "callback", "wrong_number", "do_not_call"]));
    expect(SCENARIOS.map((s) => s.id).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(SCENARIOS.map((s) => [s.id, s] as const))("%s: every event matches the contract", (_id, scenario) => {
    const events: CallEvent[] = scenario.script.flatMap(([, e]) => e);
    for (const e of events) expect(parseEvent(JSON.parse(JSON.stringify(e))), JSON.stringify(e)).not.toBeNull();
  });

  it.each(Object.entries(EXPECTED))("%s ends the call with outcome %s", (id, outcome) => {
    const view = play(id);
    expect(view.outcome?.outcome).toBe(outcome);
    expect(view.phase).toBe("ended");
  });

  it.each(SCENARIOS.map((s) => [s.id] as const))("%s: the agent discloses recording in its first line", (id) => {
    const scenario = SCENARIOS.find((s) => s.id === id)!;
    const first = scenario.script.flatMap(([, e]) => e).find((e) => e.type === "transcript" && e.role === "agent");
    expect(first && first.type === "transcript" && /record/i.test(first.text)).toBe(true);
  });

  it("shows the robustness moments each scenario is about", () => {
    expect(momentCounts(play("interrupts-code-mix")).interrupted).toBeGreaterThanOrEqual(2);
    expect(momentCounts(play("subsidy-question")).guardrail).toBeGreaterThanOrEqual(2);
    expect(momentCounts(play("silence")).reprompt).toBe(2);
  });

  it("normalises code-mixed amounts to integers", () => {
    expect(play("interrupts-code-mix").lead.monthly_bill).toBe(3500);
  });

  it("does not record answers from the wrong person", () => {
    const lead = play("ask-my-son").lead;
    expect(lead.identity_confirmed).toBe(false);
    expect(Object.keys(lead)).toEqual(["identity_confirmed"]);
  });

  it("never states a subsidy or savings figure in agent lines", () => {
    for (const s of SCENARIOS) {
      for (const e of s.script.flatMap(([, ev]) => ev)) {
        if (e.type === "transcript" && e.role === "agent") expect(e.text, `${s.id}: ${e.text}`).not.toMatch(/₹|\d[\d,]*\s*(rupaye|hazaar|thousand)/i);
      }
    }
  });
});

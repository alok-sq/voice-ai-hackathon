import { describe, expect, it } from "vitest";
import { initialCallView, type CallView } from "../state/callReducer";
import { formatDuration, formatWhen, nextAction, summaryFacts, summaryText } from "./summary";

const ended = (patch: Partial<CallView>): CallView => ({ ...initialCallView, phase: "ended", startedAt: 0, endedAt: 26_000, ...patch });

describe("formatDuration", () => {
  it("formats minutes and seconds", () => expect(formatDuration(26_400)).toBe("00:26"));
  it("handles over a minute", () => expect(formatDuration(125_000)).toBe("02:05"));
  it("never goes negative", () => expect(formatDuration(-5)).toBe("00:00"));
});

describe("formatWhen", () => {
  const now = new Date(2026, 10, 26, 18, 0).getTime();
  it("says Today for a call earlier today", () => expect(formatWhen(new Date(2026, 10, 26, 17, 42).getTime(), now)).toBe("Today, 5:42 pm"));
  it("uses the date for an older call", () => expect(formatWhen(new Date(2026, 10, 24, 9, 5).getTime(), now)).toBe("24 Nov, 9:05 am"));
});

describe("summaryFacts", () => {
  it("lists only what was captured, in reading order", () =>
    expect(
      summaryFacts({ property_type: "independent_house", roof_ownership: "owned", monthly_bill: 3000, city_or_pincode: "Pune", subsidy_interest: true }),
    ).toEqual(["Independent house", "Owned roof", "₹3,000/month", "Pune", "Wants subsidy info"]));
  it("leaves out identity, interest and the meeting slot", () =>
    expect(summaryFacts({ identity_confirmed: true, solar_interest: true, meeting_slot: { label: "Tomorrow, 5 pm" } })).toEqual([]));
  it("states negative answers plainly", () =>
    expect(summaryFacts({ roof_access: false, loan_interest: false })).toEqual(["No roof access", "No loan"]));
});

describe("nextAction", () => {
  it("names the booked survey for a qualified lead", () =>
    expect(nextAction(ended({ outcome: { outcome: "qualified" }, lead: { meeting_slot: { label: "Tomorrow, 5 pm", location: "Home" } } }))).toEqual({
      headline: "Survey booked: Tomorrow, 5 pm · Home",
    }));
  it("says when to call back, with the reason", () =>
    expect(nextAction(ended({ outcome: { outcome: "callback", callbackAt: "Today, 7 pm", reason: "Asked to call her son." } }))).toEqual({
      headline: "Call back: Today, 7 pm",
      detail: "Asked to call her son.",
    }));
  it("gives the reason a lead did not qualify", () =>
    expect(nextAction(ended({ outcome: { outcome: "not_qualified", reason: "Tenant with no roof rights." } })).headline).toBe("Tenant with no roof rights."));
  it("confirms do-not-call", () => expect(nextAction(ended({ outcome: { outcome: "do_not_call" } })).headline).toBe("Added to do-not-call. No more calls."));
  it("flags a wrong number", () => expect(nextAction(ended({ outcome: { outcome: "wrong_number" } })).headline).toBe("Number doesn't belong to the lead."));
  it("says when a call ended without an outcome", () => expect(nextAction(ended({})).headline).toBe("Ended before an outcome."));
  it("reports a failed call", () => expect(nextAction(ended({ phase: "error", error: "Network lost" })).headline).toBe("Call failed: Network lost"));
});

describe("summaryText", () => {
  it("is plain text ready to paste", () => {
    const view = ended({
      outcome: { outcome: "qualified" },
      lead: { monthly_bill: 3000, meeting_slot: { label: "Tomorrow, 5 pm" } },
      turns: [{ replyMs: 700 }, { replyMs: 760 }],
      usage: { costInr: 2.4 },
    });
    expect(summaryText({ view, callerName: "Mr. Nair", city: "Pune", language: "Hindi" })).toBe(
      ["Pari call · Qualified", "Mr. Nair · Pune · Hindi · 00:26", "Survey booked: Tomorrow, 5 pm", "₹3,000/month", "Median reply 730 ms · Cost ₹2.40 · 1 of 8 steps"].join("\n"),
    );
  });
});

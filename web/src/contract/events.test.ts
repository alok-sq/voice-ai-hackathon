import { describe, expect, it } from "vitest";
import { parseEvent } from "./events";

describe("parseEvent", () => {
  it("accepts the original README event shapes without seq or ts", () => {
    expect(parseEvent({ type: "state", state: "BILL" })).toEqual({ type: "state", state: "BILL" });
    expect(parseEvent({ type: "metric", replyMs: 740 })).not.toBeNull();
    expect(parseEvent({ type: "transcript", role: "caller", text: "Haan ji", final: true })).not.toBeNull();
  });

  it("accepts a lead value of the right type", () => {
    expect(parseEvent({ type: "lead", field: "monthly_bill", value: 3000 })).not.toBeNull();
    expect(parseEvent({ type: "lead", field: "meeting_slot", value: { label: "Tomorrow, 5 pm", location: "Home" } })).not.toBeNull();
  });

  it("rejects a lead value of the wrong type", () => {
    expect(parseEvent({ type: "lead", field: "monthly_bill", value: "3 hazaar" })).toBeNull();
    expect(parseEvent({ type: "lead", field: "property_type", value: "flat" })).toBeNull();
  });

  it("rejects unknown lead fields, unknown types and junk", () => {
    expect(parseEvent({ type: "lead", field: "favourite_colour", value: "blue" })).toBeNull();
    expect(parseEvent({ type: "dance" })).toBeNull();
    expect(parseEvent(null)).toBeNull();
    expect(parseEvent("state")).toBeNull();
    expect(parseEvent({ type: "outcome", outcome: "maybe" })).toBeNull();
  });

  it("rejects a non-numeric seq", () => {
    expect(parseEvent({ type: "state", state: "BILL", seq: "3" })).toBeNull();
  });

  it("drops badly typed fields inside a snapshot lead instead of rejecting the snapshot", () => {
    const e = parseEvent({ type: "snapshot", state: "BILL", lead: { monthly_bill: 3000, discom: 42 } });
    expect(e).toEqual({ type: "snapshot", state: "BILL", lead: { monthly_bill: 3000 } });
  });
});

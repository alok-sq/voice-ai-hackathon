import { describe, expect, it } from "vitest";
import { capturedCount, isBlocking, newlyFull } from "./lead";

describe("capturedCount", () => {
  it("is zero for an empty lead", () => expect(capturedCount({})).toBe(0));
  it("counts each captured field once", () =>
    expect(capturedCount({ identity_confirmed: true, monthly_bill: 3200 })).toBe(2));
  it("counts a false answer as captured", () => expect(capturedCount({ solar_interest: false })).toBe(1));
});

describe("isBlocking", () => {
  it("rules out the wrong person", () => expect(isBlocking("identity_confirmed", false)).toBe(true));
  it("rules out a caller who is not interested", () => expect(isBlocking("solar_interest", false)).toBe(true));
  it("rules out a rented roof", () => expect(isBlocking("roof_ownership", "rented")).toBe(true));
  it("rules out no roof access", () => expect(isBlocking("roof_access", false)).toBe(true));
  it("accepts a confirmed identity", () => expect(isBlocking("identity_confirmed", true)).toBe(false));
  it("accepts an owned roof", () => expect(isBlocking("roof_ownership", "owned")).toBe(false));
  it("treats declining a loan as a preference, not a failure", () => expect(isBlocking("loan_interest", false)).toBe(false));
});

describe("newlyFull", () => {
  it("returns the cells that just became full", () =>
    expect(newlyFull(["full", "partial", "empty"], ["full", "full", "full"])).toEqual([1, 2]));
  it("ignores cells that were already full or are not full yet", () =>
    expect(newlyFull(["full", "empty"], ["full", "partial"])).toEqual([]));
});

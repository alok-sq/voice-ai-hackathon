import { describe, expect, it } from "vitest";
import { capturedCount } from "./lead";

describe("capturedCount", () => {
  it("is zero for an empty lead", () => expect(capturedCount({})).toBe(0));
  it("counts each captured field once", () =>
    expect(capturedCount({ identity_confirmed: true, monthly_bill: 3200 })).toBe(2));
  it("counts a false answer as captured", () => expect(capturedCount({ solar_interest: false })).toBe(1));
});

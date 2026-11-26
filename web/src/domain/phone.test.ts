import { describe, expect, it } from "vitest";
import { isValidPhone, maskPhone } from "./phone";

describe("isValidPhone", () => {
  it("accepts a number with country code and spaces", () => expect(isValidPhone("+91 98765 43210")).toBe(true));
  it("accepts dashes as separators", () => expect(isValidPhone("+91-98765-43210")).toBe(true));
  it("rejects a number that is too short", () => expect(isValidPhone("12345")).toBe(false));
  it("rejects letters", () => expect(isValidPhone("98765abcde")).toBe(false));
});

describe("maskPhone", () => {
  it("keeps the first five and last three characters", () => expect(maskPhone("+91 98765 43521")).toBe("+9198•••521"));
  it("leaves very short input as typed", () => expect(maskPhone("123")).toBe("123"));
});

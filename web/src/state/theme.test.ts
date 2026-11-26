import { describe, expect, it } from "vitest";
import { parseTheme, resolveTheme } from "./theme";

describe("resolveTheme", () => {
  it("a saved choice beats the system", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
  it("no saved choice follows the system", () => {
    expect(resolveTheme(null, true)).toBe("dark");
    expect(resolveTheme(null, false)).toBe("light");
  });
});

describe("parseTheme", () => {
  it("ignores anything stored that is not a theme", () => {
    expect(parseTheme(null)).toBeNull();
    expect(parseTheme("blue")).toBeNull();
    expect(parseTheme("Dark")).toBeNull();
    expect(parseTheme("dark")).toBe("dark");
  });
});

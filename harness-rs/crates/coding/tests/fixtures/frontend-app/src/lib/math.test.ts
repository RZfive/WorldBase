import { describe, expect, it } from "vitest";
import { add, clamp, formatCount, multiply } from "./math";

describe("math", () => {
  it("adds numbers", () => {
    expect(add(2, 3)).toBe(5);
  });

  it("multiplies numbers", () => {
    expect(multiply(4, 5)).toBe(20);
  });

  it("formats singular and plural counts", () => {
    expect(formatCount(1)).toBe("1 item");
    expect(formatCount(2)).toBe("2 items");
  });

  it("clamps values", () => {
    expect(clamp(12, 0, 10)).toBe(10);
  });
});

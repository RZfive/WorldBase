import { describe, expect, it } from "vitest";
import { formatDate, formatSessionCount, truncate } from "../src/lib/format";

describe("format", () => {
  it("formats session counts", () => {
    expect(formatSessionCount(1)).toBe("1 session");
    expect(formatSessionCount(3)).toBe("3 sessions");
  });

  it("truncates long text", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
  });

  it("formats ISO dates", () => {
    expect(formatDate("2026-03-04T10:20:30.000Z")).toBe("2026-03-04");
  });
});

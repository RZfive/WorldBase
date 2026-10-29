import { describe, expect, it } from "vitest";
import { isEmail, isRole, validateUser } from "../src/lib/validation";

describe("validation", () => {
  it("recognizes roles", () => {
    expect(isRole("admin")).toBe(true);
    expect(isRole("owner")).toBe(false);
  });

  it("validates email addresses", () => {
    expect(isEmail("dev@example.com")).toBe(true);
    expect(isEmail("not-an-email")).toBe(false);
  });

  it("reports missing user fields", () => {
    expect(validateUser({})).toEqual(["name is required", "email is invalid"]);
  });
});

import type { Role, User } from "../types/models";

export function isRole(value: string): value is Role {
  return value === "admin" || value === "editor" || value === "viewer";
}

export function isEmail(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

export function validateUser(user: Partial<User>): string[] {
  const errors: string[] = [];
  if (!user.name?.trim()) {
    errors.push("name is required");
  }
  if (!user.email || !isEmail(user.email)) {
    errors.push("email is invalid");
  }
  return errors;
}

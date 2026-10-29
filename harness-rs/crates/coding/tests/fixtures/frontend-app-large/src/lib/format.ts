import type { User } from "../types/models";

export function formatName(user: User): string {
  return `${user.name} <${user.email}>`;
}

export function formatDate(value: string): string {
  const date = new Date(value);
  return date.toISOString().slice(0, 10);
}

export function truncate(value: string, length = 80): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

export function formatSessionCount(count: number): string {
  return count === 1 ? "1 session" : `${count} sessions`;
}

export function describeSessions(count: number): string {
  return `Active: ${formatSessionCount(count)}`;
}

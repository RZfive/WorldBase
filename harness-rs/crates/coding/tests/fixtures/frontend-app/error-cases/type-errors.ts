import { add, formatCount } from "../src/lib/math";

export function summarize(total: number): string {
  const label = missingLabel;
  return formatCount(total) + label;
}

export function displayName(user: { id: string }): string {
  return user.name;
}

export function priceLabel(value: string): string {
  return `$${add(value, 1)}`;
}

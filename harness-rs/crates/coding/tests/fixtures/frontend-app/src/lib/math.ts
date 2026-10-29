export function add(left: number, right: number): number {
  return left + right;
}

export function multiply(left: number, right: number): number {
  return left * right;
}

export function formatCount(count: number): string {
  return count === 1 ? "1 item" : `${count} items`;
}

export function describeCount(count: number): string {
  return `Count: ${formatCount(count)}`;
}

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

export function legacyTotal(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export const average = (values: number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  return sum(values) / values.length;
};

export function percentage(value: number, total: number): number {
  if (total === 0) {
    return 0;
  }
  return clamp((value / total) * 100, 0, 100);
}

export function deprecatedScore(value: number): number {
  return value * 100;
}

import { clamp } from "../src/lib/math";
import { MissingModel } from "../src/types/does-not-exist";

export function configure(port: string): MissingModel {
  const label: number = "not-a-number";
  clamp(0, 10);
  return label;
}

export function implicit(value) {
  return value;
}

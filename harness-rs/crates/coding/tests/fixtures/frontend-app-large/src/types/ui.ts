import type { Role } from "./models";

export type Size = "small" | "medium" | "large";

export interface SelectOption<T = string> {
  label: string;
  value: T;
}

export interface NavItem {
  label: string;
  href: string;
  roles?: Role[];
}

export type ToastKind = "info" | "success" | "error";

import { SessionList } from "../features/session/SessionList";
import { LoginForm } from "../features/auth/LoginForm";
import type { NavItem } from "../types/ui";

export const routes: NavItem[] = [
  { label: "Sessions", href: "/sessions" },
  { label: "Login", href: "/login", roles: ["admin", "editor"] },
];

export function describeRoute(item: NavItem): string {
  return `${item.label} -> ${item.href}`;
}

export const routeLabels = routes.map((route) => route.label);

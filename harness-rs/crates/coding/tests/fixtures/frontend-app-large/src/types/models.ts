export interface User {
  id: string;
  name: string;
  email: string;
}

export interface Session {
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

export type Role = "admin" | "editor" | "viewer";

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
}

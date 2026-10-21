export interface User {
  id: string;
  name: string;
  email?: string;
}

export interface ApiResult<T> {
  data: T;
  error: string | null;
}

export type Theme = "light" | "dark";

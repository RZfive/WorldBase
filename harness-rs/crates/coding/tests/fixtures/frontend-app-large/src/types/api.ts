import type { Paginated, Session, User } from "./models";

export interface ApiError {
  status: number;
  message: string;
}

export interface AuthResponse {
  token: string;
  user: User;
}

export type UserListResponse = Paginated<User>;
export type SessionListResponse = Paginated<Session>;

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

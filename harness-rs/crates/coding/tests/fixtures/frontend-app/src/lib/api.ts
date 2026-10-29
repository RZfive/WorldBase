import type { ApiResult, User } from "./types";

const API_BASE = "/api";

export class ApiClient {
  constructor(private readonly baseUrl: string) {}

  async getJson<T>(path: string): Promise<ApiResult<T>> {
    const response = await fetch(`${this.baseUrl}${path}`);
    if (!response.ok) {
      return { data: null as unknown as T, error: `Request failed: ${response.status}` };
    }
    return { data: (await response.json()) as T, error: null };
  }
}

export async function fetchUser(id: string): Promise<ApiResult<User>> {
  return new ApiClient(API_BASE).getJson<User>(`/users/${id}`);
}

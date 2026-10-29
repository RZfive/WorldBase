import type { ApiClient as ApiClientContract } from "../types/api";
import type { Paginated, Session, User } from "../types/models";

const API_ROOT = "/api";

export class FetchApiClient implements ApiClientContract {
  constructor(private readonly root: string = API_ROOT) {}

  async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.root}${path}`);
    if (!response.ok) {
      throw new Error(`GET ${path} failed with ${response.status}`);
    }
    return (await response.json()) as T;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.root}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`POST ${path} failed with ${response.status}`);
    }
    return (await response.json()) as T;
  }
}

export async function listUsers(client: ApiClientContract): Promise<Paginated<User>> {
  return client.get<Paginated<User>>("/users");
}

export async function listSessions(client: ApiClientContract): Promise<Paginated<Session>> {
  return client.get<Paginated<Session>>("/sessions");
}

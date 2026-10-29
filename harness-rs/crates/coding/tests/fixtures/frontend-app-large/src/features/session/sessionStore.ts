import type { Session } from "../../types/models";

export interface SessionStore {
  save(session: Session): void;
  list(): Session[];
  remove(id: string): void;
}

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();

  save(session: Session): void {
    this.sessions.set(session.id, session);
  }

  list(): Session[] {
    return Array.from(this.sessions.values());
  }

  remove(id: string): void {
    this.sessions.delete(id);
  }
}

export const sessionStore: SessionStore = new MemorySessionStore();

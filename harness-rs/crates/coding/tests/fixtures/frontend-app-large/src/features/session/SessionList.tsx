import { useMemo } from "react";
import { List } from "../../components/List";
import { formatDate } from "../../lib/format";
import type { Session } from "../../types/models";

export interface SessionListProps {
  sessions: Session[];
}

export function SessionList({ sessions }: SessionListProps) {
  const items = useMemo(
    () =>
      sessions.map((session) => ({
        id: session.id,
        label: formatDate(session.createdAt),
      })),
    [sessions],
  );

  return <List items={items} empty={<p>No sessions</p>} />;
}

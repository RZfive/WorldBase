import type { ReactNode } from "react";

export interface ListItem {
  id: string;
  label: string;
}

export interface ListProps<T extends ListItem> {
  items: T[];
  empty?: ReactNode;
  renderItem?: (item: T) => ReactNode;
}

export function List<T extends ListItem>({ items, empty = null, renderItem }: ListProps<T>) {
  if (items.length === 0) {
    return <>{empty}</>;
  }

  return (
    <ul className="list">
      {items.map((item) => (
        <li key={item.id}>{renderItem ? renderItem(item) : item.label}</li>
      ))}
    </ul>
  );
}

export function EmptyList() {
  return <p className="list list--empty">No items</p>;
}

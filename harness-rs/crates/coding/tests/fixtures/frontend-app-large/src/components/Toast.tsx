import { useEffect } from "react";
import type { ToastKind } from "../types/ui";

export interface ToastProps {
  kind: ToastKind;
  message: string;
  onDismiss: () => void;
}

export function Toast({ kind, message, onDismiss }: ToastProps) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, 4000);
    return () => window.clearTimeout(timer);
  }, [onDismiss]);

  return (
    <aside className={`toast toast--${kind}`} role="status">
      {message}
    </aside>
  );
}

export function ToastStack({ messages }: { messages: ToastProps[] }) {
  return (
    <div className="toast-stack">
      {messages.map((toast) => (
        <Toast key={toast.message} {...toast} />
      ))}
    </div>
  );
}

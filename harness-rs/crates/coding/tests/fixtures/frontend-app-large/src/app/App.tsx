import { useMemo } from "react";
import { AuthProvider } from "../features/auth/AuthProvider";
import { LoginForm } from "../features/auth/LoginForm";
import { SessionList } from "../features/session/SessionList";
import { ToastStack } from "../components/Toast";
import { useToggle } from "../hooks/useToggle";
import type { Session } from "../types/models";

const demoSession: Session = {
  id: "session-1",
  userId: "user-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-02-01T00:00:00.000Z",
};

export default function App() {
  const [showLogin, toggleLogin] = useToggle(true);
  const sessions = useMemo(() => [demoSession], []);

  return (
    <AuthProvider>
      <main className="app">
        <h1>Sessions</h1>
        {showLogin ? <LoginForm onAuthenticated={toggleLogin} /> : null}
        <SessionList sessions={sessions} />
        <ToastStack messages={[]} />
        <button type="button" onClick={toggleLogin}>
          Toggle login
        </button>
      </main>
    </AuthProvider>
  );
}

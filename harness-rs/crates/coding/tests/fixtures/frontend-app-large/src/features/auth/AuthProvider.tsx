import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { AuthResponse } from "../../types/api";
import type { User } from "../../types/models";

interface AuthContextValue {
  user: User | null;
  signIn: (response: AuthResponse) => void;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const value = useMemo(
    () => ({
      user,
      signIn: (response: AuthResponse) => setUser(response.user),
      signOut: () => setUser(null),
    }),
    [user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used inside AuthProvider");
  }
  return value;
}

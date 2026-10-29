import { useState } from "react";
import { Button } from "../../components/Button";
import { Form } from "../../components/Form";
import type { AuthResponse } from "../../types/api";

interface LoginFormProps {
  onAuthenticated: (response: AuthResponse) => void;
}

export function LoginForm({ onAuthenticated }: LoginFormProps) {
  const [error, setError] = useState<string | null>(null);

  async function submit(values: Record<string, string>) {
    setError(null);
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    if (!response.ok) {
      setError("Invalid credentials");
      return;
    }
    onAuthenticated((await response.json()) as AuthResponse);
  }

  return (
    <>
      <Form
        fields={[
          { name: "email", label: "Email", type: "email" },
          { name: "password", label: "Password", type: "password" },
        ]}
        onSubmit={submit}
      />
      {error ? <p className="error">{error}</p> : null}
      <Button label="Reset" type="reset" />
    </>
  );
}

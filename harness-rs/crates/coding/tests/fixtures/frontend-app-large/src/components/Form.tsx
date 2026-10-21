import { useState } from "react";
import { Button } from "./Button";

export interface FormField {
  name: string;
  label: string;
  type?: "text" | "email" | "password";
}

export interface FormProps {
  fields: FormField[];
  onSubmit: (values: Record<string, string>) => void;
}

export function Form({ fields, onSubmit }: FormProps) {
  const [values, setValues] = useState<Record<string, string>>({});

  function update(name: string, value: string) {
    setValues((current) => ({ ...current, [name]: value }));
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(values);
      }}
    >
      {fields.map((field) => (
        <label key={field.name}>
          {field.label}
          <input
            type={field.type ?? "text"}
            value={values[field.name] ?? ""}
            onChange={(event) => update(field.name, event.target.value)}
          />
        </label>
      ))}
      <Button label="Submit" type="submit" />
    </form>
  );
}

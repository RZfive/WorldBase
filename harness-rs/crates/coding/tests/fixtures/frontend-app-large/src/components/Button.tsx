import type { ButtonHTMLAttributes } from "react";
import type { Size } from "../types/ui";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: Size;
}

export function Button({ label, size = "medium", className = "", ...props }: ButtonProps) {
  const classes = ["button", `button--${size}`, className].filter(Boolean).join(" ");
  return (
    <button className={classes} {...props}>
      {label}
    </button>
  );
}

export default Button;

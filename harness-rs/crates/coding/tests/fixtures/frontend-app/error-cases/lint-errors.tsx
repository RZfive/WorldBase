import { Counter } from "../src/components/Counter";
import { MissingPanel } from "./MissingPanel";

export function BrokenPanel() {
  const unused = 42;
  return <MissingPanel label="broken" />;
}

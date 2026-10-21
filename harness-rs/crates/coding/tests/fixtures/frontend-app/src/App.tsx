import { Counter } from "./components/Counter";
import { formatCount } from "./lib/math";
import type { Theme } from "./lib/types";

const DEFAULT_THEME: Theme = "light";

export function App() {
  const theme = DEFAULT_THEME;

  return (
    <main className={`app app--${theme}`}>
      <h1>Frontend Benchmark</h1>
      <p>{formatCount(3)}</p>
      <Counter initial={1} step={2} />
    </main>
  );
}

import { useState } from "react";
import { Button } from "./Button";

interface CounterProps {
  initial?: number;
  step?: number;
}

export function Counter({ initial = 0, step = 1 }: CounterProps) {
  const [count, setCount] = useState(initial);

  function increment() {
    setCount((current) => current + step);
  }

  function decrement() {
    setCount((current) => current - step);
  }

  return (
    <div className="counter">
      <Button label="Decrease" onClick={decrement} />
      <output>{count}</output>
      <Button label="Increase" onClick={increment} />
    </div>
  );
}

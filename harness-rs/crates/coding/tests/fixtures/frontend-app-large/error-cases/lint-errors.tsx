import { useEffect, useState } from "react";
import { MissingWidget } from "../src/components/MissingWidget";

export function LintPanel() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    setCount(count + 1);
  }, []);

  return <MissingWidget count={missingValue} />;
}

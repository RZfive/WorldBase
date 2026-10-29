import { useCallback, useState } from "react";

export function useToggle(initial = false): [boolean, () => void, (value: boolean) => void] {
  const [value, setValue] = useState(initial);

  const toggle = useCallback(() => {
    setValue((current) => !current);
  }, []);

  const set = useCallback((next: boolean) => {
    setValue(next);
  }, []);

  return [value, toggle, set];
}

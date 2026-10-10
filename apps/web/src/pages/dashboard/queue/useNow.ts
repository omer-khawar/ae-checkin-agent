import { useEffect, useState } from "react";

/**
 * A wall-clock value that re-renders every `tickMs` while `enabled`. One
 * instance per page drives every countdown chip, so N rows cost one interval.
 */
export function useNow(enabled: boolean, tickMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(id);
  }, [enabled, tickMs]);
  return now;
}

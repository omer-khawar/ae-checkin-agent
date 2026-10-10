import { useEffect, useState } from "react";

/**
 * A wall-clock value that re-renders on an interval. One instance at the page
 * level drives every live cell (time-to-acknowledge, SAE countdowns) so they tick
 * in lockstep instead of each cell owning a timer.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

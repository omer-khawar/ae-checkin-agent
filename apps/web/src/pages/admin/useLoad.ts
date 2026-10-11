/**
 * Minimal "load once, reload on demand" hook for the admin panels. Kept local
 * to this folder (page-ownership rule); nothing clever: a counter re-runs the
 * loader, a cancelled flag ignores stale results.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface Loaded<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

export function useLoad<T>(loader: () => Promise<T>): Loaded<T> {
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const [tick, setTick] = useState(0);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loaderRef
      .current()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

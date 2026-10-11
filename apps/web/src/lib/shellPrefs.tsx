/**
 * Per-viewer console preferences, kept in localStorage (try/catch: storage can be blocked).
 *
 * - `demoGuide` (default ON): judge-facing explanations. Staff can turn it off from the user
 *   menu; pitch-style explanatory copy anywhere in the console should sit behind `<DemoOnly>`.
 * - `codes` (default OFF): "Codes" mode shows SDTM variable names and rule ids next to the
 *   plain-language labels. Pages read it with `useCodesMode()`; the shell also sets
 *   `data-codes="true"` on the console root.
 */
import { useSyncExternalStore, type ReactNode } from "react";

type Key = "demoGuide" | "codes";
const STORAGE: Record<Key, string> = {
  demoGuide: "interim.pref.demoGuide",
  codes: "interim.pref.codes",
};
const DEFAULTS: Record<Key, boolean> = { demoGuide: true, codes: false };

const listeners = new Set<() => void>();
const memory: Partial<Record<Key, boolean>> = {};

function read(key: Key): boolean {
  if (key in memory) return memory[key] as boolean;
  try {
    const raw = localStorage.getItem(STORAGE[key]);
    if (raw === "1") return true;
    if (raw === "0") return false;
  } catch {
    /* blocked storage: fall through to the default */
  }
  return DEFAULTS[key];
}

function write(key: Key, value: boolean): void {
  memory[key] = value;
  try {
    localStorage.setItem(STORAGE[key], value ? "1" : "0");
  } catch {
    /* in-memory only */
  }
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function usePref(key: Key): [boolean, (v: boolean) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => DEFAULTS[key],
  );
  return [value, (v: boolean) => write(key, v)];
}

export function useDemoGuide(): [boolean, (v: boolean) => void] {
  return usePref("demoGuide");
}

export function useCodesMode(): [boolean, (v: boolean) => void] {
  return usePref("codes");
}

/** Renders its children only while the Demo guide is on. */
export function DemoOnly({ children }: { children: ReactNode }) {
  const [on] = useDemoGuide();
  return on ? <>{children}</> : null;
}

/** Test helper: forget cached values so a test can start from the defaults. */
export function resetShellPrefs(): void {
  for (const k of Object.keys(memory) as Key[]) delete memory[k];
  try {
    Object.values(STORAGE).forEach((k) => localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

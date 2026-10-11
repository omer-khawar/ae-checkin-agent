/**
 * Per-user label mode for the detail page: "plain" (default; plain-language labels lead and
 * SDTM variable names stay one click deeper) or "codes" (SDTM names shown inline).
 *
 * Stored in localStorage under `interim.labels` (a per-viewer convenience, so every access is
 * wrapped in try/catch). The shell's command menu or user menu can flip it by writing the key
 * and dispatching `LABEL_MODE_EVENT`; this hook also follows other tabs through `storage`.
 */
import { useCallback, useEffect, useState } from "react";

export type LabelMode = "plain" | "codes";

export const LABEL_MODE_KEY = "interim.labels";
export const LABEL_MODE_EVENT = "interim:labels";

export function readLabelMode(): LabelMode {
  try {
    return window.localStorage.getItem(LABEL_MODE_KEY) === "codes" ? "codes" : "plain";
  } catch {
    return "plain";
  }
}

export function useLabelMode(): [LabelMode, (m: LabelMode) => void] {
  const [mode, setModeState] = useState<LabelMode>(readLabelMode);

  useEffect(() => {
    const sync = () => setModeState(readLabelMode());
    window.addEventListener("storage", sync);
    window.addEventListener(LABEL_MODE_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(LABEL_MODE_EVENT, sync);
    };
  }, []);

  const setMode = useCallback((m: LabelMode) => {
    setModeState(m);
    try {
      window.localStorage.setItem(LABEL_MODE_KEY, m);
    } catch {
      /* per-viewer convenience only */
    }
    window.dispatchEvent(new Event(LABEL_MODE_EVENT));
  }, []);

  return [mode, setMode];
}

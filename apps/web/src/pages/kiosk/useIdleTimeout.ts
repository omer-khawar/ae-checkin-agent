import { useCallback, useEffect, useRef, useState } from "react";

/** After this much time with no input the kiosk asks "Are you still there?". */
export const IDLE_WARN_MS = 60_000;
/** How long the question stays up before the check-in is discarded. */
export const IDLE_GRACE_MS = 30_000;

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "input", "touchstart"] as const;

export interface IdleState {
  warning: boolean;
  /** Whole seconds left before the reset, while `warning` is true. */
  secondsLeft: number;
  /** "I'm still here". */
  dismiss: () => void;
}

/**
 * Idle timeout for the unattended kiosk. While `enabled`, any input restarts the clock.
 * After `warnMs` of silence `warning` turns on (input no longer dismisses it; the
 * participant must press the button); after a further `graceMs` `onTimeout` runs once.
 */
export function useIdleTimeout(opts: {
  enabled: boolean;
  onTimeout: () => void;
  warnMs?: number;
  graceMs?: number;
}): IdleState {
  const { enabled, onTimeout, warnMs = IDLE_WARN_MS, graceMs = IDLE_GRACE_MS } = opts;
  const last = useRef(Date.now());
  const warningRef = useRef(false);
  const [warning, setWarning] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(Math.ceil(graceMs / 1000));
  const timeoutRef = useRef(onTimeout);
  timeoutRef.current = onTimeout;

  const clear = useCallback(() => {
    last.current = Date.now();
    warningRef.current = false;
    setWarning(false);
    setSecondsLeft(Math.ceil(graceMs / 1000));
  }, [graceMs]);

  useEffect(() => {
    clear();
    if (!enabled) return undefined;
    const onActivity = () => {
      if (!warningRef.current) last.current = Date.now();
    };
    for (const e of ACTIVITY_EVENTS) window.addEventListener(e, onActivity, true);
    const timer = window.setInterval(() => {
      const idle = Date.now() - last.current;
      if (idle >= warnMs + graceMs) {
        clear();
        timeoutRef.current();
      } else if (idle >= warnMs) {
        warningRef.current = true;
        setWarning(true);
        setSecondsLeft(Math.max(1, Math.ceil((warnMs + graceMs - idle) / 1000)));
      }
    }, 1000);
    return () => {
      for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, onActivity, true);
      window.clearInterval(timer);
    };
  }, [enabled, warnMs, graceMs, clear]);

  return { warning, secondsLeft, dismiss: clear };
}

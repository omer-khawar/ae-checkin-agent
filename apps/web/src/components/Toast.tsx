/**
 * Toasts: `ToastProvider` at the app root, `useToast().push(...)` anywhere.
 * The dashboard's mock pager (Tier 3) will show its "page" here in a later wave.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { cx } from "../lib/format";

export type ToastKind = "info" | "success" | "warning" | "error";

export interface ToastInput {
  kind?: ToastKind;
  title: string;
  message?: string;
  /** ms; 0 = sticky until dismissed. Default 6000. */
  durationMs?: number;
}

export interface Toast extends Required<Omit<ToastInput, "message">> {
  id: number;
  message?: string;
}

interface ToastApi {
  push: (t: ToastInput) => number;
  dismiss: (id: number) => void;
  toasts: Toast[];
}

const ToastContext = createContext<ToastApi | null>(null);

const KIND_CLASS: Record<ToastKind, string> = {
  info: "border-slate-300 bg-white text-slate-900",
  success: "border-green-300 bg-green-50 text-green-900",
  warning: "border-amber-300 bg-amber-50 text-amber-900",
  error: "border-red-300 bg-red-50 text-red-900",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (input: ToastInput) => {
      const id = nextId.current++;
      const toast: Toast = {
        id,
        kind: input.kind ?? "info",
        title: input.title,
        message: input.message,
        durationMs: input.durationMs ?? 6000,
      };
      setToasts((prev) => [...prev, toast]);
      if (toast.durationMs > 0) setTimeout(() => dismiss(id), toast.durationMs);
      return id;
    },
    [dismiss],
  );

  const value = useMemo(() => ({ push, dismiss, toasts }), [push, dismiss, toasts]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 top-3 z-50 flex flex-col items-center gap-2 px-4"
        aria-live="polite"
        aria-relevant="additions"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.kind === "error" || t.kind === "warning" ? "alert" : "status"}
            className={cx(
              "pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-xl border px-4 py-3 shadow-card",
              KIND_CLASS[t.kind],
            )}
          >
            <div className="flex-1">
              <div className="font-semibold">{t.title}</div>
              {t.message && <div className="mt-0.5 text-sm opacity-90">{t.message}</div>}
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="rounded px-1 text-sm opacity-70 hover:opacity-100"
              aria-label="Dismiss notification"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Allow use outside the provider (tests, kiosk) without crashing.
    return { push: () => -1, dismiss: () => undefined, toasts: [] };
  }
  return ctx;
}

/**
 * "Reset demo data" with an in-page confirmation (the viewer shows no
 * window.confirm). Two clicks: the first reveals what the reset does and the
 * confirm button; the second POSTs `/admin/reset {reseed: true}`.
 *
 * Focus management: the confirm button is auto-focused when the group opens,
 * so when the group unmounts (Cancel, or a successful reset) focus would fall
 * to <body> and a keyboard user would lose their place. We hand it back to the
 * "Reset demo data…" trigger instead. A failed reset keeps the group open but
 * the confirm button was disabled while busy (which also drops focus), so focus
 * is returned to it once it is enabled again.
 */
import { useEffect, useRef, useState } from "react";

import { Button } from "@/pages/admin/SysUI";
import { Panel as Card } from "@/pages/admin/SysUI";
import { ErrorBanner } from "../../components/ErrorBanner";
import { useToast } from "../../components/Toast";
import { adminReset } from "../../lib/api";

export interface ResetPanelProps {
  /** Called after a successful reset so the parent can reload settings/health. */
  onReset: () => void;
}

type FocusTarget = "trigger" | "confirm" | null;

export function ResetPanel({ onReset }: ResetPanelProps) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  // Which button should receive focus once React has committed the state
  // change that re-mounts / re-enables it. Set by the handlers, consumed by
  // the effect below (a synchronous focus() in the handler would run before
  // the target exists or while it is still disabled).
  const pendingFocus = useRef<FocusTarget>(null);

  useEffect(() => {
    if (busy || pendingFocus.current === null) return;
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target === "trigger" && !confirming) triggerRef.current?.focus();
    if (target === "confirm" && confirming) confirmRef.current?.focus();
  }, [busy, confirming]);

  function cancel() {
    pendingFocus.current = "trigger";
    setConfirming(false);
  }

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await adminReset(true);
      pendingFocus.current = "trigger";
      setConfirming(false);
      toast.push({
        kind: res.ok === false ? "warning" : "success",
        title: res.ok === false ? "Reset reported ok: false" : "Demo data reset",
        message: "Tables wiped and reseeded; a fresh genesis audit event was written (demo.reset).",
      });
      onReset();
    } catch (e) {
      pendingFocus.current = "confirm";
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Demo data">
      <p className="text-table text-foreground">
        Wipes every table (sessions, answers, vitals, drafts, escalations, SAE clocks, audit chain),
        reseeds the 12 synthetic participants with their backdated history, and starts a new audit
        chain with a fresh genesis event. All participants are synthetic; there is no real data to
        lose, but any check-ins run during this demo session are gone.
      </p>
      <ErrorBanner error={error} message="Reset failed" className="mt-3" />
      {!confirming ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button ref={triggerRef} variant="danger" onClick={() => setConfirming(true)}>
            Reset demo data…
          </Button>
          <span className="text-caption text-muted-foreground">
            Requires ALLOW_DEMO_RESET on the API · admin only · audited as demo.reset
          </span>
        </div>
      ) : (
        <div
          role="group"
          aria-labelledby="reset-confirm-title"
          className="mt-3 rounded-panel border border-danger-border bg-danger-bg p-3"
        >
          <div id="reset-confirm-title" className="font-semibold text-danger-fg">
            Reset and reseed the demo database now?
          </div>
          <p className="mt-1 text-table text-danger-fg">
            This cannot be undone. The current audit chain is replaced; exports made before the
            reset will not verify against the new chain.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              ref={confirmRef}
              variant="destructive"
              busy={busy}
              onClick={() => void run()}
              autoFocus
            >
              Yes, wipe and reseed
            </Button>
            <Button variant="secondary" disabled={busy} onClick={cancel}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

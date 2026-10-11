/**
 * "Verify chain" control and result badge (CLAUDE.md §3.6).
 *
 * The server walks the whole chain (`GET /audit/verify`) and reports the first
 * broken link, if any. This panel only paints that answer: a green VERIFIED
 * badge with the checked count and head hash, or a red BROKEN badge with the
 * index/id of the first bad event, the server's one-sentence reason (sequence
 * gap, prev_hash mismatch or recomputed-hash mismatch) and the expected vs
 * actual hash.
 */
import { useState } from "react";

import { Button } from "@/pages/admin/SysUI";
import { Panel as Card } from "@/pages/admin/SysUI";
import { ErrorBanner } from "../../../components/ErrorBanner";
import { useToast } from "../../../components/Toast";
import { verifyAudit } from "../../../lib/api";
import { cx, Time } from "../../../lib/format";
import type { AuditVerifyResult } from "../../../lib/types";
import { copyText, truncateHash } from "./auditLib";

/**
 * The contract (§2.2) lists `{index, id, expected_hash, actual_hash}`; the
 * shipped verifier (`apps/api/interim_api/audit.py`) also returns `reason` and
 * `seq`. Both are optional here so the page works against either.
 */
type VerifyBroken = NonNullable<AuditVerifyResult["first_broken"]> & {
  reason?: string;
  seq?: number;
};

export interface VerifyPanelProps {
  /** Called after a successful verify so the page can refresh its event list. */
  onVerified?: (result: AuditVerifyResult) => void;
}

export function VerifyPanel({ onVerified }: VerifyPanelProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<AuditVerifyResult | null>(null);
  const toast = useToast();

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const r = await verifyAudit();
      setResult(r);
      onVerified?.(r);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function copyHead() {
    if (!result?.head_hash) return;
    const ok = await copyText(result.head_hash);
    toast.push(
      ok
        ? { kind: "success", title: "Head hash copied" }
        : { kind: "warning", title: "Clipboard unavailable", message: result.head_hash },
    );
  }

  return (
    <Card
      title="Chain integrity"
      aside={
        <Button variant="primary" size="md" onClick={() => void run()} busy={busy}>
          Verify chain
        </Button>
      }
    >
      <p className="text-table text-foreground">
        Every event stores{" "}
        <code className="rounded bg-surface-subtle px-1 font-mono text-caption">
          hash = sha256(prev_hash + canonical_json(event))
        </code>
        , so each event commits to the one before it and changing or deleting any past event breaks
        every hash after it. Verify walks the whole chain on the server from the genesis event
        (prev_hash of 64 zeros) to the head.
      </p>

      <ErrorBanner
        error={error}
        message="Could not verify the audit chain"
        onRetry={() => void run()}
        className="mt-3"
      />

      {result && (
        <div
          role="status"
          data-testid="verify-result"
          className={cx(
            "mt-4 flex flex-wrap items-center gap-4 rounded-panel border px-4 py-3",
            result.ok ? "border-success-border bg-success-bg" : "border-danger-border bg-danger-bg",
          )}
        >
          <span
            className={cx(
              "inline-flex items-center gap-2 rounded-control px-3 py-1.5 text-page font-extrabold tracking-wide",
              result.ok ? "bg-success-fg text-white" : "bg-destructive text-destructive-foreground",
            )}
            data-verify={result.ok ? "ok" : "broken"}
          >
            <span aria-hidden="true">{result.ok ? "✓" : "✕"}</span>
            {result.ok ? "VERIFIED" : "BROKEN"}
          </span>

          <dl className="grid flex-1 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-table">
            <dt className="text-muted-foreground">Events checked</dt>
            <dd className="tnum font-semibold text-foreground">{result.checked}</dd>
            <dt className="text-muted-foreground">Head hash</dt>
            <dd className="flex items-center gap-2">
              <code className="font-mono text-foreground" title={result.head_hash}>
                {truncateHash(result.head_hash, 16)}
              </code>
              <button
                type="button"
                onClick={() => void copyHead()}
                className="rounded px-1.5 py-0.5 text-caption font-medium text-primary underline hover:bg-accent"
              >
                Copy full hash
              </button>
            </dd>
            <dt className="text-muted-foreground">Verified at</dt>
            <dd>
              <Time iso={result.verified_at} />
            </dd>
          </dl>

          {!result.ok && result.first_broken && (
            <BrokenDetail broken={result.first_broken as VerifyBroken} />
          )}
          {!result.ok && !result.first_broken && (
            <p className="basis-full text-table text-danger-fg">
              The server reported a broken chain but did not identify the first broken link.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

function BrokenDetail({ broken }: { broken: VerifyBroken }) {
  return (
    <div
      className="basis-full rounded-control border border-danger-border bg-surface p-3 text-table"
      data-testid="verify-broken"
    >
      {/* The reason is the sentence that explains WHY; the hashes are the proof. */}
      {broken.reason && <p className="font-semibold text-danger-fg">{broken.reason}</p>}
      <div
        className={cx("text-foreground", broken.reason ? "mt-1" : "font-semibold text-danger-fg")}
      >
        First broken link at index <span className="tnum font-mono">{broken.index}</span>
        {typeof broken.seq === "number" && (
          <>
            {" "}
            (seq <span className="tnum font-mono">{broken.seq}</span>)
          </>
        )}
        , event <code className="font-mono">{broken.id}</code>
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">Expected</dt>
        <dd>
          <code className="break-all font-mono text-foreground">{broken.expected_hash}</code>
        </dd>
        <dt className="text-muted-foreground">Actual</dt>
        <dd>
          <code className="break-all font-mono text-danger-fg">{broken.actual_hash}</code>
        </dd>
      </dl>
      <p className="mt-2 text-foreground">
        Every event from this one onward is untrusted until the discrepancy is explained.
      </p>
    </div>
  );
}

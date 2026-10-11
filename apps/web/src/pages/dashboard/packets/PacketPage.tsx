/**
 * /dashboard/packets/:id — the serious-event packet (CLAUDE.md §00.2,
 * CONTRACTS.md R3.2 "Packets", R3.3, R4.2 "Follow-up reports").
 *
 * Step 5 of the life of a side effect: a serious or special-interest event
 * must reach the sponsor within 24 hours. Interim pre-fills the report from
 * evidence and drafts the narrative; this page is where a person reviews it.
 *
 * Layout
 *   Header   participant, plain kind name (+ SAE/AESI badge), sequence, status,
 *            live countdown to the 24-hour deadline, one plain sentence on why.
 *   Actions  Save · Sign (investigator) · Print · Export JSON · Start follow-up.
 *   Main     follow-up changes (R4.2) · report fields · narrative.
 *   Side     information still needed · evidence inspector · history.
 *
 * Rules decide, text tools write, people confirm: nothing here decides a
 * grade, a seriousness or a deadline; the page only displays what the API's
 * rules produced, lets people correct it (every Save is a new version on the
 * server), and lets the investigator sign. Generated text is labelled with its
 * writer and stays "Draft" until signed.
 *
 * `/dashboard/packets/new?clock=<clock_id>` creates (or opens) the packet for
 * a clock and replaces the URL with the packet id, so other pages can link a
 * clock chip straight here.
 *
 * Route registration is done by the shell: this file default-exports the page.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { Button } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { ErrorBanner } from "../../../components/ErrorBanner";
import { useToast } from "../../../components/Toast";
import { useAuth } from "../../../lib/auth";
import { EvidenceInspector, type EvidenceSelection } from "./EvidenceBits";
import { FieldsTable } from "./FieldsTable";
import {
  evidenceIndex,
  lockDownPrintHtml,
  narrativeView,
  resolveDeadline,
  saveBlob,
} from "./model";
import { NarrativePanel } from "./NarrativePanel";
import {
  ChangesCard,
  HistoryCard,
  MissingInfoCard,
  PacketHeader,
  SignConfirm,
} from "./PacketParts";
import {
  createPacket,
  getPacket,
  getPacketExportBlob,
  getPacketPrintHtml,
  listAllClocks,
  patchPacket,
  signPacket,
  startFollowUp,
} from "../../../lib/api";
import type {
  Packet,
  PacketClock,
  PacketEvidence,
  PacketValue,
  PatchPacketRequest,
} from "../../../lib/types";

/** Re-render once a second so the deadline counts down live. */
function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

type Busy = null | "save" | "sign" | "print" | "export" | "followup";

export default function PacketPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [search] = useSearchParams();
  const clockParam = search.get("clock");
  const navigate = useNavigate();
  const toast = useToast();
  const { hasRole } = useAuth();
  const nowMs = useNow();

  const [packet, setPacket] = useState<Packet | null>(null);
  const [clocks, setClocks] = useState<PacketClock[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [staged, setStaged] = useState<Record<string, PacketValue>>({});
  const [narrativeDraft, setNarrativeDraft] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [selection, setSelection] = useState<EvidenceSelection | null>(null);
  const inspectorRef = useRef<HTMLDivElement>(null);

  // ---- Load ---------------------------------------------------------------

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    const isCreate = id === "new";
    if (isCreate && !clockParam) {
      setLoadError(new Error("No clock was given, so there is no report to open."));
      setLoading(false);
      return () => undefined;
    }
    const fetcher = isCreate ? createPacket(clockParam as string) : getPacket(id);
    fetcher
      .then((p) => {
        if (cancelled) return;
        if (isCreate) {
          navigate(`/dashboard/packets/${encodeURIComponent(p.id)}`, { replace: true });
        }
        setPacket(p);
        // The deadline normally rides on the packet; when it does not, read the
        // clock. A follow-up also reads it for when the initial report stopped it.
        if (p.clock_id && (!p.due_at || (p.sequence > 0 && !p.clock_stopped_at))) {
          listAllClocks()
            .then((c) => {
              if (!cancelled) setClocks(c);
            })
            .catch(() => {
              /* non-fatal: the header then says "Deadline not available" */
            });
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, clockParam, navigate]);

  useEffect(() => {
    // A different packet: drop everything staged for the previous one.
    setPacket(null);
    setClocks(null);
    setStaged({});
    setNarrativeDraft(null);
    setConfirmOpen(false);
    setSelection(null);
    setActionError(null);
    return load();
  }, [load]);

  // ---- Derived ------------------------------------------------------------

  const evidence = useMemo(
    () => (packet ? evidenceIndex(packet) : new Map<string, PacketEvidence>()),
    [packet],
  );
  const view = useMemo(() => (packet ? narrativeView(packet) : null), [packet]);
  const deadline = useMemo(
    () => (packet ? resolveDeadline(packet, clocks) : null),
    [packet, clocks],
  );

  const isDraft = packet?.status === "draft";
  // Roles mirror the API: field edits and follow-ups are coordinator+
  // (coordinator, investigator, admin, as every other coordinator+ mutation in
  // auth.py#require_role); the narrative and the signature are the
  // investigator's alone.
  const isInvestigator = hasRole("investigator");
  const canEditFields = Boolean(isDraft) && hasRole("coordinator", "investigator", "admin");
  const canEditNarrative = Boolean(isDraft) && isInvestigator;
  const canSign = Boolean(isDraft) && isInvestigator;
  const canFollowUp =
    packet?.status === "signed" && hasRole("coordinator", "investigator", "admin");
  // A packet already followed up is not the latest report in its chain: open
  // that follow-up instead of starting another one (R4.2: follow-up n+1 is
  // made from signed report n).
  const existingFollowUps = packet?.followup_packet_ids ?? [];
  const latestFollowUpId = existingFollowUps.length
    ? existingFollowUps[existingFollowUps.length - 1]
    : null;

  const narrativeDirty =
    narrativeDraft !== null && view !== null && narrativeDraft.trim() !== view.text.trim();
  const stagedCount = Object.keys(staged).length;
  const dirty = stagedCount > 0 || narrativeDirty;

  // Warn before leaving with unsaved edits (a full page unload only; in-app
  // navigation keeps the warning in the Save bar).
  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const labelFor = useCallback(
    (name: string) => packet?.fields.find((f) => f.name === name)?.plain_label ?? name,
    [packet],
  );

  const selectEvidence = useCallback((s: EvidenceSelection) => {
    setSelection(s);
    // On narrow screens the inspector sits below the content; bring it into view.
    inspectorRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, []);

  // ---- Actions ------------------------------------------------------------

  function stage(name: string, value: PacketValue | undefined) {
    setStaged((prev) => {
      const next = { ...prev };
      if (value === undefined) delete next[name];
      else next[name] = value;
      return next;
    });
  }

  async function save() {
    if (!packet || !dirty) return;
    const body: PatchPacketRequest = {};
    if (stagedCount > 0) body.fields = staged;
    if (narrativeDirty && narrativeDraft !== null) body.narrative_text = narrativeDraft;
    setBusy("save");
    setActionError(null);
    try {
      const updated = await patchPacket(packet.id, body);
      setPacket(updated);
      setStaged({});
      setNarrativeDraft(null);
      toast.push({
        kind: "success",
        title: "Saved as a new version",
        message: "The earlier version is kept and the edit is in the audit trail.",
      });
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(null);
    }
  }

  async function sign() {
    // The signature covers exactly what the server holds. Unsaved edits would
    // be signed away silently, so refuse (the page also freezes editing while
    // the confirmation is open, and the confirm button is disabled when dirty).
    if (!packet || dirty) return;
    setBusy("sign");
    setActionError(null);
    try {
      const signed = await signPacket(packet.id);
      setPacket(signed);
      setConfirmOpen(false);
      setStaged({});
      setNarrativeDraft(null);
      toast.push({
        kind: "success",
        title: packet.sequence > 0 ? "Follow-up signed" : "Report signed",
        message:
          packet.sequence > 0
            ? "A copy was posted to the mock EDC. The 24-hour clock was already stopped by the initial report."
            : "The 24-hour clock is stopped as reported (mock) and a copy was posted to the mock EDC.",
      });
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(null);
    }
  }

  async function print() {
    if (!packet) return;
    // Open the window inside the click so popup blockers allow it, then fill it.
    const win = typeof window.open === "function" ? window.open("", "_blank") : null;
    setBusy("print");
    setActionError(null);
    try {
      const html = await getPacketPrintHtml(packet.id);
      // The blob document runs with this app's origin, so it gets a CSP that
      // allows no script at all (see model.ts#lockDownPrintHtml), and the new
      // window loses its link back to this page.
      const blob = new Blob([lockDownPrintHtml(html)], { type: "text/html;charset=utf-8" });
      if (win && typeof URL.createObjectURL === "function") {
        const href = URL.createObjectURL(blob);
        try {
          win.opener = null;
        } catch {
          /* some browsers make opener read-only; the CSP still blocks scripts */
        }
        win.location.href = href;
        // Navigation has fetched the blob long before this; free the memory.
        window.setTimeout(() => URL.revokeObjectURL?.(href), 60_000);
      } else if (!saveBlob(blob, `packet-${packet.id}.html`)) {
        toast.push({
          kind: "warning",
          title: "Could not open the printable page",
          message: "Allow pop-ups for this site and try again.",
        });
      }
    } catch (e) {
      win?.close();
      setActionError(e);
    } finally {
      setBusy(null);
    }
  }

  async function exportJson() {
    if (!packet) return;
    setBusy("export");
    setActionError(null);
    try {
      const blob = await getPacketExportBlob(packet.id);
      const filename = `packet-${packet.id}.json`;
      const saved = saveBlob(blob, filename);
      toast.push(
        saved
          ? { kind: "success", title: `${filename} downloaded` }
          : {
              kind: "warning",
              title: `${filename} fetched`,
              message: "This browser cannot save files from the page.",
            },
      );
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(null);
    }
  }

  async function followUp() {
    if (!packet) return;
    setBusy("followup");
    setActionError(null);
    try {
      const next = await startFollowUp(packet.id);
      toast.push({
        kind: "success",
        title: `Follow-up ${next.sequence || packet.sequence + 1} started`,
        message: "Pre-filled from the current evidence. Review the changes, then sign.",
      });
      navigate(`/dashboard/packets/${encodeURIComponent(next.id)}`);
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(null);
    }
  }

  // ---- Render: loading / error --------------------------------------------

  if (loading && !packet) {
    return (
      <div className="space-y-4" aria-busy="true">
        <h1 className="text-2xl font-bold text-slate-900">Report</h1>
        <p className="text-slate-600" role="status">
          Loading the report…
        </p>
        <div className="h-40 animate-pulse rounded-2xl bg-slate-100" />
      </div>
    );
  }

  if (loadError || !packet || !view || !deadline) {
    const notFound =
      typeof loadError === "object" &&
      loadError !== null &&
      "status" in loadError &&
      (loadError as { status: number }).status === 404;
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-slate-900">Report</h1>
        <ErrorBanner
          error={loadError ?? new Error("The report could not be loaded.")}
          message={notFound ? "This report does not exist." : "The report could not be loaded."}
          onRetry={notFound ? undefined : () => void load()}
        />
      </div>
    );
  }

  // ---- Render: page ---------------------------------------------------------

  const readOnlyReason =
    packet.status === "signed"
      ? latestFollowUpId
        ? "This report is signed and can no longer be changed. A follow-up report already carries the newer information."
        : "This report is signed and can no longer be changed. Start a follow-up report to add new information."
      : confirmOpen
        ? "Editing is paused while the signature is being confirmed. Cancel to make changes."
        : !canEditFields
          ? "Your role can read this report; coordinators, investigators and admins edit it."
          : null;

  return (
    <div className="space-y-4">
      <PacketHeader packet={packet} deadline={deadline} nowMs={nowMs} />

      {/* Action bar */}
      <div
        className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-card"
        role="toolbar"
        aria-label="Report actions"
      >
        {isDraft && (
          <Button
            onClick={() => void save()}
            disabled={!dirty || busy !== null}
            busy={busy === "save"}
          >
            Save
          </Button>
        )}
        {/* Investigator-only control: other roles see the plain note instead. */}
        {canSign && (
          <Button
            variant="secondary"
            onClick={() => setConfirmOpen(true)}
            disabled={dirty || busy !== null || confirmOpen}
            title={dirty ? "Save your changes before signing" : undefined}
          >
            Sign
          </Button>
        )}
        {packet.status === "signed" && latestFollowUpId && (
          <Button
            onClick={() => navigate(`/dashboard/packets/${encodeURIComponent(latestFollowUpId)}`)}
            disabled={busy !== null}
          >
            Open follow-up {packet.sequence + existingFollowUps.length}
          </Button>
        )}
        {packet.status === "signed" && !latestFollowUpId && canFollowUp && (
          <Button
            onClick={() => void followUp()}
            disabled={busy !== null}
            busy={busy === "followup"}
          >
            Start follow-up report
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={() => void print()}
          disabled={busy !== null}
          busy={busy === "print"}
        >
          Print
        </Button>
        <Button
          variant="ghost"
          onClick={() => void exportJson()}
          disabled={busy !== null}
          busy={busy === "export"}
        >
          Export JSON
        </Button>
        <span className="ml-auto text-sm text-slate-600" aria-live="polite">
          {dirty
            ? `Unsaved changes: ${stagedCount} field${stagedCount === 1 ? "" : "s"}${
                narrativeDirty ? " and the narrative" : ""
              }`
            : isDraft && !isInvestigator
              ? "Only the investigator can sign this report."
              : null}
        </span>
      </div>

      {confirmOpen && canSign && (
        <SignConfirm
          packet={packet}
          missingCount={packet.missing_information.length}
          dirty={dirty}
          busy={busy === "sign"}
          onConfirm={() => void sign()}
          onCancel={() => setConfirmOpen(false)}
        />
      )}

      <ErrorBanner error={actionError} message="That did not work" />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {packet.sequence > 0 && (
            <ChangesCard
              changes={packet.changes_since_previous}
              labelFor={labelFor}
              selectedKey={selection?.key ?? null}
              onSelectEvidence={selectEvidence}
            />
          )}
          <FieldsTable
            fields={packet.fields}
            staged={staged}
            canEdit={canEditFields && !confirmOpen}
            readOnlyReason={readOnlyReason}
            onStage={stage}
            selectedKey={selection?.key ?? null}
            onSelectEvidence={selectEvidence}
          />
          <NarrativePanel
            narrative={packet.narrative}
            view={view}
            status={packet.status}
            signedBy={packet.signed_by}
            signedAt={packet.signed_at}
            evidence={evidence}
            canEdit={canEditNarrative && !confirmOpen}
            draftText={narrativeDraft}
            onDraftChange={setNarrativeDraft}
            selectedKey={selection?.key ?? null}
            onSelectEvidence={selectEvidence}
          />
        </div>
        <aside className="space-y-4" aria-label="Report side panel">
          <MissingInfoCard items={packet.missing_information} />
          <div ref={inspectorRef} className="lg:sticky lg:top-4">
            <EvidenceInspector selection={selection} onClear={() => setSelection(null)} />
          </div>
          <HistoryCard packet={packet} />
          {!isDraft && packet.sequence === 0 && !packet.followup_packet_ids?.length && (
            <Card title="New information later?">
              <p className="text-sm text-slate-600">
                The protocol asks for follow-up reports when missing information arrives. “Start
                follow-up report” pre-fills one from the current evidence and lists what changed.
              </p>
            </Card>
          )}
        </aside>
      </div>
    </div>
  );
}

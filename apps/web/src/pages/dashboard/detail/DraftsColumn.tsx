/**
 * MIDDLE column: the drafted SDTM records grouped by domain (AE, VS, CM).
 *
 * Every field is a clickable row. Selecting one expands its `Evidence[]` under
 * the row and (through the page) highlights the answers, samples and rules it
 * points at. Coordinators confirm, edit (PATCH → new version) or reject
 * (reason required); investigators additionally set AESER / AEREL through the
 * attribution endpoint. Every mutation carries an optional audit note.
 *
 * The page owns the API calls; this column only renders state and forms.
 */
import { createContext, Fragment, useContext, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { ErrorBanner } from "../../../components/ErrorBanner";
import { Button } from "@/ui/button";
import { Kbd } from "@/ui/kbd";
import { getDraftVersions } from "../../../lib/api";
import { cx, Time } from "../../../lib/format";
import type {
  AttributionRequest,
  CheckInDetail,
  CheckInDetailR3,
  CtcaeTerm,
  Draft,
  Evidence,
  Role,
} from "../../../lib/types";
import { Chip, Disclosure, Panel, Prov, SdtmBadge } from "./bits";

/** A shortcut cap inside a button: hidden from the accessible name so "Confirm" stays "Confirm". */
function Hint({ k }: { k: string }) {
  return (
    <span aria-hidden="true" className="ml-1 opacity-80">
      <Kbd>{k}</Kbd>
    </span>
  );
}
import {
  AEREL_OPTIONS,
  AESER_OPTIONS,
  attributionBody,
  changedFields,
  diffVersions,
  DOMAIN_ORDER,
  DOMAIN_TITLES,
  draftSource,
  draftStatusStyle,
  draftTitle,
  EDITABLE_FIELDS,
  editProblem,
  editText,
  formatValue,
  gradeDefinitions,
  gradeHover,
  groupDrafts,
  highlightClass,
  IRAE_OPTIONS,
  isEditable,
  MAX_ASSIGNABLE_GRADE,
  orderedFieldNames,
  PROVISIONAL_LABEL,
  type Selection,
  vsDraftIsMeasured,
} from "./model";
import {
  AESI_BANNER,
  attributionClockHint,
  clocksForDraft,
  clocksOf,
  cmMissingText,
  fieldLabel,
  flagForDraft,
  gradeWord,
  IDENTITY_FIELDS,
  isAesiDraft,
  isProvenanceField,
  plainDraftTitle,
  plainValue,
  protocolChip,
  sdtmBadge,
  type Labels,
} from "./plain";
import { ReferencePanel } from "./ReferencePanel";

export interface DraftActions {
  confirm: (draft: Draft, note: string) => Promise<void>;
  reject: (draft: Draft, reason: string) => Promise<void>;
  patch: (draft: Draft, fields: Record<string, unknown>, note: string) => Promise<void>;
  attribution: (draft: Draft, body: AttributionRequest) => Promise<void>;
}

/** A keyboard (or button) request for one draft card to open a form. */
export interface DraftModeRequest {
  draftId: string;
  mode: "edit" | "reject";
  /** Bumped on every request so asking twice re-opens a form the user closed. */
  nonce: number;
}

export interface DraftsColumnProps {
  detail: CheckInDetail;
  /** Item id for an AEDECOD (to match the protocol's `aesi_items`); optional. */
  itemIdForTerm?: (aedecod: string) => string | null;
  role: Role | null;
  ctcae: CtcaeTerm[] | null;
  selection: Selection;
  highlight: Set<string>;
  onSelectField: (draftId: string, field: string) => void;
  onFocusEvidence: (e: Evidence) => void;
  actions: DraftActions;
  /** One-click confirm: the page confirms, then moves focus to the next draft (or offers "Next item"). */
  onConfirm: (draft: Draft) => Promise<void>;
  /** The draft the single-key shortcuts act on. */
  activeId: string | null;
  onActivate: (draftId: string) => void;
  /** Open the edit or reject form on a draft (shortcuts e / r). */
  request: DraftModeRequest | null;
  /** "Codes" label mode: SDTM variable names shown inline beside the plain labels. */
  showCodes: boolean;
}

// ---------------------------------------------------------------------------
// EDC (SDTM) codes: plain labels lead; the variable names are one click deeper
// (CLAUDE.md §00 "Speak to non-clinicians first"). When hidden, each code stays
// in the DOM as screen-reader text and in the field's hover title.
// ---------------------------------------------------------------------------

const ShowCodesContext = createContext(false);

/** An SDTM variable name beside its plain label: visible only when codes are on. */
function SdtmCode({ name, boxed }: { name: string; boxed?: boolean }) {
  const show = useContext(ShowCodesContext);
  return (
    <span
      data-sdtm-code={name}
      className={
        show
          ? boxed
            ? "rounded-control bg-surface-subtle px-1 font-mono text-caption text-muted-foreground"
            : "font-mono text-caption text-subtle-foreground"
          : "sr-only"
      }
    >
      {name}
    </span>
  );
}

export function DraftsColumn(props: DraftsColumnProps) {
  const groups = groupDrafts(props.detail.drafts ?? []);
  const total = DOMAIN_ORDER.reduce((n, d) => n + groups[d].length, 0);
  return (
    <ShowCodesContext.Provider value={props.showCodes}>
      <div className="space-y-3">
        {total === 0 && (
          <Panel title="Drafts">
            <p className="text-table text-subtle-foreground">
              No drafts were generated for this check-in (no symptom reached provisional grade 1, no
              vitals, no medication change).
            </p>
          </Panel>
        )}
        {DOMAIN_ORDER.map((domain) =>
          groups[domain].length === 0 ? null : (
            <div key={domain} role="group" aria-label={DOMAIN_TITLES[domain]} className="space-y-2">
              <h2 className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">
                {DOMAIN_TITLES[domain]}
                <span className="tabular ml-2 font-normal normal-case text-subtle-foreground">
                  ({groups[domain].length})
                </span>
              </h2>
              {groups[domain].map((d) => (
                <DraftCard key={d.id} draft={d} {...props} />
              ))}
            </div>
          ),
        )}
      </div>
    </ShowCodesContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// One draft
// ---------------------------------------------------------------------------

type Mode = "view" | "edit" | "reject";

function DraftCard({
  draft,
  detail,
  itemIdForTerm,
  role,
  ctcae,
  selection,
  onSelectField,
  onFocusEvidence,
  actions,
  onConfirm,
  activeId,
  onActivate,
  request,
}: DraftsColumnProps & { draft: Draft }) {
  const [mode, setMode] = useState<Mode>("view");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const status = draftStatusStyle(draft.status);
  const source = draftSource(draft);
  const link = detail.ae_links?.find((l) => l.draft_id === draft.id);
  const followupOf = draft.linked_ae_open_id ?? link?.ae_open_id ?? null;
  const canAct = draft.status === "draft" && role !== null;
  const defs = draft.domain === "AE" ? gradeDefinitions(ctcae, draft.fields.AEDECOD) : null;
  const active = activeId === draft.id;

  // Shortcuts e / r from the page open the form on the active draft.
  useEffect(() => {
    if (request && request.draftId === draft.id && canAct) setMode(request.mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.nonce]);

  const run = async (fn: () => Promise<void>, after: Mode = "view") => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setMode(after);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      data-draft-id={draft.id}
      data-active={active ? "true" : "false"}
      tabIndex={-1}
      onFocus={() => onActivate(draft.id)}
      onClick={() => onActivate(draft.id)}
      className={cx("outline-none", active && "border-primary ring-1 ring-primary")}
      title={
        <span className="flex flex-wrap items-center gap-1.5">
          <span>{plainDraftTitle(draft.domain, draft.fields)}</span>
          <SdtmBadge title="SDTM domain and record number">
            {sdtmBadge(draft.domain, draft.fields)}
          </SdtmBadge>
          <Chip className={status.className} title={`Draft status: ${status.label}`}>
            {status.label}
          </Chip>
          <span className="tabular text-caption font-normal text-subtle-foreground">{`v${draft.version}`}</span>
          {source && (
            <Chip
              className="border-neutral-border bg-neutral-bg text-neutral-fg"
              title="Where this draft came from"
            >
              {sourceLabel(source)}
            </Chip>
          )}
          {draft.domain === "VS" && (
            <Prov
              isMeasured={vsDraftIsMeasured(draft.fields)}
              source={
                typeof draft.fields.INTERIM_SOURCE === "string" &&
                draft.fields.INTERIM_SOURCE !== "check_in"
                  ? draft.fields.INTERIM_SOURCE
                  : null
              }
            />
          )}
        </span>
      }
      aside={
        canAct && mode === "view" ? (
          <span className="flex items-center gap-1">
            <Button
              size="sm"
              variant="primary"
              loading={busy}
              onClick={(e) => {
                e.stopPropagation();
                void run(() => onConfirm(draft));
              }}
              title="Confirm this draft (c)"
            >
              Confirm <Hint k="c" />
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={(e) => {
                e.stopPropagation();
                setMode("edit");
              }}
              title="Edit this draft (e)"
            >
              Edit <Hint k="e" />
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={(e) => {
                e.stopPropagation();
                setMode("reject");
              }}
              title="Reject this draft (r)"
            >
              Reject <Hint k="r" />
            </Button>
          </span>
        ) : undefined
      }
      flush
    >
      {(draft.is_followup || followupOf) && (
        <p className="border-b border-border bg-info-bg px-3 py-1.5 text-caption text-info-fg">
          Follow-up of a side effect already on record{" "}
          <span className="font-mono">{followupOf ?? "(id not provided)"}</span>
          {link?.first_session_id && (
            <>
              {" "}
              · first reported in{" "}
              <Link
                to={`/dashboard/checkins/${encodeURIComponent(link.first_session_id)}`}
                className="underline"
              >
                check-in {link.first_session_id.slice(-6)}
              </Link>
            </>
          )}
          . No new record was created (7-day de-duplication window).
        </p>
      )}

      <ProtocolNotes draft={draft} detail={detail} itemIdForTerm={itemIdForTerm} />

      {mode === "edit" ? (
        <EditForm
          draft={draft}
          busy={busy}
          onCancel={() => setMode("view")}
          onSave={(fields, note) => run(() => actions.patch(draft, fields, note))}
        />
      ) : (
        <FieldTable
          draft={draft}
          detail={detail}
          defs={defs}
          selection={selection}
          onSelectField={onSelectField}
          onFocusEvidence={onFocusEvidence}
        />
      )}

      {mode === "reject" && (
        <NoteForm
          draftId={draft.id}
          label="Reject this draft"
          hint="A reason is required; it is written to the audit log."
          submitLabel="Reject draft"
          required
          danger
          busy={busy}
          onCancel={() => setMode("view")}
          onSubmit={(reason) => run(() => actions.reject(draft, reason))}
        />
      )}

      {error !== null && (
        <div className="px-3 pb-2">
          <ErrorBanner error={error} message="The change was not saved" />
        </div>
      )}

      {draft.domain === "AE" && (
        <AttributionBlock
          draft={draft}
          role={role}
          clockHint={attributionClockHint(
            clocksForDraft(clocksOf(detail as unknown as CheckInDetailR3), draft),
          )}
          onSave={(body) => run(() => actions.attribution(draft, body))}
          busy={busy}
        />
      )}

      <div className="px-3 pb-2">
        <VersionHistory draft={draft} />
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Field rows
// ---------------------------------------------------------------------------

function FieldTable({
  draft,
  detail,
  defs,
  selection,
  onSelectField,
}: {
  draft: Draft;
  detail: CheckInDetail;
  defs: Record<string, string> | null;
  selection: Selection;
  onSelectField: (draftId: string, field: string) => void;
  onFocusEvidence: (e: Evidence) => void;
}) {
  const [showDefs, setShowDefs] = useState(false);
  const [showMoreState, setShowMore] = useState(false);
  const hover = gradeHover(defs);
  const r3 = detail as unknown as CheckInDetailR3;
  const labels: Labels = r3.labels;
  // Plain-language first: the record's own fields lead; identity and INTERIM_*
  // provenance fields sit one click deeper (never removed).
  const names = orderedFieldNames(draft);
  const isMore = (n: string) => isProvenanceField(n) || IDENTITY_FIELDS.has(n);
  const main = names.filter((n) => !isMore(n));
  const more = names.filter(isMore);
  const selectedHere =
    selection?.kind === "field" && selection.draftId === draft.id ? selection.field : null;
  // A selected provenance field (e.g. from an evidence click) must stay visible.
  const forcedOpen = selectedHere !== null && more.includes(selectedHere);
  const showMore = showMoreState || forcedOpen;
  const flag = draft.domain === "CM" ? flagForDraft(draft.fields, r3.protocol) : null;

  const row = (name: string) => {
    const value = draft.fields[name];
    const selected = selectedHere === name;
    const evidence = draft.evidence?.[name] ?? [];
    const isGrade = name === "AETOXGR";
    const isAttr = name === "AESER" || name === "AEREL" || name === "INTERIM_IRAE";
    const plain = fieldLabel(name, labels);
    const plainVal = plainValue(name, value, labels);
    const chip = name === "INTERIM_PROTOCOL_FLAG" ? protocolChip(value, flag) : null;
    const word = isGrade ? gradeWord(value) : null;
    // The measured/simulated word sits beside the vitals number itself
    // (VSORRES) and beside the method string, never only in the title.
    const vsBadge =
      draft.domain === "VS" &&
      ((name === "VSORRES" && value !== null && value !== undefined) ||
        (name === "VSMETHOD" && typeof value === "string"));
    return (
      <Fragment key={name}>
        <tr
          data-field={name}
          data-selected={selected ? "true" : "false"}
          className={cx("border-t border-border", highlightClass(selected))}
        >
          <td className="w-60 px-3 py-1 align-top">
            <button
              type="button"
              onClick={() => onSelectField(draft.id, name)}
              aria-expanded={selected}
              aria-label={`${plain} (${name}): show evidence (${evidence.length} pointer${evidence.length === 1 ? "" : "s"})`}
              className="w-full rounded-control text-left hover:text-primary hover:underline"
              title={`Show evidence for ${plain} (${name})`}
            >
              <span className="block text-caption font-medium text-muted-foreground">{plain}</span>
              <SdtmCode name={name} />
              {evidence.length > 0 && (
                <span
                  className="tabular ml-1 rounded-control bg-surface-subtle px-1 text-caption text-muted-foreground"
                  aria-hidden="true"
                >
                  {evidence.length}
                </span>
              )}
            </button>
          </td>
          <td className="px-3 py-1 align-top">
            <button
              type="button"
              onClick={() => onSelectField(draft.id, name)}
              tabIndex={-1}
              className="w-full break-words rounded-control text-left text-table text-foreground hover:bg-surface-subtle"
            >
              {chip ? (
                <Chip className={chip.className} title={chip.title}>
                  {chip.text}
                </Chip>
              ) : isGrade && typeof value === "number" ? (
                <span className="tabular font-semibold" title={hover}>
                  <span>{`Grade ${value}`}</span>
                  {word && (
                    <span className="font-normal text-muted-foreground">{` · ${word}`}</span>
                  )}
                </span>
              ) : (
                <span
                  className={cx(
                    value === null || value === undefined ? "text-subtle-foreground" : "",
                  )}
                  title={plainVal !== null ? `Stored value: ${formatValue(value)}` : undefined}
                >
                  {plainVal ?? formatValue(value)}
                </span>
              )}
              {isGrade && (
                <Chip className="ml-2 border-warning-border bg-warning-bg text-warning-fg">
                  {PROVISIONAL_LABEL}
                </Chip>
              )}
              {isAttr && (value === null || value === undefined) && (
                <span className="ml-2 text-caption text-subtle-foreground">
                  the investigator decides
                </span>
              )}
              {vsBadge && (
                <Prov isMeasured={vsDraftIsMeasured(draft.fields)} className="ml-2 align-middle" />
              )}
              {name === "CMDECOD" && (value === null || value === undefined) && (
                <span className="ml-2 text-caption text-subtle-foreground">
                  not recognized · kept as typed for the coordinator
                </span>
              )}
            </button>
            {isGrade && defs && (
              <div className="mt-0.5">
                <button
                  type="button"
                  onClick={() => setShowDefs((v) => !v)}
                  aria-expanded={showDefs}
                  className="text-caption text-primary underline"
                >
                  {showDefs ? "Hide" : "Show"} CTCAE v5.0 grade definitions
                </button>
                {showDefs && (
                  <dl className="mt-1 space-y-0.5 rounded-control bg-surface-subtle p-2 text-caption text-foreground">
                    {Object.entries(defs)
                      .sort(([a], [b]) => Number(a) - Number(b))
                      .map(([g, t]) => (
                        <div
                          key={g}
                          className={cx(
                            "flex gap-2",
                            Number(g) > MAX_ASSIGNABLE_GRADE && "text-subtle-foreground",
                          )}
                        >
                          <dt className="tabular w-8 shrink-0 font-semibold">G{g}</dt>
                          <dd>
                            {t}
                            {Number(g) > MAX_ASSIGNABLE_GRADE && " (never assigned by Interim)"}
                          </dd>
                        </div>
                      ))}
                  </dl>
                )}
              </div>
            )}
          </td>
        </tr>
      </Fragment>
    );
  };

  return (
    <table className="w-full" aria-label={`${draftTitle(draft)} fields`}>
      <tbody>
        {main.map(row)}
        {more.length > 0 && (
          <tr className="border-t border-border">
            <td colSpan={2} className="px-3 py-1">
              <button
                type="button"
                onClick={() => setShowMore((v) => !v)}
                aria-expanded={showMore}
                disabled={forcedOpen}
                className="text-caption font-medium text-primary underline disabled:no-underline disabled:opacity-60"
              >
                {showMore ? "Hide" : "Show"} {more.length} more field{more.length === 1 ? "" : "s"}{" "}
                (record ids and where the draft came from)
              </button>
            </td>
          </tr>
        )}
        {showMore && more.map(row)}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Protocol notes above the fields (R3.1 / R3.2)
// ---------------------------------------------------------------------------

/** "from check-in" / "from chart note" / "from phone call". */
function sourceLabel(source: string): string {
  if (source === "chart_note") return "from chart note";
  if (source === "phone_call") return "from phone call";
  if (source === "check_in") return "from check-in";
  return `from ${source.replace(/_/g, " ")}`;
}

/**
 * What the study protocol says about this draft, in plain words:
 *  - AE: "Possible special-interest event (report within 24 h, investigator to confirm)"
 *  - CM: "Prohibited by protocol §7.7.1" / "Discouraged by protocol §7.7.2" (exception on hover)
 *  - CM: "Still needed for the medication form: dose, frequency, indication"
 */
function ProtocolNotes({
  draft,
  detail,
  itemIdForTerm,
}: {
  draft: Draft;
  detail: CheckInDetail;
  itemIdForTerm?: (aedecod: string) => string | null;
}) {
  const r3 = detail as unknown as CheckInDetailR3;
  const protocol = r3.protocol ?? null;
  if (draft.domain === "AE") {
    if (!isAesiDraft(draft.fields, protocol, itemIdForTerm)) return null;
    return (
      <p
        className="border-b border-red-100 bg-red-50 px-3 py-1.5 text-table font-medium text-red-900"
        data-testid="aesi-banner"
      >
        {AESI_BANNER}
        <span className="ml-2 font-normal text-aesi-fg">protocol §9.4.3, p. 92</span>
      </p>
    );
  }
  if (draft.domain !== "CM") return null;
  const flag = flagForDraft(draft.fields, protocol);
  const chip = protocolChip(draft.fields.INTERIM_PROTOCOL_FLAG ?? flag?.level, flag);
  const fromCheckIn = draftSource(draft) !== "chart_note";
  const missing = cmMissingText(
    draft.fields.INTERIM_CM_MISSING_FIELDS ?? (fromCheckIn ? protocol?.cm_missing_fields : null),
  );
  if (!chip && !missing) return null;
  const exceptionId = `exception-${draft.id}`;
  const exception = chip?.level === "discouraged" ? flag?.exception_text?.trim() : null;
  return (
    <div
      className="space-y-1 border-b border-border bg-surface-subtle px-3 py-1.5 text-table"
      data-testid="cm-protocol"
    >
      {chip && (
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cx(
              "inline-flex items-center rounded-md border px-1.5 py-0.5 text-caption font-semibold",
              chip.className,
            )}
            title={chip.title}
            tabIndex={chip.title ? 0 : undefined}
            aria-describedby={exception ? exceptionId : undefined}
            data-testid="protocol-chip"
          >
            {chip.text}
          </span>
          {chip.level === "prohibited" && (
            <span className="text-caption text-danger-fg">
              possible protocol deviation · coordinator to confirm
            </span>
          )}
          {exception && (
            <span id={exceptionId} className="sr-only">
              Protocol exception: {exception}
            </span>
          )}
        </div>
      )}
      {missing && (
        <p className="text-caption text-foreground" data-testid="cm-missing">
          {missing}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline editor
// ---------------------------------------------------------------------------

function EditForm({
  draft,
  busy,
  onCancel,
  onSave,
}: {
  draft: Draft;
  busy: boolean;
  onCancel: () => void;
  onSave: (fields: Record<string, unknown>, note: string) => void;
}) {
  const editable = EDITABLE_FIELDS[draft.domain].filter(
    (n) => n in draft.fields || isEditable(draft.domain, n),
  );
  const [text, setText] = useState<Record<string, string>>(() =>
    Object.fromEntries(editable.map((n) => [n, editText(draft.fields[n])])),
  );
  const [note, setNote] = useState("");
  const problems = editable
    .map((n) => [n, editProblem(n, text[n] ?? "")] as const)
    .filter(([, p]) => p);
  const changes = changedFields(draft.fields, text);
  const nothingChanged = Object.keys(changes).length === 0;

  return (
    <form
      className="space-y-2 px-3 py-2"
      onKeyDown={(e) => {
        // Esc cancels; Enter in any field submits (native form behaviour).
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
      onSubmit={(e) => {
        e.preventDefault();
        if (problems.length || nothingChanged) return;
        onSave(changes, note);
      }}
      aria-label={`Edit ${draftTitle(draft)}`}
    >
      <p className="text-caption text-muted-foreground">
        {`Saving creates a new version (v${draft.version + 1}); the previous`} version is kept and
        the edit is audited. Identity, sequence and INTERIM_* provenance fields are not editable.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {editable.map((n) => {
          const problem = editProblem(n, text[n] ?? "");
          const id = `edit-${draft.id}-${n}`;
          return (
            <div key={n}>
              <label htmlFor={id} className="block text-caption text-foreground">
                <span className="font-medium">{fieldLabel(n)}</span> <SdtmCode name={n} />
                {n === "AETOXGR" && (
                  <span className="ml-1 font-sans text-subtle-foreground">
                    (0–{MAX_ASSIGNABLE_GRADE}, {PROVISIONAL_LABEL})
                  </span>
                )}
              </label>
              <input
                id={id}
                value={text[n] ?? ""}
                onChange={(e) => setText((t) => ({ ...t, [n]: e.target.value }))}
                className={cx(
                  "mt-0.5 w-full rounded-control border bg-surface px-2 py-1 text-table",
                  problem ? "border-danger-border" : "border-input",
                )}
                aria-invalid={problem ? true : undefined}
                aria-describedby={problem ? `${id}-problem` : undefined}
                disabled={busy}
                inputMode={n === "AETOXGR" || n === "VSORRES" ? "decimal" : undefined}
              />
              {problem && (
                <p id={`${id}-problem`} className="mt-0.5 text-caption text-danger-fg">
                  {problem}
                </p>
              )}
            </div>
          );
        })}
      </div>
      <div>
        <label
          htmlFor={`edit-note-${draft.id}`}
          className="block text-caption font-medium text-foreground"
        >
          Audit note (optional)
        </label>
        <input
          id={`edit-note-${draft.id}`}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="mt-0.5 w-full rounded-control border border-input bg-surface px-2 py-1 text-table"
          disabled={busy}
          placeholder="Why this edit was made"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          size="sm"
          loading={busy}
          disabled={problems.length > 0 || nothingChanged}
        >
          Save as new version <Hint k="Enter" />
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel <Hint k="Esc" />
        </Button>
        {nothingChanged && (
          <span className="text-caption text-subtle-foreground">No field changed yet.</span>
        )}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Confirm / reject note forms
// ---------------------------------------------------------------------------

function NoteForm({
  draftId,
  label,
  hint,
  submitLabel,
  required,
  danger,
  busy,
  onCancel,
  onSubmit,
}: {
  draftId: string;
  label: string;
  hint: string;
  submitLabel: string;
  required: boolean;
  danger?: boolean;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const [touched, setTouched] = useState(false);
  const missing = required && text.trim() === "";
  // Several cards can be in confirm/reject mode at once, so the id carries the draft id.
  const id = `note-${draftId}-${label.replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <form
      className="space-y-2 border-t border-border px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (missing) return;
        onSubmit(text.trim());
      }}
      aria-label={`${label} form`}
    >
      <label htmlFor={id} className="block text-table font-medium text-foreground">
        {label}
      </label>
      <p className="text-caption text-muted-foreground">{hint}</p>
      <textarea
        id={id}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => setTouched(true)}
        rows={2}
        className={cx(
          "w-full rounded-control border bg-surface px-2 py-1 text-table",
          touched && missing ? "border-danger-border" : "border-input",
        )}
        aria-required={required}
        aria-invalid={touched && missing ? true : undefined}
        disabled={busy}
      />
      {touched && missing && <p className="text-caption text-danger-fg">A reason is required.</p>}
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          size="sm"
          variant={danger ? "danger" : "primary"}
          loading={busy}
          disabled={missing}
        >
          {submitLabel}
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Investigator attribution
// ---------------------------------------------------------------------------

function AttributionBlock({
  draft,
  role,
  clockHint,
  busy,
  onSave,
}: {
  draft: Draft;
  role: Role | null;
  /** Which answer stops which running clock (plain.ts attributionClockHint); null = none running. */
  clockHint: string | null;
  busy: boolean;
  onSave: (body: AttributionRequest) => void;
}) {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const current = {
    AESER: str(draft.fields.AESER),
    AEREL: str(draft.fields.AEREL),
    INTERIM_IRAE: str(draft.fields.INTERIM_IRAE),
  };
  const [aeser, setAeser] = useState(current.AESER);
  const [aerel, setAerel] = useState(current.AEREL);
  const [irae, setIrae] = useState(current.INTERIM_IRAE);
  const [note, setNote] = useState("");
  const investigator = role === "investigator";
  // Attribution is a decision, not a draft field: AESER/AEREL once recorded can
  // be changed to another option but not un-decided, and their blank choice is
  // never sent. "Immune-related?" may go back to "Not decided" (R4.3 accepts
  // null). See attributionBody.
  const body = attributionBody(current, { AESER: aeser, AEREL: aerel, INTERIM_IRAE: irae }, note);
  const changed = body !== null;
  const selectClass =
    "mt-0.5 w-full rounded-control border border-input bg-surface px-2 py-1 text-table";

  const label = (id: string, plain: string, sdtm: string) => (
    <label htmlFor={id} className="block text-caption text-foreground">
      <span className="font-medium">{plain}</span> <SdtmCode name={sdtm} boxed />
    </label>
  );

  return (
    <div className="border-t border-border px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-table font-semibold text-foreground">Investigator assessment</h3>
        {!investigator && (
          <Chip
            className="border-neutral-border bg-neutral-bg text-neutral-fg"
            title="Only the investigator role can set seriousness, relatedness and immune-related"
          >
            investigator only · read-only for your role
          </Chip>
        )}
      </div>
      <div className="mt-2 grid gap-3 sm:grid-cols-3">
        <div>
          {label(`aeser-${draft.id}`, "Serious?", "AESER")}
          {investigator ? (
            <select
              id={`aeser-${draft.id}`}
              value={aeser}
              onChange={(e) => setAeser(e.target.value)}
              className={selectClass}
              disabled={busy}
            >
              <option value="" disabled={current.AESER !== ""}>
                — not decided —
              </option>
              {AESER_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {o === "Y" ? "Yes, serious" : "No, not serious"}
                </option>
              ))}
            </select>
          ) : (
            <div className="mt-0.5 text-table text-foreground">
              {plainValue("AESER", draft.fields.AESER) ?? "not decided"}
            </div>
          )}
        </div>
        <div>
          {label(`aerel-${draft.id}`, "Related to the study drug?", "AEREL")}
          {investigator ? (
            <select
              id={`aerel-${draft.id}`}
              value={aerel}
              onChange={(e) => setAerel(e.target.value)}
              className={selectClass}
              disabled={busy}
            >
              <option value="" disabled={current.AEREL !== ""}>
                — not decided —
              </option>
              {AEREL_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {o.charAt(0) + o.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
          ) : (
            <div className="mt-0.5 text-table text-foreground">
              {typeof draft.fields.AEREL === "string" ? draft.fields.AEREL : "not decided"}
            </div>
          )}
        </div>
        <div>
          {label(`irae-${draft.id}`, "Immune-related?", "INTERIM_IRAE")}
          {investigator ? (
            <select
              id={`irae-${draft.id}`}
              value={irae}
              onChange={(e) => setIrae(e.target.value)}
              className={selectClass}
              disabled={busy}
            >
              <option value="">Not decided</option>
              {IRAE_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {o === "Y" ? "Yes" : "No"}
                </option>
              ))}
            </select>
          ) : (
            <div className="mt-0.5 text-table text-foreground">
              {plainValue("INTERIM_IRAE", draft.fields.INTERIM_IRAE) ?? "Not decided"}
            </div>
          )}
        </div>
      </div>
      <p className="mt-1 text-caption text-subtle-foreground">
        The protocol asks the investigator to assess whether a side effect is immune-related
        (protocol p. 91).
      </p>
      {investigator && (
        <div className="mt-2 space-y-2">
          <div>
            <label
              htmlFor={`attr-note-${draft.id}`}
              className="block text-caption font-medium text-foreground"
            >
              Audit note (optional)
            </label>
            <input
              id={`attr-note-${draft.id}`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="mt-0.5 w-full rounded-control border border-input bg-surface px-2 py-1 text-table"
              disabled={busy}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              loading={busy}
              disabled={!changed}
              onClick={() => {
                if (body) onSave(body);
              }}
            >
              Save attribution
            </Button>
            {clockHint && (
              <span
                className="text-caption text-muted-foreground"
                data-testid="attribution-clock-hint"
              >
                {clockHint}
              </span>
            )}
          </div>
        </div>
      )}
      <div className="mt-3">
        <ReferencePanel />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Version history (GET /drafts/{id}/versions, loaded on open)
// ---------------------------------------------------------------------------

function VersionHistory({ draft }: { draft: Draft }) {
  const [versions, setVersions] = useState<Draft[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  const load = () => {
    if (versions || loading) return;
    setLoading(true);
    setError(null);
    getDraftVersions(draft.id)
      .then((v) => setVersions(Array.isArray(v) ? v : ((v as { items?: Draft[] }).items ?? [])))
      .catch(setError)
      .finally(() => setLoading(false));
  };

  const sorted = versions ? [...versions].sort((a, b) => a.version - b.version) : [];
  return (
    <Disclosure
      summary={
        <span>
          Version history{" "}
          <span className="tabular text-subtle-foreground">{`(current v${draft.version})`}</span>
        </span>
      }
      onToggle={(open) => {
        if (open) load();
      }}
    >
      {loading && <p className="text-caption text-subtle-foreground">Loading versions…</p>}
      <ErrorBanner error={error} message="Version history unavailable" onRetry={load} />
      {versions && sorted.length === 0 && (
        <p className="text-caption text-subtle-foreground">Only this version exists.</p>
      )}
      {sorted.length > 0 && (
        <ol className="space-y-2 text-caption" aria-label="Draft versions">
          {sorted.map((v, i) => {
            const diff = diffVersions(sorted[i - 1] ?? null, v);
            const st = draftStatusStyle(v.status);
            return (
              <li key={v.id} className="rounded-control border border-border p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="tabular font-semibold">{`v${v.version}`}</span>
                  <Chip className={st.className}>{st.label}</Chip>
                  <span className="text-muted-foreground">
                    by <span className="font-medium">{v.created_by}</span> ·{" "}
                    <Time iso={v.created_at} style="short" />
                  </span>
                  <span className="font-mono text-caption text-subtle-foreground">{v.id}</span>
                </div>
                {v.note && <p className="mt-1 text-foreground">Note: {v.note}</p>}
                {diff.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {diff.map((d) => (
                      <li key={d.name} className="font-mono">
                        {d.name}:{" "}
                        <span className="text-subtle-foreground line-through">
                          {formatValue(d.from)}
                        </span>{" "}
                        → <span className="font-semibold text-foreground">{formatValue(d.to)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </Disclosure>
  );
}

/**
 * Pure helpers for the Audit page (CLAUDE.md §3.6, CONTRACTS.md §2.3).
 *
 * Nothing here talks to the network or decides anything clinical; it only turns
 * `AuditEvent` rows into things the table can paint: truncated hashes, the
 * plain-English name of an action, the chain-link status between two adjacent
 * rows, and where an entity id should link to.
 *
 * The authoritative chain check is `GET /audit/verify` on the server. The
 * client-side `chainLinkTo()` below is a visual aid for the rows on screen and
 * is labeled as such in the UI.
 */
import type { AuditEvent } from "../../../lib/types";

// ---------------------------------------------------------------------------
// Hashes
// ---------------------------------------------------------------------------

/** Genesis `prev_hash` is 64 zero characters (CONTRACTS.md §2.3). */
export const GENESIS_PREV_HASH = "0".repeat(64);

/** Characters of a sha256 hex digest shown before the ellipsis. */
export const HASH_PREFIX_LEN = 10;

/** `"3f9a1c…"` style prefix; `"—"` when there is no hash. */
export function truncateHash(hash: string | null | undefined, len = HASH_PREFIX_LEN): string {
  if (!hash) return "—";
  if (hash.length <= len) return hash;
  return `${hash.slice(0, len)}…`;
}

export function isGenesis(e: Pick<AuditEvent, "prev_hash">): boolean {
  return e.prev_hash === GENESIS_PREV_HASH;
}

/**
 * How row `current` relates to the next-older row on the same page (the table
 * is newest first, so "older" is the row below).
 *
 * - `genesis`: `current` is the first event ever written (prev_hash all zeros).
 * - `end`: there is no older row on this page to compare against (the
 *   predecessor is on a later page, or excluded by a server filter).
 * - `gap`: the older row is not the immediate predecessor (filters / page edge),
 *   so no comparison is possible here.
 * - `linked`: `current.prev_hash === older.hash`, as the chain requires.
 * - `broken`: adjacent by `seq` but the hashes do not connect.
 */
export type ChainLink = "genesis" | "end" | "gap" | "linked" | "broken";

export function chainLinkTo(current: AuditEvent, older: AuditEvent | undefined): ChainLink {
  if (isGenesis(current)) return "genesis";
  if (!older) return "end";
  const adjacentBySeq =
    typeof current.seq === "number" && typeof older.seq === "number"
      ? older.seq === current.seq - 1
      : // Without sequence numbers we can only compare the hashes themselves.
        true;
  if (!adjacentBySeq) return "gap";
  return current.prev_hash === older.hash ? "linked" : "broken";
}

export const CHAIN_LINK_TEXT: Record<ChainLink, string> = {
  genesis: "Genesis event: prev_hash is 64 zeros",
  end: "Oldest event on this page; nothing below it to compare (its predecessor is on a later page or excluded by the filter)",
  gap: "Not adjacent to the row below (filtered or page edge); nothing to compare",
  linked: "prev_hash equals the hash of the event below (chain intact here)",
  broken: "prev_hash does NOT equal the hash of the event below",
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Plain-English gloss per audit action (CONTRACTS.md §2.3 and R2.4). */
export const ACTION_DESCRIPTIONS: Record<string, string> = {
  "session.started": "Check-in session started at the kiosk",
  "session.consent": "Participant answered the camera consent question",
  "answer.recorded": "Participant answer recorded",
  "answer.updated": "Participant changed an earlier answer",
  "gates.recorded": "Gate questions recorded (hospitalization, medication change, free text)",
  "vitals.batch": "Batch of vitals samples stored from the bridge",
  "session.completed": "Check-in completed; rules engine ran",
  "rule.fired": "A deterministic rule matched",
  "draft.created": "EDC draft created (AE, VS or CM)",
  "draft.edited": "Draft edited; a new version row was created",
  "draft.confirmed": "Draft confirmed by a coordinator",
  "draft.rejected": "Draft rejected by a coordinator",
  "draft.attribution": "Investigator set causality or seriousness",
  "escalation.created": "Escalation tier assigned",
  "escalation.paged": "On-call role paged (mock pager)",
  "escalation.acked": "Escalation acknowledged",
  "sae_clock.started": "SAE reporting clock started (site awareness)",
  "sae_clock.stopped": "SAE reporting clock stopped by an investigator decision",
  "export.generated": "Export generated (CSV, JSON or bundle)",
  "mock_edc.posted": "Confirmed records posted to the mock EDC",
  "settings.changed": "Admin changed a setting",
  "demo.reset": "Demo data reset",
  "demo.seeded": "Demo study, participants and baseline check-ins seeded (all synthetic)",
  "eval.run": "Evaluation harness run",
  "auth.login": "Dashboard user signed in",
  "note.ingested": "Chart note ingested",
  "note.scanned": "Chart note scanned for AEs and medications",
  "drafts.applied": "Rules outcome applied: drafts, escalation, page and SAE clock written",
  "ae_open.closed": "Open AE marked no longer ongoing (dedup/follow-up bookkeeping)",
};

/** Every action string the API emits, for the Action filter datalist (server matches exactly). */
export const KNOWN_ACTIONS: readonly string[] = Object.keys(ACTION_DESCRIPTIONS);

/** Gloss for an action; unknown actions get a readable fallback, never an empty string. */
export function describeAction(action: string | null | undefined): string {
  if (!action) return "Unknown action";
  const known = ACTION_DESCRIPTIONS[action];
  if (known) return known;
  // "foo.bar_baz" → "foo: bar baz"
  const [entity, ...rest] = action.split(".");
  const verb = rest.join(".").replace(/_/g, " ");
  return verb ? `${entity}: ${verb}` : action;
}

// ---------------------------------------------------------------------------
// Actors and entities
// ---------------------------------------------------------------------------

/** Chip classes per actor role; unknown roles fall back to neutral slate. */
export const ACTOR_ROLE_CLASSES: Record<string, string> = {
  participant: "bg-brand-50 text-brand-900 border-brand-200",
  system: "bg-slate-100 text-slate-700 border-slate-300",
  coordinator: "bg-sky-100 text-sky-900 border-sky-300",
  investigator: "bg-indigo-100 text-indigo-900 border-indigo-300",
  admin: "bg-slate-800 text-white border-slate-900",
};

export function actorRoleClass(role: string | null | undefined): string {
  return (role && ACTOR_ROLE_CLASSES[role]) || "bg-slate-100 text-slate-700 border-slate-300";
}

/**
 * Suggestions for the entity_type filter: the values `append_event` is called
 * with in `apps/api/interim_api` (vitals batches and rule firings are logged on
 * their `session`; exports on `export`; seed/reset on `database`). The API
 * accepts any string, so this is a hint list, not a validator.
 */
export const KNOWN_ENTITY_TYPES: readonly string[] = [
  "session",
  "answer",
  "draft",
  "escalation",
  "sae_clock",
  "ae_open",
  "note",
  "export",
  "mock_edc",
  "settings",
  "eval_run",
  "database",
  "user",
];

export interface EntityLink {
  to: string;
  /** What the link opens, for the title attribute. */
  label: string;
}

/**
 * Where an entity id can be opened in the dashboard. Sessions link to the
 * check-in detail page; chart notes to the note detail page (R2.4);
 * participants to their timeline; anything else links to its session when the
 * payload names one.
 */
export function entityLinkFor(e: AuditEvent): EntityLink | null {
  const type = (e.entity_type ?? "").toLowerCase();
  if ((type === "session" || type === "checkin" || type === "check_in") && e.entity_id) {
    return { to: `/dashboard/checkins/${encodeURIComponent(e.entity_id)}`, label: "Open check-in" };
  }
  if (type === "note" && e.entity_id) {
    return { to: `/dashboard/notes/${encodeURIComponent(e.entity_id)}`, label: "Open chart note" };
  }
  if (type === "participant" && e.entity_id) {
    return {
      to: `/dashboard/participants/${encodeURIComponent(e.entity_id)}`,
      label: "Open participant timeline",
    };
  }
  const payload = normalizePayload(e.payload);
  const sessionId = payload?.session_id;
  if (typeof sessionId === "string" && sessionId) {
    return {
      to: `/dashboard/checkins/${encodeURIComponent(sessionId)}`,
      label: "Open the check-in this event belongs to",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/** The payload as an object, or null when the API sent nothing usable. */
export function normalizePayload(p: unknown): Record<string, unknown> | null {
  if (p && typeof p === "object" && !Array.isArray(p)) return p as Record<string, unknown>;
  return null;
}

/** Pretty JSON that never throws (circular or undefined payloads become text). */
export function prettyJson(v: unknown): string {
  if (v === undefined) return "null";
  try {
    return JSON.stringify(v, null, 2) ?? "null";
  } catch {
    return String(v);
  }
}

export type PayloadHighlight =
  | { kind: "measured"; isMeasured: boolean; source: string | null }
  | { kind: "tier"; tier: number }
  | { kind: "text"; label: string; value: string };

const MAX_TEXT_HIGHLIGHTS = 3;
const MAX_HIGHLIGHT_VALUE_LEN = 48;

/** Keys consumed by `measuredFlags`, so they are not repeated as text chips. */
const MEASURED_KEYS = ["is_measured", "isMeasured", "simulated", "source", "sources"] as const;

/**
 * The measured/simulated flag(s) a payload carries, in every shape the API
 * writes:
 *
 * - `vitals.batch` (apps/api services/sessions.py): `is_measured: bool[]` (the
 *   distinct values in the batch), `simulated: bool`, `sources: string[]`.
 * - per-sample shapes: `is_measured: bool` / `isMeasured: bool`, `source: string`.
 *
 * A batch that mixes measured and simulated samples yields one entry per
 * value, so both words are shown rather than averaging them away (CLAUDE.md §13).
 * Returns an empty array when the payload says nothing about measurement.
 */
export function measuredFlags(payload: Record<string, unknown>): boolean[] {
  const raw = payload.is_measured ?? payload.isMeasured;
  if (typeof raw === "boolean") return [raw];
  if (Array.isArray(raw) && raw.length > 0 && raw.every((v) => typeof v === "boolean")) {
    const values = new Set(raw as boolean[]);
    // Measured first so a mixed batch reads "MEASURED … SIMULATED …".
    return [...values].sort((a, b) => Number(b) - Number(a));
  }
  if (typeof payload.simulated === "boolean") return [!payload.simulated];
  return [];
}

/** `source` (string) or `sources` (string[]) joined, else null. */
export function sourceLabel(payload: Record<string, unknown>): string | null {
  if (typeof payload.source === "string" && payload.source) return payload.source;
  if (Array.isArray(payload.sources)) {
    const names = payload.sources.filter((v): v is string => typeof v === "string" && v !== "");
    if (names.length) return names.join(", ");
  }
  return null;
}

/**
 * A few payload facts worth showing on the row without expanding it. Vitals
 * events always surface their MEASURED/SIMULATED label (CLAUDE.md §13), tiers
 * get a chip, then up to three short scalar fields.
 */
export function payloadHighlights(e: AuditEvent): PayloadHighlight[] {
  const payload = normalizePayload(e.payload);
  if (!payload) return [];
  const out: PayloadHighlight[] = [];
  const used = new Set<string>();

  const flags = measuredFlags(payload);
  if (flags.length) {
    const source = sourceLabel(payload);
    for (const isMeasured of flags) out.push({ kind: "measured", isMeasured, source });
    for (const k of MEASURED_KEYS) used.add(k);
  }

  const tier = payload.tier;
  if (typeof tier === "number" && Number.isInteger(tier)) {
    out.push({ kind: "tier", tier });
    used.add("tier");
  }

  let textCount = 0;
  for (const [key, value] of Object.entries(payload)) {
    if (textCount >= MAX_TEXT_HIGHLIGHTS) break;
    if (used.has(key)) continue;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      continue;
    }
    let text = String(value);
    if (!text) continue;
    if (text.length > MAX_HIGHLIGHT_VALUE_LEN) text = `${text.slice(0, MAX_HIGHLIGHT_VALUE_LEN)}…`;
    out.push({ kind: "text", label: key, value: text });
    textCount += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sorting and downloads
// ---------------------------------------------------------------------------

/** Newest first by `seq` (falls back to `ts_utc`); the API already does this, but a page should not depend on it. */
export function sortNewestFirst(items: AuditEvent[]): AuditEvent[] {
  return [...items].sort((a, b) => {
    if (typeof a.seq === "number" && typeof b.seq === "number") return b.seq - a.seq;
    return (b.ts_utc ?? "").localeCompare(a.ts_utc ?? "");
  });
}

/**
 * Hand a Blob to the browser as a download. Export endpoints need the bearer
 * token, which a plain `<a href>` cannot send, so pages fetch the Blob through
 * `api.ts` and call this. Returns false when the environment has no object URLs
 * (jsdom, very old browsers) so the caller can fall back to a message.
 */
export function saveBlob(blob: Blob, filename: string): boolean {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return false;
  const href = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = href;
    a.download = filename;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  } finally {
    // Give the click a tick before revoking so the download starts.
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }
}

/** Best-effort clipboard write; resolves false when the Clipboard API is unavailable. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

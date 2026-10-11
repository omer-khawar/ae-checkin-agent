/**
 * The single typed API client for Interim (CONTRACTS.md §2).
 *
 * - Base is the relative `/api/v1`: Vite proxies it in dev, nginx in Docker.
 * - Bearer token comes from `sessionStorage` (see `auth.ts`); kiosk endpoints
 *   work without one.
 * - Errors are RFC 7807 problem+json and are surfaced as `ApiError`.
 * - One function per endpoint, including the Revision 2-4 endpoints (chart
 *   notes, phone calls, report packets, visit briefs, sponsor queries, time
 *   saved). Pages import from here only; no page keeps its own fetch helper.
 * - A few wrappers return a normalized shape (packets, briefs, notes, the whole
 *   queue). Those normalizers are pure functions that live next to the page
 *   that renders the shape (`pages/dashboard/<page>/model.ts|normalize.ts`) and
 *   import nothing from this file, so there is no import cycle.
 *
 * No retries, no caching, no magic: every function is `fetch` + JSON.
 */
import { normalizeBrief } from "../pages/dashboard/brief/model";
import {
  normalizeNoteDetail,
  normalizeNotesPage,
  normalizeScan,
} from "../pages/dashboard/notes/normalize";
import {
  normalizeClocks as normalizePacketClocks,
  normalizePacket,
  unwrapPacket,
} from "../pages/dashboard/packets/model";
import { normalizeQueueItem } from "../pages/dashboard/queue/normalize";
import type { QueueRow } from "../pages/dashboard/queue/types";
import type {
  AdminResetResponse,
  Answer,
  AnswerQueryRequest,
  AnswerRequest,
  AttributionRequest,
  AuditEvent,
  AuditListQuery,
  AuditVerifyResult,
  Brief,
  BriefQuery,
  CheckInDetail,
  ClockRow,
  CompleteRequest,
  CompleteResponse,
  MessageList,
  UrgentRequest,
  CreateSessionRequest,
  CtcaeTerm,
  Domain,
  Draft,
  Escalation,
  EvalCustomResponse,
  EvalPersonaSummary,
  EvalResults,
  EvalRunRequest,
  ExportJson,
  ExportStatusFilter,
  GatesRequest,
  GatesResponse,
  Health,
  ItemsResponse,
  LoginRequest,
  LoginResponse,
  MockEdcAck,
  NoteDetailResponse,
  NoteIngestRequest,
  NoteIngestResponse,
  NotesPage,
  NotesQuery,
  Packet,
  PacketClock,
  PacketRef,
  PageEvent,
  Paginated,
  Participant,
  PatchPacketRequest,
  Persona,
  PhoneCallRequest,
  Problem,
  PublicSettings,
  QueriesListQuery,
  QueriesPage,
  QueryCounts,
  QueryDetail,
  QueryRow,
  QueryStatus,
  QueueItem,
  QueueQuery,
  RaiseQueryRequest,
  ReferenceLabel,
  SAEClockRow,
  SaeClocksQuery,
  ScanRequest,
  ScanResult,
  Session,
  Settings,
  SettingsUpdate,
  StopClockRequest,
  Study,
  Timeline,
  TimeSavedMetrics,
  VitalsPostRequest,
  VitalsPostResponse,
} from "./types";

export const API_BASE = "/api/v1";

/** sessionStorage key holding the JSON `LoginResponse`. Owned by auth.ts. */
export const AUTH_STORAGE_KEY = "interim.auth";
/** Fired on `window` when a request that carried a bearer token got HTTP 401. */
export const UNAUTHORIZED_EVENT = "interim:unauthorized";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown for every non-2xx response. `problem` is always populated: when the
 * server did not send problem+json (e.g. a proxy 502 HTML page) we synthesise one
 * from the status so callers have one shape to handle.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly problem: Problem;
  readonly url: string;

  constructor(url: string, problem: Problem) {
    super(problem.detail ? `${problem.title}: ${problem.detail}` : problem.title);
    this.name = "ApiError";
    this.url = url;
    this.status = problem.status;
    this.problem = problem;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
  get isForbidden(): boolean {
    return this.status === 403;
  }
  get isValidation(): boolean {
    return this.status === 422 || this.status === 400;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** Thrown when `fetch` itself rejects (network down, API not started). */
export class NetworkError extends Error {
  readonly url: string;
  constructor(url: string, cause: unknown) {
    super("Could not reach the Interim API");
    this.name = "NetworkError";
    this.url = url;
    this.cause = cause;
  }
}

/** Human-readable message for any error thrown by this client. */
export function describeError(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof NetworkError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Parse a non-2xx response body into a `Problem`. Exported for tests.
 * Accepts problem+json, FastAPI's `{detail: ...}` and arbitrary text.
 */
export async function parseProblem(res: Response): Promise<Problem> {
  const fallback: Problem = {
    type: "about:blank",
    title: res.statusText || `HTTP ${res.status}`,
    status: res.status,
  };
  let text = "";
  try {
    text = await res.text();
  } catch {
    return fallback;
  }
  if (!text) return fallback;
  try {
    const body = JSON.parse(text) as unknown;
    if (body && typeof body === "object") {
      const b = body as Record<string, unknown>;
      if (typeof b.title === "string" && typeof b.status === "number") {
        return { ...fallback, ...(b as Partial<Problem>), status: b.status, title: b.title };
      }
      // FastAPI default error shape.
      if ("detail" in b) {
        const detail = typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail);
        return {
          ...fallback,
          detail,
          ...(typeof b.detail !== "string" ? { errors: b.detail } : {}),
        };
      }
      return { ...fallback, detail: text };
    }
  } catch {
    /* not JSON */
  }
  return { ...fallback, detail: text.slice(0, 500) };
}

// ---------------------------------------------------------------------------
// Token access (read-only here; auth.ts writes it)
// ---------------------------------------------------------------------------

export function getStoredToken(): string | null {
  try {
    const raw = sessionStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LoginResponse>;
    return typeof parsed.token === "string" ? parsed.token : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core request helper
// ---------------------------------------------------------------------------

type Query = Record<string, string | number | boolean | undefined | null>;

/** Build `?a=1&b=x`, skipping undefined/null. Exported for tests and URL builders. */
export function buildQuery(q?: Query): string {
  if (!q) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null) continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Query;
  /** Extra headers (e.g. none for kiosk). The bearer token is added automatically. */
  headers?: Record<string, string>;
  /** `Accept` header; JSON + problem+json by default. */
  accept?: string;
  signal?: AbortSignal;
}

const JSON_ACCEPT = "application/json, application/problem+json";

function isAbortError(e: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" && e instanceof DOMException && e.name === "AbortError") ||
    (e instanceof Error && e.name === "AbortError")
  );
}

/**
 * The one place that calls `fetch`. Adds the bearer token, encodes a JSON body,
 * maps non-2xx to `ApiError` and a rejected fetch to `NetworkError`. An abort is
 * not a network failure: the caller sees the AbortError as thrown.
 */
async function send(path: string, opts: RequestOptions = {}): Promise<Response> {
  const url = `${API_BASE}${path}${buildQuery(opts.query)}`;
  const headers: Record<string, string> = {
    Accept: opts.accept ?? JSON_ACCEPT,
    ...opts.headers,
  };
  const token = getStoredToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(url, { method: opts.method ?? "GET", headers, body, signal: opts.signal });
  } catch (e) {
    if (isAbortError(e)) throw e;
    throw new NetworkError(url, e);
  }
  if (!res.ok) {
    // A bearer token the server no longer accepts (expired, or the API restarted with a new
    // secret): drop it and tell auth.ts so the app routes to /login instead of failing quietly.
    if (res.status === 401 && token && path !== "/auth/login") {
      try {
        sessionStorage.removeItem(AUTH_STORAGE_KEY);
      } catch {
        /* storage unavailable */
      }
      if (typeof window !== "undefined") window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    throw new ApiError(url, await parseProblem(res));
  }
  return res;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await send(path, opts);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/** For `GET` endpoints that return a file (CSV/zip/JSON download); returns the raw Blob. */
async function requestBlob(path: string, query?: Query): Promise<Blob> {
  const res = await send(path, { query, accept: "*/*" });
  return res.blob();
}

/** For `GET` endpoints that return a printable HTML page; returns the text. */
async function requestHtml(
  path: string,
  opts: Pick<RequestOptions, "query" | "signal"> = {},
): Promise<string> {
  const res = await send(path, { ...opts, accept: "text/html, application/problem+json" });
  return res.text();
}

/** Current wall clock as the contract's UTC ISO string with milliseconds. */
export function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Pagination helpers
// ---------------------------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 25;

export interface PageInfo {
  /** 1-based current page */
  page: number;
  pages: number;
  hasPrev: boolean;
  hasNext: boolean;
  /** 1-based index of the first/last item on this page (0/0 when empty) */
  from: number;
  to: number;
}

export function pageInfo(p: Pick<Paginated<unknown>, "total" | "limit" | "offset">): PageInfo {
  const limit = Math.max(1, p.limit);
  const pages = Math.max(1, Math.ceil(p.total / limit));
  const page = Math.min(pages, Math.floor(p.offset / limit) + 1);
  const from = p.total === 0 ? 0 : p.offset + 1;
  const to = Math.min(p.total, p.offset + limit);
  return { page, pages, hasPrev: p.offset > 0, hasNext: p.offset + limit < p.total, from, to };
}

/** `{limit, offset}` for a 1-based page number. */
export function pageParams(
  page: number,
  pageSize = DEFAULT_PAGE_SIZE,
): { limit: number; offset: number } {
  const safePage = Math.max(1, Math.floor(page));
  return { limit: pageSize, offset: (safePage - 1) * pageSize };
}

/** Walk every page of a paginated endpoint (bounded by `maxPages`). */
export async function fetchAllPages<T>(
  fetchPage: (limit: number, offset: number) => Promise<Paginated<T>>,
  pageSize = 100,
  maxPages = 50,
): Promise<T[]> {
  const out: T[] = [];
  let offset = 0;
  for (let i = 0; i < maxPages; i++) {
    const page = await fetchPage(pageSize, offset);
    out.push(...page.items);
    offset += page.limit;
    if (offset >= page.total || page.items.length === 0) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// §2 Auth
// ---------------------------------------------------------------------------

export function login(body: LoginRequest): Promise<LoginResponse> {
  return request<LoginResponse>("/auth/login", { method: "POST", body });
}

// ---------------------------------------------------------------------------
// §2.1 Kiosk (no token required)
// ---------------------------------------------------------------------------

export function getHealth(): Promise<Health> {
  return request<Health>("/health");
}

export function getStudy(): Promise<Study> {
  return request<Study>("/study");
}

export function getItems(): Promise<ItemsResponse> {
  return request<ItemsResponse>("/items");
}

export function getPublicSettings(): Promise<PublicSettings> {
  return request<PublicSettings>("/settings/public");
}

export function createSession(body: CreateSessionRequest): Promise<Session> {
  return request<Session>("/sessions", { method: "POST", body });
}

export function getSession(sessionId: string): Promise<Session> {
  return request<Session>(`/sessions/${encodeURIComponent(sessionId)}`);
}

export function postAnswer(sessionId: string, body: AnswerRequest): Promise<Answer> {
  return request<Answer>(`/sessions/${encodeURIComponent(sessionId)}/answers`, {
    method: "POST",
    body,
  });
}

export function postGates(sessionId: string, body: GatesRequest): Promise<GatesResponse> {
  return request<GatesResponse>(`/sessions/${encodeURIComponent(sessionId)}/gates`, {
    method: "POST",
    body,
  });
}

/** Normally the bridge posts vitals; exposed for completeness and the eval form. */
export function postVitals(
  sessionId: string,
  body: VitalsPostRequest,
): Promise<VitalsPostResponse> {
  return request<VitalsPostResponse>(`/sessions/${encodeURIComponent(sessionId)}/vitals`, {
    method: "POST",
    body,
  });
}

export function completeSession(
  sessionId: string,
  body: CompleteRequest,
): Promise<CompleteResponse> {
  return request<CompleteResponse>(`/sessions/${encodeURIComponent(sessionId)}/complete`, {
    method: "POST",
    body,
  });
}

/**
 * R5.1: end the check-in at once (urgent_now = Yes, or severe shortness of breath).
 * Idempotent per session; returns the same body as /complete plus `ended_early`.
 */
export function postUrgent(sessionId: string, body: UrgentRequest): Promise<CompleteResponse> {
  return request<CompleteResponse>(`/sessions/${encodeURIComponent(sessionId)}/urgent`, {
    method: "POST",
    body,
  });
}

// ---------------------------------------------------------------------------
// §2.2 Dashboard (token required)
// ---------------------------------------------------------------------------

export function getQueue(q: QueueQuery = {}): Promise<Paginated<QueueItem>> {
  return request<Paginated<QueueItem>>("/queue", { query: { ...q } });
}

export function getCheckIn(sessionId: string): Promise<CheckInDetail> {
  return request<CheckInDetail>(`/checkins/${encodeURIComponent(sessionId)}`);
}

export function listParticipants(
  q: { limit?: number; offset?: number } = {},
): Promise<Paginated<Participant>> {
  return request<Paginated<Participant>>("/participants", { query: { ...q } });
}

export function getParticipant(usubjid: string): Promise<Participant> {
  return request<Participant>(`/participants/${encodeURIComponent(usubjid)}`);
}

export function getTimeline(usubjid: string): Promise<Timeline> {
  return request<Timeline>(`/participants/${encodeURIComponent(usubjid)}/timeline`);
}

export function getDraft(draftId: string): Promise<Draft> {
  return request<Draft>(`/drafts/${encodeURIComponent(draftId)}`);
}

export function getDraftVersions(draftId: string): Promise<Draft[]> {
  return request<Draft[]>(`/drafts/${encodeURIComponent(draftId)}/versions`);
}

export function confirmDraft(draftId: string, note?: string): Promise<Draft> {
  return request<Draft>(`/drafts/${encodeURIComponent(draftId)}/confirm`, {
    method: "POST",
    body: note ? { note } : {},
  });
}

export function rejectDraft(draftId: string, reason: string): Promise<Draft> {
  return request<Draft>(`/drafts/${encodeURIComponent(draftId)}/reject`, {
    method: "POST",
    body: { reason },
  });
}

/** Creates a new version row (supersedes the current one). */
export function patchDraft(
  draftId: string,
  fields: Record<string, unknown>,
  note?: string,
): Promise<Draft> {
  return request<Draft>(`/drafts/${encodeURIComponent(draftId)}`, {
    method: "PATCH",
    body: note ? { fields, note } : { fields },
  });
}

/**
 * Investigator only. Setting AESER stops the SAE clock. R4.3 adds the
 * immune-related choice (`INTERIM_IRAE`).
 */
export function patchAttribution(draftId: string, body: AttributionRequest): Promise<Draft> {
  return request<Draft>(`/drafts/${encodeURIComponent(draftId)}/attribution`, {
    method: "PATCH",
    body,
  });
}

export function listEscalations(
  q: { acked?: boolean; limit?: number; offset?: number } = {},
): Promise<Paginated<Escalation>> {
  return request<Paginated<Escalation>>("/escalations", { query: { ...q } });
}

export function ackEscalation(escalationId: string): Promise<Escalation> {
  return request<Escalation>(`/escalations/${encodeURIComponent(escalationId)}/ack`, {
    method: "POST",
    body: {},
  });
}

export function listSaeClocks(active = true): Promise<SAEClockRow[] | Paginated<SAEClockRow>> {
  return request<SAEClockRow[] | Paginated<SAEClockRow>>("/sae-clocks", { query: { active } });
}

/**
 * One page of report clocks (SAE and AESI). The contract does not pin whether
 * the response is a bare array or a `{items,total,limit,offset}` envelope; the
 * API sends the envelope. A bare array is treated as the complete list
 * (total = length) so `fetchAllPages` stops after it.
 */
export async function listSaeClocksPage(q: SaeClocksQuery): Promise<Paginated<ClockRow>> {
  const body = await request<ClockRow[] | Paginated<ClockRow> | null | undefined>("/sae-clocks", {
    query: { active: q.active, limit: q.limit, offset: q.offset },
  });
  if (Array.isArray(body)) {
    return { items: body, total: body.length, limit: Math.max(1, body.length), offset: 0 };
  }
  if (body && Array.isArray(body.items)) {
    return {
      items: body.items,
      total: typeof body.total === "number" ? body.total : body.items.length,
      limit: typeof body.limit === "number" && body.limit > 0 ? body.limit : q.limit,
      offset: typeof body.offset === "number" ? body.offset : q.offset,
    };
  }
  return { items: [], total: 0, limit: q.limit, offset: q.offset };
}

/** R4.3: investigator-only seriousness decision on a clock with no AE draft. */
export function stopClock(clockId: string, body: StopClockRequest): Promise<ClockRow> {
  return request<ClockRow>(`/sae-clocks/${encodeURIComponent(clockId)}/stop`, {
    method: "PATCH",
    body,
  });
}

export function listPages(
  q: { limit?: number; offset?: number } = {},
): Promise<Paginated<PageEvent>> {
  return request<Paginated<PageEvent>>("/pages", { query: { ...q } });
}

// ---- Exports --------------------------------------------------------------

export interface ExportOptions {
  status?: ExportStatusFilter;
  per_sample?: boolean;
}

/** URL for an `<a download>` link; the browser attaches no bearer header, so callers
 *  that need auth should use `exportBlob` instead. */
export function exportUrl(
  domain: Domain,
  format: "csv" | "json",
  opts: ExportOptions = {},
): string {
  return `${API_BASE}/export/${domain}.${format}${buildQuery({ ...opts })}`;
}

export function exportJson(domain: Domain, opts: ExportOptions = {}): Promise<ExportJson> {
  return request<ExportJson>(`/export/${domain}.json`, { query: { ...opts } });
}

export function exportBlob(
  domain: Domain,
  format: "csv" | "json",
  opts: ExportOptions = {},
): Promise<Blob> {
  return requestBlob(`/export/${domain}.${format}`, { ...opts });
}

/** URL the bundle download hits (`?status=confirmed|all`), for hover titles. */
export function bundleUrl(status?: ExportStatusFilter): string {
  return `${API_BASE}/export/bundle.zip${buildQuery({ status })}`;
}

/** `GET /export/bundle.zip?status=` as a Blob (the endpoint needs the bearer header). */
export function exportBundle(status?: ExportStatusFilter): Promise<Blob> {
  return requestBlob("/export/bundle.zip", { status });
}

export function postMockEdc(
  domain: Domain,
  records: Array<Record<string, unknown>>,
): Promise<MockEdcAck> {
  return request<MockEdcAck>(`/mock-edc/${domain}`, { method: "POST", body: { records } });
}

// ---- Audit ----------------------------------------------------------------

/** `GET /audit` with every filter the server supports. Empty strings are dropped. */
export function listAudit(q: AuditListQuery = {}): Promise<Paginated<AuditEvent>> {
  return request<Paginated<AuditEvent>>("/audit", {
    query: {
      entity_type: q.entity_type || undefined,
      entity_id: q.entity_id || undefined,
      action: q.action || undefined,
      actor_id: q.actor_id || undefined,
      limit: q.limit,
      offset: q.offset,
    },
  });
}

export function verifyAudit(): Promise<AuditVerifyResult> {
  return request<AuditVerifyResult>("/audit/verify");
}

// ---- Eval -----------------------------------------------------------------

export function listEvalPersonas(): Promise<EvalPersonaSummary[]> {
  return request<EvalPersonaSummary[]>("/eval/personas");
}

export function runEval(body: EvalRunRequest = {}): Promise<EvalResults> {
  return request<EvalResults>("/eval/run", { method: "POST", body });
}

export function runCustomEval(persona: Persona): Promise<EvalCustomResponse> {
  return request<EvalCustomResponse>("/eval/run-custom", { method: "POST", body: { persona } });
}

/**
 * The last stored run, or null when none has run yet. `if_any=true` makes the
 * API answer 204 instead of 404 in that case, so an empty Eval page does not
 * log a failed request in the browser console.
 */
export async function getEvalResults(): Promise<EvalResults | null> {
  const r = await request<EvalResults | undefined>("/eval/results?if_any=true");
  return r ?? null;
}

// ---- Whole queue (dashboard "Since you were last here" summary) ----------

/** Page size and cap for the summary fetch (5 x 100 rows covers the demo many times over). */
export const SUMMARY_PAGE_SIZE = 100;
export const SUMMARY_MAX_PAGES = 5;

/** The whole non-eval queue, every status, normalized; `total` says if it was cut short. */
export async function fetchWholeQueue(): Promise<{ rows: QueueRow[]; total: number }> {
  let total = 0;
  const items = await fetchAllPages(
    async (limit, offset) => {
      const page = await getQueue({ status: "all", include_eval: false, limit, offset });
      total = page.total;
      return page;
    },
    SUMMARY_PAGE_SIZE,
    SUMMARY_MAX_PAGES,
  );
  return { rows: items.map(normalizeQueueItem), total };
}

// ---- R2.4 Chart notes and R4.1 phone calls --------------------------------

/** `note_type` that marks a chart note as a logged phone call (R4.1). */
export const PHONE_CALL_NOTE_TYPE = "phone_call";

/** Dry run: scan text without storing anything. */
export async function scanNote(body: ScanRequest): Promise<ScanResult> {
  const raw = await request<unknown>("/scan", { method: "POST", body });
  return normalizeScan(raw);
}

/** Store the note, scan it, create drafts, maybe escalate / start the SAE clock. */
export async function ingestNote(body: NoteIngestRequest): Promise<NoteIngestResponse> {
  const raw = await request<unknown>("/notes", { method: "POST", body });
  return normalizeNoteDetail(raw);
}

export async function listNotes(q: NotesQuery = {}): Promise<NotesPage> {
  const raw = await request<unknown>("/notes", { query: { ...q } });
  return normalizeNotesPage(raw, q);
}

export async function getNote(noteId: string): Promise<NoteDetailResponse> {
  const raw = await request<unknown>(`/notes/${encodeURIComponent(noteId)}`);
  return normalizeNoteDetail(raw);
}

/** R4.1 "Log a call": `POST /notes` with note_type "phone_call", scanned like a chart note. */
export function logPhoneCall(body: PhoneCallRequest): Promise<NoteIngestResponse> {
  return ingestNote({ ...body, note_type: PHONE_CALL_NOTE_TYPE });
}

// ---- R3.2 / R4.2 Report packets -------------------------------------------

/** Create (or fetch the existing) packet for a 24-hour clock. Coordinator+. */
export async function createPacket(clockId: string): Promise<Packet> {
  const raw = await request<unknown>("/packets", { method: "POST", body: { clock_id: clockId } });
  return normalizePacket(unwrapPacket(raw));
}

/**
 * Same `POST /packets {clock_id}` as `createPacket`, un-normalized: for pages
 * that only need the id to navigate to the packet page.
 */
export function openPacket(clockId: string): Promise<PacketRef> {
  return request<PacketRef>("/packets", { method: "POST", body: { clock_id: clockId } });
}

export async function getPacket(packetId: string): Promise<Packet> {
  const raw = await request<unknown>(`/packets/${encodeURIComponent(packetId)}`);
  return normalizePacket(unwrapPacket(raw));
}

/** Edit fields and/or the narrative. The API stores a new version and audits `packet.edited`. */
export async function patchPacket(packetId: string, body: PatchPacketRequest): Promise<Packet> {
  const raw = await request<unknown>(`/packets/${encodeURIComponent(packetId)}`, {
    method: "PATCH",
    body,
  });
  return normalizePacket(unwrapPacket(raw));
}

/**
 * Investigator only. Marks the packet signed, stops the clock as
 * "reported (mock)", audits `packet.signed` / `packet.followup_signed` and
 * posts the packet to the mock EDC. Nothing is sent anywhere real.
 */
export async function signPacket(
  packetId: string,
  opts?: { missingNotAvailable?: string[] },
): Promise<Packet> {
  // Called only from the sign confirmation dialog, which shows the narrative and the
  // missing-information count: confirming there is the investigator's attestation. The
  // API refuses a signature that does not carry it (422).
  const raw = await request<unknown>(`/packets/${encodeURIComponent(packetId)}/sign`, {
    method: "POST",
    body:
      opts?.missingNotAvailable !== undefined
        ? {
            narrative_reviewed: true,
            // Each open item the investigator marked "Not available", verbatim.
            missing_info_not_available: opts.missingNotAvailable,
          }
        : { narrative_reviewed: true, missing_info_acknowledged: true },
  });
  return normalizePacket(unwrapPacket(raw));
}

/** R4.2: start follow-up n+1 of a signed packet. Returns the new packet. */
export async function startFollowUp(packetId: string): Promise<Packet> {
  const raw = await request<unknown>(`/packets/${encodeURIComponent(packetId)}/follow-up`, {
    method: "POST",
    body: {},
  });
  return normalizePacket(unwrapPacket(raw));
}

/** The packet's JSON export as a Blob (needs the bearer token, so not a plain link). */
export function getPacketExportBlob(packetId: string): Promise<Blob> {
  return requestBlob(`/packets/${encodeURIComponent(packetId)}/export.json`);
}

/** The printable HTML page as text; the page opens it in a new window. */
export function getPacketPrintHtml(packetId: string): Promise<string> {
  return requestHtml(`/packets/${encodeURIComponent(packetId)}/print`);
}

/**
 * Every clock, running or stopped, normalized for the packet header. Used only
 * when a packet does not carry its own `due_at`, so the header can still count down.
 * `active=all` is the API's "running and stopped" filter (`false` is stopped
 * only); every page is walked because the API pages at 50 by default.
 */
export async function listAllClocks(): Promise<PacketClock[]> {
  return fetchAllPages<PacketClock>(async (limit, offset) => {
    const raw = await request<unknown>("/sae-clocks", {
      query: { active: "all", limit, offset },
    });
    const items = normalizePacketClocks(raw);
    if (Array.isArray(raw) || !raw || typeof raw !== "object") {
      // A bare array is the complete list.
      return { items, total: items.length, limit: Math.max(1, items.length), offset: 0 };
    }
    const env = raw as { total?: unknown; limit?: unknown; offset?: unknown };
    return {
      items,
      total: typeof env.total === "number" ? env.total : items.length,
      limit: typeof env.limit === "number" && env.limit > 0 ? env.limit : limit,
      offset: typeof env.offset === "number" ? env.offset : offset,
    };
  });
}

// ---- R3.2 Visit-prep brief ------------------------------------------------

function briefApiPath(usubjid: string, suffix = ""): string {
  return `/participants/${encodeURIComponent(usubjid)}/brief${suffix}`;
}

/** The brief as JSON, normalized defensively (missing lists become []). */
export async function getBrief(usubjid: string, q: BriefQuery = {}): Promise<Brief> {
  const raw = await request<unknown>(briefApiPath(usubjid), {
    query: { since: q.since || undefined },
    signal: q.signal,
  });
  return normalizeBrief(raw ?? null, usubjid);
}

/**
 * The server-rendered printable page as an HTML string. Fetched with the bearer
 * token (a plain link would not carry it) and opened by the page as a blob URL.
 */
export function getBriefPrintHtml(usubjid: string, q: BriefQuery = {}): Promise<string> {
  return requestHtml(briefApiPath(usubjid, "/print"), {
    query: { since: q.since || undefined },
    signal: q.signal,
  });
}

// ---- R4.4 Sponsor queries -------------------------------------------------

/**
 * Accepts the contract's paginated object or a bare array (defensive: an early
 * API build may return a list), and always returns a `QueriesPage`.
 */
function toQueriesPage(raw: unknown, q: QueriesListQuery): QueriesPage {
  if (Array.isArray(raw)) {
    return { items: raw as QueryRow[], total: raw.length, limit: raw.length, offset: 0 };
  }
  const p = (raw ?? {}) as Partial<QueriesPage>;
  const items = Array.isArray(p.items) ? p.items : [];
  return {
    items,
    total: typeof p.total === "number" ? p.total : items.length,
    limit: typeof p.limit === "number" ? p.limit : (q.limit ?? items.length),
    offset: typeof p.offset === "number" ? p.offset : (q.offset ?? 0),
    counts: p.counts ?? null,
  };
}

export async function listQueries(
  q: QueriesListQuery = {},
  signal?: AbortSignal,
): Promise<QueriesPage> {
  const raw = await request<unknown>("/queries", { query: { ...q }, signal });
  return toQueriesPage(raw, q);
}

export function getQuery(queryId: string, signal?: AbortSignal): Promise<QueryDetail> {
  return request<QueryDetail>(`/queries/${encodeURIComponent(queryId)}`, { signal });
}

/** Admin acting as the sponsor's monitor. */
export function raiseQuery(body: RaiseQueryRequest): Promise<QueryRow> {
  return request<QueryRow>("/queries", { method: "POST", body });
}

/** Coordinator, investigator or admin. */
export function answerQuery(queryId: string, body: AnswerQueryRequest): Promise<QueryRow> {
  return request<QueryRow>(`/queries/${encodeURIComponent(queryId)}/answer`, {
    method: "POST",
    body,
  });
}

/** Admin acting as the sponsor. */
export function closeQuery(queryId: string): Promise<QueryRow> {
  return request<QueryRow>(`/queries/${encodeURIComponent(queryId)}/close`, {
    method: "POST",
    body: {},
  });
}

const QUERY_STATUSES: QueryStatus[] = ["open", "answered", "closed"];

/**
 * Tab counts. Uses `page.counts` when the list response carries them; otherwise
 * asks for one row per status and reads `total` (three tiny requests).
 */
export async function getQueryCounts(
  usubjid: string | undefined,
  known: Partial<QueryCounts> | null | undefined,
  signal?: AbortSignal,
): Promise<QueryCounts> {
  if (known && QUERY_STATUSES.every((st) => typeof known[st] === "number")) {
    return known as QueryCounts;
  }
  const totals = await Promise.all(
    QUERY_STATUSES.map((status) =>
      listQueries({ status, usubjid, limit: 1, offset: 0 }, signal).then((p) => p.total),
    ),
  );
  return { open: totals[0], answered: totals[1], closed: totals[2] };
}

/** Number of open sponsor queries. Rejects when the endpoint is missing or fails. */
export async function countOpenQueries(): Promise<number> {
  const page = await request<Paginated<unknown> | undefined>("/queries", {
    query: { status: "open", limit: 1 },
  });
  if (typeof page?.total !== "number") throw new Error("GET /queries returned no total");
  return page.total;
}

// ---- R3.2 Time saved ------------------------------------------------------

/**
 * `GET /metrics/time-saved?since=YYYY-MM-DD`. Everything the dashboard strip
 * renders is normalised here, so a partial answer (a serializer that drops a
 * field) shows fewer lines instead of throwing inside render. Rejects when
 * `minutes_saved` is missing: no number is better than a wrong one.
 */
export async function getTimeSaved(since: string, signal?: AbortSignal): Promise<TimeSavedMetrics> {
  const body = await request<Partial<TimeSavedMetrics> | null | undefined>("/metrics/time-saved", {
    query: { since },
    signal,
  });
  if (typeof body?.minutes_saved !== "number" || !Number.isFinite(body.minutes_saved)) {
    throw new Error("GET /metrics/time-saved returned no minutes_saved");
  }
  const basis: unknown = body.basis;
  return {
    ...body,
    minutes_saved: body.minutes_saved,
    minutes_manual_baseline:
      typeof body.minutes_manual_baseline === "number" ? body.minutes_manual_baseline : 0,
    basis: Array.isArray(basis)
      ? basis.filter((line): line is string => typeof line === "string")
      : [],
  };
}

// ---- Reference ------------------------------------------------------------

export function getReferenceLabel(): Promise<ReferenceLabel> {
  return request<ReferenceLabel>("/reference/label");
}

export function getReferenceCtcae(): Promise<CtcaeTerm[]> {
  return request<CtcaeTerm[]>("/reference/ctcae");
}

// ---- Admin ----------------------------------------------------------------

export function getAdminSettings(): Promise<Settings> {
  return request<Settings>("/admin/settings");
}

/** R6: the participant texts (admin only), newest first. */
export function getMessages(): Promise<MessageList> {
  return request<MessageList>("/admin/messages?limit=200");
}

export function putAdminSettings(body: SettingsUpdate): Promise<Settings> {
  return request<Settings>("/admin/settings", { method: "PUT", body });
}

export function adminReset(reseed = true): Promise<AdminResetResponse> {
  return request<AdminResetResponse>("/admin/reset", { method: "POST", body: { reseed } });
}

/** Namespace export so pages can `import { api } from "../lib/api"` if they prefer. */
export const api = {
  login,
  getHealth,
  getStudy,
  getItems,
  getPublicSettings,
  createSession,
  getSession,
  postAnswer,
  postGates,
  postVitals,
  completeSession,
  postUrgent,
  getQueue,
  getCheckIn,
  listParticipants,
  getParticipant,
  getTimeline,
  getDraft,
  getDraftVersions,
  confirmDraft,
  rejectDraft,
  patchDraft,
  patchAttribution,
  listEscalations,
  ackEscalation,
  listSaeClocks,
  listSaeClocksPage,
  stopClock,
  listPages,
  exportUrl,
  exportJson,
  exportBlob,
  exportBundle,
  bundleUrl,
  postMockEdc,
  listAudit,
  verifyAudit,
  listEvalPersonas,
  runEval,
  runCustomEval,
  getEvalResults,
  getReferenceLabel,
  getReferenceCtcae,
  getAdminSettings,
  putAdminSettings,
  adminReset,
  fetchWholeQueue,
  scanNote,
  ingestNote,
  listNotes,
  getNote,
  logPhoneCall,
  createPacket,
  openPacket,
  getPacket,
  patchPacket,
  signPacket,
  startFollowUp,
  getPacketExportBlob,
  getPacketPrintHtml,
  listAllClocks,
  getBrief,
  getBriefPrintHtml,
  listQueries,
  getQuery,
  raiseQuery,
  answerQuery,
  closeQuery,
  getQueryCounts,
  countOpenQueries,
  getTimeSaved,
};

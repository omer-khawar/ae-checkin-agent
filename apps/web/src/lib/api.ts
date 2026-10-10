/**
 * The single typed API client for Interim (CONTRACTS.md §2).
 *
 * - Base is the relative `/api/v1`: Vite proxies it in dev, nginx in Docker.
 * - Bearer token comes from `sessionStorage` (see `auth.ts`); kiosk endpoints
 *   work without one.
 * - Errors are RFC 7807 problem+json and are surfaced as `ApiError`.
 * - One function per endpoint, including dashboard/admin/eval/export calls the
 *   current wave does not render yet, so later pages only import from here.
 *
 * No retries, no caching, no magic: every function is `fetch` + JSON.
 */
import type {
  AdminResetResponse,
  Answer,
  AnswerRequest,
  AttributionRequest,
  AuditEvent,
  AuditVerifyResult,
  CheckInDetail,
  CompleteRequest,
  CompleteResponse,
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
  PageEvent,
  Paginated,
  Participant,
  Persona,
  Problem,
  PublicSettings,
  QueueItem,
  QueueQuery,
  ReferenceLabel,
  SAEClockRow,
  Session,
  Settings,
  SettingsUpdate,
  Study,
  Timeline,
  VitalsPostRequest,
  VitalsPostResponse,
} from "./types";

export const API_BASE = "/api/v1";

/** sessionStorage key holding the JSON `LoginResponse`. Owned by auth.ts. */
export const AUTH_STORAGE_KEY = "interim.auth";

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
  signal?: AbortSignal;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = `${API_BASE}${path}${buildQuery(opts.query)}`;
  const headers: Record<string, string> = {
    Accept: "application/json, application/problem+json",
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
    throw new NetworkError(url, e);
  }
  if (!res.ok) {
    throw new ApiError(url, await parseProblem(res));
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/** For `GET` endpoints that return a file (CSV/zip); returns the raw Blob. */
async function requestBlob(path: string, query?: Query): Promise<Blob> {
  const url = `${API_BASE}${path}${buildQuery(query)}`;
  const headers: Record<string, string> = {};
  const token = getStoredToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(url, { headers });
  } catch (e) {
    throw new NetworkError(url, e);
  }
  if (!res.ok) throw new ApiError(url, await parseProblem(res));
  return res.blob();
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

/** Investigator only. Setting AESER stops the SAE clock. */
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

export function exportBundle(): Promise<Blob> {
  return requestBlob("/export/bundle.zip");
}

export function postMockEdc(
  domain: Domain,
  records: Array<Record<string, unknown>>,
): Promise<MockEdcAck> {
  return request<MockEdcAck>(`/mock-edc/${domain}`, { method: "POST", body: { records } });
}

// ---- Audit ----------------------------------------------------------------

export function listAudit(
  q: { entity_type?: string; entity_id?: string; limit?: number; offset?: number } = {},
): Promise<Paginated<AuditEvent>> {
  return request<Paginated<AuditEvent>>("/audit", { query: { ...q } });
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

export function getEvalResults(): Promise<EvalResults> {
  return request<EvalResults>("/eval/results");
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
  listPages,
  exportUrl,
  exportJson,
  exportBlob,
  exportBundle,
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
};

/**
 * Typed wrappers for the sponsor-query endpoints (CONTRACTS.md R4.4):
 *
 *   GET  /queries?status=&usubjid=&limit=&offset=   paginated, with aging
 *   GET  /queries/{id}                              row + suggested_answer
 *   POST /queries                                   admin as sponsor monitor
 *   POST /queries/{id}/answer                       coordinator+
 *   POST /queries/{id}/close                        admin as sponsor
 *
 * `src/lib/api.ts` keeps `request()` private, so the minimal fetch is
 * replicated here with the same conventions as `notes/apiNotes.ts`: relative
 * `/api/v1` base, bearer token from sessionStorage, problem+json → `ApiError`,
 * network failure → `NetworkError`. Error classes, the token reader and the
 * query builder are imported, not duplicated.
 *
 * Integrator: these functions can move into `api.ts` unchanged.
 */
import {
  API_BASE,
  ApiError,
  buildQuery,
  getStoredToken,
  NetworkError,
  parseProblem,
} from "../../../lib/api";
import type {
  AnswerQueryRequest,
  QueriesListQuery,
  QueriesPage,
  QueryCounts,
  QueryDetail,
  QueryRow,
  QueryStatus,
  RaiseQueryRequest,
} from "./types";

type Query = Record<string, string | number | boolean | undefined | null>;

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  query?: Query;
  signal?: AbortSignal;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = `${API_BASE}${path}${buildQuery(opts.query)}`;
  const headers: Record<string, string> = {
    Accept: "application/json, application/problem+json",
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
  if (!res.ok) throw new ApiError(url, await parseProblem(res));
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/**
 * Accepts the contract's paginated object or a bare array (defensive: an early
 * API build may return a list), and always returns a `QueriesPage`.
 */
function toPage(raw: unknown, q: QueriesListQuery): QueriesPage {
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
  return toPage(raw, q);
}

export function getQuery(queryId: string, signal?: AbortSignal): Promise<QueryDetail> {
  return request<QueryDetail>(`/queries/${encodeURIComponent(queryId)}`, { signal });
}

export function raiseQuery(body: RaiseQueryRequest): Promise<QueryRow> {
  return request<QueryRow>("/queries", { method: "POST", body });
}

export function answerQuery(queryId: string, body: AnswerQueryRequest): Promise<QueryRow> {
  return request<QueryRow>(`/queries/${encodeURIComponent(queryId)}/answer`, {
    method: "POST",
    body,
  });
}

export function closeQuery(queryId: string): Promise<QueryRow> {
  return request<QueryRow>(`/queries/${encodeURIComponent(queryId)}/close`, {
    method: "POST",
    body: {},
  });
}

const STATUSES: QueryStatus[] = ["open", "answered", "closed"];

/**
 * Tab counts. Uses `page.counts` when the list response carries them; otherwise
 * asks for one row per status and reads `total` (three tiny requests).
 */
export async function getQueryCounts(
  usubjid: string | undefined,
  known: Partial<QueryCounts> | null | undefined,
  signal?: AbortSignal,
): Promise<QueryCounts> {
  if (known && STATUSES.every((s) => typeof known[s] === "number")) {
    return known as QueryCounts;
  }
  const totals = await Promise.all(
    STATUSES.map((status) =>
      listQueries({ status, usubjid, limit: 1, offset: 0 }, signal).then((p) => p.total),
    ),
  );
  return { open: totals[0], answered: totals[1], closed: totals[2] };
}

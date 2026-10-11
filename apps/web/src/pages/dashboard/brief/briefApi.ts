/**
 * Typed wrappers for the visit-prep brief endpoints (CONTRACTS.md R3.2):
 *
 *   GET /participants/{usubjid}/brief?since=YYYY-MM-DD        → Brief (JSON)
 *   GET /participants/{usubjid}/brief/print?since=YYYY-MM-DD  → printable HTML
 *
 * `src/lib/api.ts` keeps its `request()` helper private and is owned by another
 * agent, so the minimal fetch is replicated here with the same conventions
 * (relative `/api/v1` base, bearer token from sessionStorage, problem+json →
 * `ApiError`, network failure → `NetworkError`). Error classes, the token reader
 * and the query builder are imported, not duplicated, so callers can catch them
 * exactly as for any other endpoint.
 *
 * Integrator: `getBrief` and `getBriefPrintHtml` can move into api.ts unchanged.
 */
import {
  API_BASE,
  ApiError,
  buildQuery,
  getStoredToken,
  NetworkError,
  parseProblem,
} from "../../../lib/api";
import { normalizeBrief } from "./model";
import type { Brief } from "./types";

export interface BriefQuery {
  /** YYYY-MM-DD; omitted → the API's default (the previous visit date). */
  since?: string | null;
  signal?: AbortSignal;
}

function briefPath(usubjid: string, suffix = ""): string {
  return `/participants/${encodeURIComponent(usubjid)}/brief${suffix}`;
}

async function fetchOk(path: string, query: BriefQuery, accept: string): Promise<Response> {
  const url = `${API_BASE}${path}${buildQuery({ since: query.since || undefined })}`;
  const headers: Record<string, string> = { Accept: accept };
  const token = getStoredToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(url, { method: "GET", headers, signal: query.signal });
  } catch (e) {
    // An abort is not a network failure: let the caller see the AbortError.
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new NetworkError(url, e);
  }
  if (!res.ok) throw new ApiError(url, await parseProblem(res));
  return res;
}

/** The brief as JSON, normalized defensively (missing lists become []). */
export async function getBrief(usubjid: string, query: BriefQuery = {}): Promise<Brief> {
  const res = await fetchOk(
    briefPath(usubjid),
    query,
    "application/json, application/problem+json",
  );
  const text = await res.text();
  return normalizeBrief(text ? (JSON.parse(text) as unknown) : null, usubjid);
}

/**
 * The server-rendered printable page as an HTML string. Fetched with the bearer
 * token (a plain link would not carry it) and opened by the page as a blob URL.
 */
export async function getBriefPrintHtml(usubjid: string, query: BriefQuery = {}): Promise<string> {
  const res = await fetchOk(
    briefPath(usubjid, "/print"),
    query,
    "text/html, application/problem+json",
  );
  return res.text();
}

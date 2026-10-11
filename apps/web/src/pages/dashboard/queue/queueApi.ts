/**
 * Queue-page API wrappers for endpoints the shared client (`src/lib/api.ts`)
 * does not expose yet. They follow `api.ts` exactly: relative `/api/v1` base,
 * bearer token from sessionStorage, RFC 7807 problem+json surfaced as
 * `ApiError`, network failures as `NetworkError`. The integrator can fold them
 * into `api.ts` and delete this file.
 *
 * - `GET /queries?status=open&limit=1` (CONTRACTS R4.4): only `total` is read,
 *   for the "open sponsor queries" count.
 * - `GET /queue` every page with `status=all`: the "Since you were last here"
 *   row counts from the whole queue, not just the page on screen.
 */
import {
  API_BASE,
  ApiError,
  buildQuery,
  fetchAllPages,
  getQueue,
  getStoredToken,
  NetworkError,
  parseProblem,
} from "../../../lib/api";
import type { Paginated } from "../../../lib/types";
import { normalizeQueueItem } from "./normalize";
import type { QueueRow, RawQueueItem } from "./types";

async function getJson<T>(
  path: string,
  query: Record<string, string | number | boolean | undefined>,
): Promise<T> {
  const url = `${API_BASE}${path}${buildQuery(query)}`;
  const headers: Record<string, string> = {
    Accept: "application/json, application/problem+json",
  };
  const token = getStoredToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(url, { headers });
  } catch (e) {
    throw new NetworkError(url, e);
  }
  if (!res.ok) throw new ApiError(url, await parseProblem(res));
  return (await res.json()) as T;
}

/** Number of open sponsor queries (R4.4). Rejects when the endpoint is missing or fails. */
export async function countOpenQueries(): Promise<number> {
  const page = await getJson<Paginated<unknown>>("/queries", { status: "open", limit: 1 });
  if (typeof page?.total !== "number") throw new Error("GET /queries returned no total");
  return page.total;
}

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
  return { rows: (items as RawQueueItem[]).map(normalizeQueueItem), total };
}

/**
 * Local typed wrapper for `GET /sae-clocks?active=&limit=&offset=`.
 *
 * `src/lib/api.ts#listSaeClocks(active)` sends no `limit`/`offset`, so it only
 * ever returns the API's first page (default limit 50, `deps.py#Pagination`).
 * The Escalations page computes its tiles and filters over the complete set,
 * so it must walk every page. Ownership rules forbid editing `src/lib/api.ts`;
 * this wrapper reuses its exported building blocks (`API_BASE`, `buildQuery`,
 * `getStoredToken`, `parseProblem`, `ApiError`, `NetworkError`) so the request
 * conventions (bearer token, /api/v1 base, problem+json) stay identical.
 *
 * Integrator: fold this into `listSaeClocks(q: {active?, limit?, offset?})`
 * in src/lib/api.ts and delete this file.
 */
import {
  API_BASE,
  ApiError,
  buildQuery,
  getStoredToken,
  NetworkError,
  parseProblem,
} from "../../../lib/api";
import type { Paginated, SAEClockRow } from "../../../lib/types";

export interface SaeClocksQuery {
  /** `true` = running clocks, `false` = stopped clocks (services/dashboard.py#list_sae_clocks). */
  active: boolean;
  limit: number;
  offset: number;
}

/**
 * One page of SAE clocks. CONTRACTS.md §2.2 does not pin whether the response
 * is a bare array or a `{items,total,limit,offset}` envelope; the shipped API
 * sends the envelope. A bare array is treated as the complete list (total =
 * length) so `fetchAllPages` stops after it.
 */
export async function listSaeClocksPage(q: SaeClocksQuery): Promise<Paginated<SAEClockRow>> {
  const url = `${API_BASE}/sae-clocks${buildQuery({ active: q.active, limit: q.limit, offset: q.offset })}`;
  const headers: Record<string, string> = {
    Accept: "application/json, application/problem+json",
  };
  const token = getStoredToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(url, { method: "GET", headers });
  } catch (e) {
    throw new NetworkError(url, e);
  }
  if (!res.ok) throw new ApiError(url, await parseProblem(res));

  const text = await res.text();
  const body = text ? (JSON.parse(text) as SAEClockRow[] | Paginated<SAEClockRow> | null) : null;
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

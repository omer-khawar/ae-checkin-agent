/**
 * Audit-page-local API wrappers for two things the shared client does not yet
 * expose (the Audit page may not edit `src/lib/api.ts`):
 *
 * - `GET /audit` also accepts `?action=` and `?actor_id=` server-side
 *   (`apps/api/interim_api/routers/audit.py`), so the Action filter can search
 *   the whole log instead of the current page.
 * - `GET /export/bundle.zip` accepts `?status=confirmed|all`
 *   (`apps/api/interim_api/routers/exports.py`), so the Records selector can
 *   apply to the bundle as well as the per-domain files.
 *
 * Both follow the `api.ts` conventions exactly: relative `/api/v1` base, bearer
 * token from sessionStorage, RFC 7807 problem+json surfaced as `ApiError`,
 * network failures as `NetworkError`. The integrator can fold these into
 * `listAudit()` / `exportBundle()` in `api.ts` and delete this file.
 */
import {
  API_BASE,
  ApiError,
  buildQuery,
  getStoredToken,
  NetworkError,
  parseProblem,
} from "../../../lib/api";
import type { AuditEvent, ExportStatusFilter, Paginated } from "../../../lib/types";

export interface AuditListQuery {
  entity_type?: string;
  entity_id?: string;
  /** Exact match on the server (e.g. `draft.confirmed`). */
  action?: string;
  actor_id?: string;
  limit?: number;
  offset?: number;
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  const token = getStoredToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** `GET /audit` with every filter the server supports. Empty strings are dropped. */
export async function listAuditEvents(q: AuditListQuery = {}): Promise<Paginated<AuditEvent>> {
  const url = `${API_BASE}/audit${buildQuery({
    entity_type: q.entity_type || undefined,
    entity_id: q.entity_id || undefined,
    action: q.action || undefined,
    actor_id: q.actor_id || undefined,
    limit: q.limit,
    offset: q.offset,
  })}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: authHeaders({ Accept: "application/json, application/problem+json" }),
    });
  } catch (e) {
    throw new NetworkError(url, e);
  }
  if (!res.ok) throw new ApiError(url, await parseProblem(res));
  return (await res.json()) as Paginated<AuditEvent>;
}

/** URL the bundle download hits, for hover titles. */
export function bundleUrl(status: ExportStatusFilter): string {
  return `${API_BASE}/export/bundle.zip${buildQuery({ status })}`;
}

/** `GET /export/bundle.zip?status=` as a Blob (the endpoint needs the bearer header). */
export async function exportBundleBlob(status: ExportStatusFilter): Promise<Blob> {
  const url = bundleUrl(status);
  let res: Response;
  try {
    res = await fetch(url, { headers: authHeaders() });
  } catch (e) {
    throw new NetworkError(url, e);
  }
  if (!res.ok) throw new ApiError(url, await parseProblem(res));
  return res.blob();
}

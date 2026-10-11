/**
 * Typed wrappers for the R3/R4 endpoints the detail, note, escalation and
 * timeline pages call (CONTRACTS.md R3.2, R4.1, R4.3):
 *
 *   POST  /packets {clock_id}            open (create or return) the report packet
 *   PATCH /sae-clocks/{id}/stop          investigator's seriousness decision on a clock
 *                                        that has no AE draft to attribute
 *   PATCH /drafts/{id}/attribution       AESER / AEREL / INTERIM_IRAE (R4.3)
 *   POST  /notes  note_type=phone_call   log a call (lives in notes/apiNotes.ts#logPhoneCall)
 *
 * `src/lib/api.ts` keeps its `request()` private and is owned by another wave,
 * so the same conventions are reproduced here from its exported building
 * blocks: relative `/api/v1` base, bearer token from sessionStorage,
 * problem+json → `ApiError`, network failure → `NetworkError`.
 *
 * Integrator: move these functions into `src/lib/api.ts` unchanged.
 */
import {
  API_BASE,
  ApiError,
  buildQuery,
  getStoredToken,
  NetworkError,
  parseProblem,
} from "../../../lib/api";
import type { Draft } from "../../../lib/types";
import type { AttributionRequestR4, ClockRow, PacketRef, StopClockRequest } from "./r34Types";

type Query = Record<string, string | number | boolean | undefined | null>;

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  query?: Query;
}

/** Same behaviour as `src/lib/api.ts#request` (kept private there). */
export async function apiRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
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
    res = await fetch(url, { method: opts.method ?? "GET", headers, body });
  } catch (e) {
    throw new NetworkError(url, e);
  }
  if (!res.ok) throw new ApiError(url, await parseProblem(res));
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/** R3.2: create (or return the existing) report packet for an SAE / AESI clock. */
export function openPacket(clockId: string): Promise<PacketRef> {
  return apiRequest<PacketRef>("/packets", { method: "POST", body: { clock_id: clockId } });
}

/** R4.3: investigator-only seriousness decision on a clock with no AE draft. */
export function stopClock(clockId: string, body: StopClockRequest): Promise<ClockRow> {
  return apiRequest<ClockRow>(`/sae-clocks/${encodeURIComponent(clockId)}/stop`, {
    method: "PATCH",
    body,
  });
}

/**
 * R4.3: the attribution endpoint with the immune-related choice. Same route as
 * `src/lib/api.ts#patchAttribution`, typed for the wider body.
 */
export function patchAttributionR4(draftId: string, body: AttributionRequestR4): Promise<Draft> {
  return apiRequest<Draft>(`/drafts/${encodeURIComponent(draftId)}/attribution`, {
    method: "PATCH",
    body,
  });
}

/** Route of the packet page owned by the packets wave (R3.3). */
export function packetPath(packetId: string): string {
  return `/dashboard/packets/${encodeURIComponent(packetId)}`;
}

/** Route of the visit brief page owned by the brief wave (R3.3). */
export function briefPath(usubjid: string): string {
  return `/dashboard/participants/${encodeURIComponent(usubjid)}/brief`;
}

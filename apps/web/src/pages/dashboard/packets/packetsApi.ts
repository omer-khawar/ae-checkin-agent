/**
 * Typed wrappers for the packet endpoints (CONTRACTS.md R3.2, R4.2):
 *
 *   POST  /packets {clock_id}          create or return the packet for a clock
 *   GET   /packets/{id}                the packet
 *   PATCH /packets/{id}                edit fields / narrative (new version, audited)
 *   POST  /packets/{id}/sign           investigator only; stops the clock, posts to mock EDC
 *   POST  /packets/{id}/follow-up      start follow-up n+1 of a signed packet
 *   GET   /packets/{id}/export.json    packet JSON (download)
 *   GET   /packets/{id}/print          printable HTML
 *   GET   /sae-clocks?active=false     fallback to find the deadline when the packet omits it
 *
 * `src/lib/api.ts` keeps its `request()` helper private, so the minimal fetch is
 * replicated with the same conventions (relative `/api/v1`, bearer token from
 * sessionStorage, problem+json → `ApiError`, network failure → `NetworkError`),
 * exactly as `notes/apiNotes.ts` does. Error classes, token reader and query
 * builder are imported, not duplicated.
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
import { normalizeClocks, normalizePacket, unwrapPacket } from "./model";
import type { Packet, PacketClock, PatchPacketRequest } from "./types";

type Query = Record<string, string | number | boolean | undefined | null>;

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  query?: Query;
  accept?: string;
}

async function send(path: string, opts: RequestOptions = {}): Promise<Response> {
  const url = `${API_BASE}${path}${buildQuery(opts.query)}`;
  const headers: Record<string, string> = {
    Accept: opts.accept ?? "application/json, application/problem+json",
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
  return res;
}

async function requestJson<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await send(path, opts);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

const enc = encodeURIComponent;

/** Create (or fetch the existing) packet for a 24-hour clock. Coordinator+. */
export async function createPacket(clockId: string): Promise<Packet> {
  const raw = await requestJson<unknown>("/packets", {
    method: "POST",
    body: { clock_id: clockId },
  });
  return normalizePacket(unwrapPacket(raw));
}

export async function getPacket(packetId: string): Promise<Packet> {
  const raw = await requestJson<unknown>(`/packets/${enc(packetId)}`);
  return normalizePacket(unwrapPacket(raw));
}

/** Edit fields and/or the narrative. The API stores a new version and audits `packet.edited`. */
export async function patchPacket(packetId: string, body: PatchPacketRequest): Promise<Packet> {
  const raw = await requestJson<unknown>(`/packets/${enc(packetId)}`, { method: "PATCH", body });
  return normalizePacket(unwrapPacket(raw));
}

/**
 * Investigator only. Marks the packet signed, stops the clock as
 * "reported (mock)", audits `packet.signed` / `packet.followup_signed` and
 * posts the packet to the mock EDC. Nothing is sent anywhere real.
 */
export async function signPacket(packetId: string): Promise<Packet> {
  const raw = await requestJson<unknown>(`/packets/${enc(packetId)}/sign`, {
    method: "POST",
    body: {},
  });
  return normalizePacket(unwrapPacket(raw));
}

/** R4.2: start follow-up n+1 of a signed packet. Returns the new packet. */
export async function startFollowUp(packetId: string): Promise<Packet> {
  const raw = await requestJson<unknown>(`/packets/${enc(packetId)}/follow-up`, {
    method: "POST",
    body: {},
  });
  return normalizePacket(unwrapPacket(raw));
}

/** The packet's JSON export as a Blob (needs the bearer token, so not a plain link). */
export async function getPacketExportBlob(packetId: string): Promise<Blob> {
  const res = await send(`/packets/${enc(packetId)}/export.json`);
  return res.blob();
}

/** The printable HTML page as text; the page opens it in a new window. */
export async function getPacketPrintHtml(packetId: string): Promise<string> {
  const res = await send(`/packets/${enc(packetId)}/print`, { accept: "text/html" });
  return res.text();
}

/**
 * Every clock, running or stopped. Used only when a packet does not carry its
 * own `due_at`, so the header can still count down.
 */
export async function listAllClocks(): Promise<PacketClock[]> {
  const raw = await requestJson<unknown>("/sae-clocks", { query: { active: false } });
  return normalizeClocks(raw);
}

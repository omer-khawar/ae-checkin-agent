/**
 * Typed wrappers for the chart-note endpoints (CONTRACTS.md R2.4):
 *
 *   POST /scan           dry run, nothing stored
 *   POST /notes          ingest + scan + drafts
 *   GET  /notes          paginated list
 *   GET  /notes/{id}     note + scan + drafts
 *   POST /notes          note_type "phone_call" + caller + call_direction (R4.1)
 *
 * `src/lib/api.ts` does not export its private `request()` helper and is owned
 * by another wave, so the minimal fetch is replicated here with the same
 * conventions: relative `/api/v1` base, bearer token from sessionStorage,
 * problem+json → `ApiError`, network failure → `NetworkError`. The error
 * classes, token reader and query builder are imported, not duplicated, so a
 * caller can `catch` them exactly as for any other endpoint.
 *
 * Integrator: these four functions can move into `api.ts` unchanged.
 */
import {
  API_BASE,
  ApiError,
  buildQuery,
  getStoredToken,
  NetworkError,
  parseProblem,
} from "../../../lib/api";
import { PHONE_CALL_NOTE_TYPE, type CallDirection, type CallerKind } from "../detail/r34Types";
import { normalizeNoteDetail, normalizeNotesPage, normalizeScan } from "./normalize";
import type {
  NoteDetailResponse,
  NoteIngestRequest,
  NoteIngestResponse,
  NotesPage,
  NotesQuery,
  ScanRequest,
  ScanResult,
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

/** R4.1 "Log a call": the coordinator's call summary, scanned exactly like a chart note. */
export interface PhoneCallRequest {
  usubjid: string;
  /** YYYY-MM-DD the call took place. */
  note_date: string;
  /** Who logged it (the signed-in user's display name). */
  author: string;
  caller: CallerKind;
  call_direction: CallDirection;
  /** The call summary, stored verbatim. */
  text: string;
}

export function logPhoneCall(body: PhoneCallRequest): Promise<NoteIngestResponse> {
  return ingestNote({ ...body, note_type: PHONE_CALL_NOTE_TYPE });
}

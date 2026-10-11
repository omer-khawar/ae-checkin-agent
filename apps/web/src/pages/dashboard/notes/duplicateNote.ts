/** Reads a 409 "Duplicate note" problem from POST /notes or POST /calls. */
import { isApiError } from "../../../lib/api";

export interface DuplicateNote {
  url: string;
  ingestedAt: string | null;
}

/** The existing note named by a 409 duplicate problem, or null. */
export function duplicateNoteOf(error: unknown): DuplicateNote | null {
  if (!isApiError(error) || error.status !== 409) return null;
  const p = error.problem;
  const id = typeof p.existing_note_id === "string" ? p.existing_note_id : null;
  const rawUrl = typeof p.existing_note_url === "string" ? p.existing_note_url : null;
  const url = rawUrl ?? (id ? `/dashboard/notes/${id}` : null);
  if (!url) return null;
  // The API's detail sentence carries the ingest time ("already ingested at <iso> as note ...").
  const m = /ingested at (.+?) as note /.exec(p.detail ?? "");
  return { url, ingestedAt: m ? m[1] : null };
}

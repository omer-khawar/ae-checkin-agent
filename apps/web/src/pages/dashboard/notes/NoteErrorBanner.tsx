/**
 * Error banner for note and phone-call intake. A 409 "Duplicate note" from
 * POST /notes or POST /calls (same participant, date and verbatim text) carries
 * `existing_note_id` / `existing_note_url`; instead of showing the raw ULID and
 * ISO timestamp, say it in plain words and link to the note already on file.
 * Every other error falls through to the shared ErrorBanner.
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import { ErrorBanner } from "../../../components/ErrorBanner";
import { Time } from "../../../lib/format";
import { duplicateNoteOf } from "./duplicateNote";

export function NoteErrorBanner({ error, message }: { error: unknown; message: ReactNode }) {
  const dup = duplicateNoteOf(error);
  if (!dup) return <ErrorBanner error={error} message={message} />;
  return (
    <div
      role="alert"
      data-testid="duplicate-note"
      className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900"
    >
      <div className="font-semibold">This was already recorded</div>
      <div className="mt-0.5 text-sm">
        The same participant, date and wording is already on file
        {dup.ingestedAt && (
          <>
            {" "}
            (recorded <Time iso={dup.ingestedAt} />)
          </>
        )}
        , so nothing new was created.{" "}
        <Link to={dup.url} className="font-medium underline hover:text-amber-700">
          Open the existing record
        </Link>
      </div>
    </div>
  );
}

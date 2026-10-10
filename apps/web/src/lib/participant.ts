/**
 * Study-ID handling for the kiosk Welcome screen.
 *
 * CONTRACTS.md §5 defines `USUBJID = "{study_id}-P-xxx"` with `P-xxx` as the
 * participant's printed `display_label`, while `POST /sessions` takes `usubjid`.
 * The participant types what is on their card ("P-007"), so the kiosk composes
 * the full USUBJID from the loaded study and, if the API answers 404, retries
 * with the typed label (covers an API that resolves labels itself). Either API
 * behaviour therefore works; the choice is recorded in apps/web/README.md.
 */

export interface UsubjidCandidates {
  /** What to send first. */
  primary: string;
  /** What to retry with on 404, or null when there is only one sensible form. */
  fallback: string | null;
}

/** Trim and upper-case the typed ID the way the Welcome screen does. */
export function normalizeTypedId(typed: string): string {
  return typed.trim().toUpperCase();
}

/**
 * Candidate `usubjid` values for a typed ID.
 *
 * - No study loaded → send the typed value as-is.
 * - Typed value already starts with `<study_id>-` (or equals it) → as-is.
 * - Otherwise → `<study_id>-<typed>` first, typed value as the 404 fallback.
 */
export function resolveUsubjid(
  typed: string,
  studyId: string | null | undefined,
): UsubjidCandidates {
  const id = normalizeTypedId(typed);
  const study = (studyId ?? "").trim();
  if (!study) return { primary: id, fallback: null };
  const prefix = `${study.toUpperCase()}-`;
  if (id === study.toUpperCase() || id.startsWith(prefix)) {
    return { primary: id, fallback: null };
  }
  return { primary: `${study}-${id}`, fallback: id };
}

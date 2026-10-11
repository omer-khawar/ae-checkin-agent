/**
 * Escalations-page UI types. The API row shapes (`EscalationRow`, `ClockRow`,
 * `PageEventRow`) live in src/lib/types.ts.
 */

/** Which escalations the table shows. */
export type AckFilter = "open" | "acked" | "all";

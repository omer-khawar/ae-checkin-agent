/**
 * Book-keeping for the kiosk's per-tap answer POSTs (CONTRACTS.md §2.1:
 * `POST /sessions/{id}/answers` is idempotent on session + item + attribute).
 *
 * The kiosk keeps three sets keyed by `item:attribute`:
 *   - pending  — a POST is in flight,
 *   - failed   — the last POST for that key failed (retry resends *every* entry),
 *   - acked    — the API acknowledged the latest value.
 * Before `/complete` the flow diffs the locally answered set against `acked`
 * and resends any gap, so a check-in can never complete with an answer the
 * participant saw as selected but the server never received (the provisional
 * grade comes only from the participant's answers, CLAUDE.md §3.4(b)).
 *
 * Pure helpers only; no React, no I/O.
 */
import type { Attribute } from "./types";

export type AnswerMap = Record<string, Partial<Record<Attribute, number>>>;

export interface LocalAnswer {
  item_id: string;
  attribute: Attribute;
  value: number;
}

/** Stable key for one (item, attribute) pair. */
export function answerKey(itemId: string, attribute: Attribute): string {
  return `${itemId}:${attribute}`;
}

/** Flatten the local answer map into a list (stable order: item, then attribute). */
export function flattenAnswers(answers: AnswerMap): LocalAnswer[] {
  const out: LocalAnswer[] = [];
  for (const [item_id, attrs] of Object.entries(answers)) {
    for (const [attribute, value] of Object.entries(attrs) as Array<
      [Attribute, number | undefined]
    >) {
      if (value !== undefined && Number.isFinite(value)) out.push({ item_id, attribute, value });
    }
  }
  return out;
}

/**
 * Answers the participant selected that the API has not acknowledged (and that
 * are not currently in flight). These are the ones to resend before `/complete`.
 */
export function missingAnswers(
  answers: AnswerMap,
  acked: ReadonlySet<string>,
  pending: ReadonlySet<string> = new Set(),
): LocalAnswer[] {
  return flattenAnswers(answers).filter((a) => {
    const key = answerKey(a.item_id, a.attribute);
    return !acked.has(key) && !pending.has(key);
  });
}

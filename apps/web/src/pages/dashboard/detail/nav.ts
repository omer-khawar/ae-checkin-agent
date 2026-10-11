/**
 * Draft-to-draft and item-to-item navigation for the detail page (pure, tested).
 *
 * The single-key shortcuts (c confirm, e edit, r reject, ] next draft) act on the "active"
 * draft. After a confirm the page moves to the next draft that still needs a person, and when
 * none is left it offers the next queue item (j).
 */
import type { Draft } from "../../../lib/types";
import { DOMAIN_ORDER, groupDrafts } from "./model";

/** Drafts that still need a person, in on-screen order (AE, VS, CM; then version order). */
export function actionableDrafts(drafts: Draft[]): Draft[] {
  const groups = groupDrafts(drafts);
  return DOMAIN_ORDER.flatMap((d) => groups[d]).filter((d) => d.status === "draft");
}

/**
 * The draft after `currentId` (wrapping) among `order`, skipping `currentId` itself.
 * `step = -1` goes backwards. Null when nothing else is left.
 */
export function neighbourDraftId(
  order: Draft[],
  currentId: string | null,
  step: 1 | -1 = 1,
): string | null {
  const others = order.filter((d) => d.id !== currentId);
  if (others.length === 0) return null;
  const at = order.findIndex((d) => d.id === currentId);
  if (at < 0) return order[0]?.id ?? null;
  for (let i = 1; i <= order.length; i++) {
    const cand = order[(at + step * i + order.length * i) % order.length];
    if (cand && cand.id !== currentId) return cand.id;
  }
  return null;
}

/** The queue row after the current session that still needs a person (wrapping), or null. */
export function nextQueueSession(
  rows: ReadonlyArray<{ session_id: string | null; note_id: string | null; needs_action: boolean }>,
  currentSessionId: string,
): { kind: "session" | "note"; id: string } | null {
  const at = rows.findIndex((r) => r.session_id === currentSessionId);
  const ordered = at < 0 ? rows : [...rows.slice(at + 1), ...rows.slice(0, at)];
  for (const r of ordered) {
    if (!r.needs_action) continue;
    if (r.session_id && r.session_id !== currentSessionId) {
      return { kind: "session", id: r.session_id };
    }
    if (r.note_id && !r.session_id) return { kind: "note", id: r.note_id };
  }
  return null;
}

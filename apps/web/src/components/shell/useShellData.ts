/**
 * Live data for the console shell: the header count badges, the "open the next urgent item"
 * target, the participant list for the palette, and the global toast for new Tier 2/3 items.
 *
 * Every request is best-effort: a failing endpoint just leaves its count at null (badge
 * hidden). Polling every 30 s. The first successful queue read only seeds the "seen" set, so
 * opening the dashboard does not toast everything that is already there; only items that
 * appear afterwards do (on any dashboard page).
 */
import { useEffect, useRef, useState } from "react";

import {
  countOpenQueries,
  getQueue,
  listEscalations,
  listNotes,
  listParticipants,
} from "../../lib/api";
import type { Participant, QueueItem } from "../../lib/types";

export interface UrgentTarget {
  key: string;
  path: string;
  usubjid: string;
  tier: number;
}

export interface ShellData {
  /** Open worklist items that need action (tier >= 1, status open). */
  worklist: number | null;
  /** Escalations (tier >= 2) not yet acknowledged. */
  escalations: number | null;
  /** True when at least one unacknowledged escalation is Tier 3. */
  urgent: boolean;
  queries: number | null;
  notes: number | null;
  participants: Participant[];
  /** Highest-tier, oldest-first unacknowledged item, if any. */
  nextUrgent: UrgentTarget | null;
}

const POLL_MS = 30_000;

export function itemKey(i: QueueItem): string {
  return String(i.session_id ?? i.note_id ?? `${i.usubjid}@${i.completed_at}`);
}

export function itemPath(i: QueueItem): string {
  if (i.session_id) return `/dashboard/checkins/${encodeURIComponent(String(i.session_id))}`;
  if (i.note_id) return `/dashboard/notes/${encodeURIComponent(String(i.note_id))}`;
  return "/dashboard";
}

/** Pick the most urgent unacknowledged item: highest tier first, then the oldest. */
export function pickNextUrgent(items: QueueItem[]): UrgentTarget | null {
  const pool = items.filter((i) => i.tier >= 2 && i.escalation_acked !== true);
  if (pool.length === 0) return null;
  pool.sort((a, b) => b.tier - a.tier || Date.parse(a.completed_at) - Date.parse(b.completed_at));
  const top = pool[0];
  return { key: itemKey(top), path: itemPath(top), usubjid: top.usubjid, tier: top.tier };
}

export function useShellData(onNewUrgent: (items: QueueItem[]) => void, enabled = true): ShellData {
  const [data, setData] = useState<ShellData>({
    worklist: null,
    escalations: null,
    urgent: false,
    queries: null,
    notes: null,
    participants: [],
    nextUrgent: null,
  });
  const seen = useRef<Set<string> | null>(null);
  const cb = useRef(onNewUrgent);
  cb.current = onNewUrgent;

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const patch = (p: Partial<ShellData>) => {
      if (!cancelled) setData((d) => ({ ...d, ...p }));
    };

    const load = () => {
      getQueue({ status: "open", limit: 100 }).then(
        (page) => {
          if (cancelled) return;
          const items = page.items ?? [];
          const urgent = items.filter((i) => i.tier >= 2 && i.escalation_acked !== true);
          const fresh = seen.current ? urgent.filter((i) => !seen.current!.has(itemKey(i))) : [];
          seen.current = new Set([...(seen.current ?? []), ...urgent.map(itemKey)]);
          if (fresh.length > 0) cb.current(fresh);
          patch({
            worklist: typeof page.total === "number" ? page.total : items.length,
            nextUrgent: pickNextUrgent(items),
          });
        },
        () => undefined,
      );
      listEscalations({ acked: false, limit: 50 }).then(
        (page) =>
          patch({
            escalations: typeof page.total === "number" ? page.total : page.items.length,
            urgent: page.items.some((e) => e.tier >= 3),
          }),
        () => undefined,
      );
      countOpenQueries().then(
        (n) => patch({ queries: n }),
        () => undefined,
      );
      listNotes({ limit: 1 }).then(
        (page) => patch({ notes: typeof page.total === "number" ? page.total : null }),
        () => undefined,
      );
    };

    load();
    listParticipants({ limit: 100 }).then(
      (page) => patch({ participants: page.items ?? [] }),
      () => undefined,
    );
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled]);

  return data;
}

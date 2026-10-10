/**
 * Fields the live API's `EvalResults` carries beyond the §2.2 contract
 * (CONTRACTS.md R2.2; `apps/api/interim_api/services/evaluation.py` run_eval):
 *
 *   counterfactuals[]: each persona that declares `counterfactuals` is replayed
 *     again with its settings toggled; the harness records baseline tier vs
 *     new tier and checks the invariant "settings never change a provisional
 *     grade" — the strongest "change the input, watch the output change"
 *     evidence on the page.
 *   notices[]: expected keys the harness does not compare (informational).
 *
 * `src/lib/types.ts` is shared and not owned by this page, so the optional
 * fields are typed here. Integrator: fold `EvalResultsExtras` into
 * `EvalResults` in types.ts and delete this file's type when convenient.
 */
import type { EvalResults, IsoUtc, Ulid } from "../../../lib/types";

export interface EvalCounterfactual {
  persona_id: string;
  label: string;
  settings?: Record<string, unknown> | null;
  baseline_tier: number;
  tier: number;
  pass: boolean;
  mismatches: string[];
  session_id: Ulid | null;
}

export interface EvalResultsExtras {
  counterfactuals?: EvalCounterfactual[];
  notices?: string[];
  ran_by?: string;
  persona_ids?: string[] | null;
  interim_version?: string;
  /** Unused here; kept so an older `ran_at` alias does not type-error. */
  ran_at?: IsoUtc;
}

/** Defensive read: tolerates a server that omits the fields or sends wrong shapes. */
export function readExtras(results: EvalResults): {
  counterfactuals: EvalCounterfactual[];
  notices: string[];
} {
  const r = results as EvalResults & EvalResultsExtras;
  const counterfactuals = Array.isArray(r.counterfactuals)
    ? r.counterfactuals.filter((c): c is EvalCounterfactual => !!c && typeof c === "object")
    : [];
  const notices = Array.isArray(r.notices)
    ? r.notices.filter((n): n is string => typeof n === "string")
    : [];
  return { counterfactuals, notices };
}

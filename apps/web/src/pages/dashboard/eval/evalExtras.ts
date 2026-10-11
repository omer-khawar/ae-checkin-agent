/**
 * Defensive read of the fields the live API's `EvalResults` carries beyond the
 * §2.2 contract (CONTRACTS.md R2.2; typed as optional on `EvalResults` in
 * src/lib/types.ts):
 *
 *   counterfactuals[]: each persona that declares `counterfactuals` is replayed
 *     again with its settings toggled; the harness records baseline tier vs
 *     new tier and checks the invariant "settings never change a provisional
 *     grade" — the strongest "change the input, watch the output change"
 *     evidence on the page.
 *   notices[]: expected keys the harness does not compare (informational).
 */
import type { EvalCounterfactual, EvalResults } from "../../../lib/types";

/** Defensive read: tolerates a server that omits the fields or sends wrong shapes. */
export function readExtras(results: EvalResults): {
  counterfactuals: EvalCounterfactual[];
  notices: string[];
} {
  const r = results;
  const counterfactuals = Array.isArray(r.counterfactuals)
    ? r.counterfactuals.filter((c): c is EvalCounterfactual => !!c && typeof c === "object")
    : [];
  const notices = Array.isArray(r.notices)
    ? r.notices.filter((n): n is string => typeof n === "string")
    : [];
  return { counterfactuals, notices };
}

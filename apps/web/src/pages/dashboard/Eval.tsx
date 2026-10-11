/**
 * /dashboard/eval (CLAUDE.md §3.7.6, §8, §11 step 6).
 *
 * Three sections:
 *   1. Run the shipped personas (24) or the hidden judge personas (5) via
 *      `POST /eval/run`, then show `EvalResults`; the last stored run is loaded
 *      from `GET /eval/results` on mount.
 *   2. The persona catalogue (`GET /eval/personas`) with expected tiers.
 *   3. "Build your own persona" → `POST /eval/run-custom`.
 *
 * All numbers come from the API; this page never grades anything itself.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { ErrorBanner } from "../../components/ErrorBanner";
import { TierChip } from "../../components/TierChip";
import { getEvalResults, getItems, isApiError, listEvalPersonas, runEval } from "../../lib/api";
import type { EvalPersonaSummary, EvalResults, GateQuestion, Item } from "../../lib/types";
import { EvalResultsView } from "./eval/EvalResultsView";
import { PersonaBuilder } from "./eval/PersonaBuilder";

type RunKind = "shipped" | "hidden" | "one";

interface RunSpec {
  kind: RunKind;
  persona?: EvalPersonaSummary;
}

function PersonaCatalogue({
  personas,
  onRunOne,
  busyId,
  disabled,
}: {
  personas: EvalPersonaSummary[];
  onRunOne: (p: EvalPersonaSummary) => void;
  busyId: string | null;
  disabled: boolean;
}) {
  const [showHidden, setShowHidden] = useState(true);
  const visible = showHidden ? personas : personas.filter((p) => !p.hidden);
  return (
    <Card
      title={`Personas (${personas.length})`}
      aside={
        <label className="flex items-center gap-2 text-xs text-slate-700">
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(e) => setShowHidden(e.target.checked)}
            className="h-4 w-4"
          />
          show hidden judge personas
        </label>
      }
      flush
    >
      {visible.length === 0 ? (
        <p className="p-4 text-sm text-slate-600">No personas returned by the API.</p>
      ) : (
        <div className="overflow-x-auto p-4">
          <table className="w-full text-sm" data-testid="persona-list">
            <caption className="sr-only">Persona catalogue with expected tiers</caption>
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-600">
                <th scope="col" className="py-2 pr-3">
                  Persona
                </th>
                <th scope="col" className="py-2 pr-3">
                  Category
                </th>
                <th scope="col" className="py-2 pr-3">
                  Expected tier
                </th>
                <th scope="col" className="py-2 pr-3">
                  Description
                </th>
                <th scope="col" className="py-2">
                  <span className="sr-only">Run</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => (
                <tr key={p.id} className="border-b border-slate-100 align-top">
                  <td className="py-2 pr-3">
                    <div className="font-medium text-slate-900">{p.name}</div>
                    <div className="font-mono text-xs text-slate-600">
                      {p.id}
                      {p.hidden && (
                        <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 font-sans text-[11px] font-semibold text-slate-700">
                          hidden
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-2 pr-3 text-slate-700">{p.category}</td>
                  <td className="py-2 pr-3">
                    <TierChip tier={p.expected_tier} short />
                  </td>
                  <td className="py-2 pr-3 text-slate-700">{p.description}</td>
                  <td className="py-2 text-right">
                    <Button
                      size="sm"
                      variant="secondary"
                      busy={busyId === p.id}
                      disabled={disabled}
                      onClick={() => onRunOne(p)}
                      aria-label={`Run persona ${p.name}`}
                    >
                      Run
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function Eval() {
  const [personas, setPersonas] = useState<EvalPersonaSummary[] | null>(null);
  const [personasError, setPersonasError] = useState<unknown>(null);
  const [items, setItems] = useState<Item[] | null>(null);
  const [gates, setGates] = useState<GateQuestion[]>([]);
  const [itemsError, setItemsError] = useState<unknown>(null);
  const [results, setResults] = useState<EvalResults | null>(null);
  const [resultsSource, setResultsSource] = useState<"stored" | "fresh" | null>(null);
  // The stored-run fetch has its own loading and error state: a failed GET on
  // mount is not a failed run, and the empty state must not flash before the
  // GET has settled.
  const [resultsLoading, setResultsLoading] = useState(true);
  const [resultsLoadError, setResultsLoadError] = useState<unknown>(null);
  const [running, setRunning] = useState<RunKind | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [runError, setRunError] = useState<unknown>(null);
  const [loadTick, setLoadTick] = useState(0);
  /** The last run requested, so "Try again" on a failed run repeats it. */
  const lastRun = useRef<RunSpec | null>(null);

  const reload = useCallback(() => setLoadTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    setPersonasError(null);
    setItemsError(null);
    setResultsLoadError(null);
    setResultsLoading(true);
    listEvalPersonas()
      .then((p) => {
        if (!cancelled) setPersonas(p);
      })
      .catch((e: unknown) => {
        if (!cancelled) setPersonasError(e);
      });
    getItems()
      .then((r) => {
        if (!cancelled) {
          setItems(r.items ?? []);
          // Gate wording comes from the rules table (gate_questions.json), never from code.
          setGates(Array.isArray(r.gates) ? r.gates : []);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setItemsError(e);
      });
    getEvalResults()
      .then((r) => {
        // null = no run yet (204); same empty state as a 404.
        if (!cancelled && r) {
          setResults(r);
          setResultsSource("stored");
        }
      })
      .catch((e: unknown) => {
        // 404 = no run yet; that is a normal empty state, not an error.
        if (!cancelled && !(isApiError(e) && e.isNotFound)) setResultsLoadError(e);
      })
      .finally(() => {
        if (!cancelled) setResultsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadTick]);

  const counts = useMemo(() => {
    const all = personas ?? [];
    const hidden = all.filter((p) => p.hidden).length;
    return { shipped: all.length - hidden, hidden };
  }, [personas]);

  async function run(spec: RunSpec) {
    const { kind, persona } = spec;
    const hiddenIds = (personas ?? []).filter((p) => p.hidden).map((p) => p.id);
    // The API treats an empty `persona_ids` as "no filter" and would replay the
    // whole set, so a hidden/single run with nothing to send is a no-op.
    if (kind === "hidden" && hiddenIds.length === 0) return;
    if (kind === "one" && !persona) return;
    lastRun.current = spec;
    setRunning(kind);
    setRunningId(persona?.id ?? null);
    setRunError(null);
    try {
      const body =
        kind === "shipped"
          ? { include_hidden: false }
          : kind === "hidden"
            ? { include_hidden: true, persona_ids: hiddenIds }
            : { include_hidden: Boolean(persona?.hidden), persona_ids: [persona!.id] };
      const res = await runEval(body);
      setResults(res);
      setResultsSource("fresh");
    } catch (e) {
      setRunError(e);
    } finally {
      setRunning(null);
      setRunningId(null);
    }
  }

  // One short line for assistive tech (aria-live); the results block itself is
  // ordinary content so a run does not read out hundreds of table cells.
  let statusLine: string | null = null;
  if (resultsLoading) statusLine = "Loading last run…";
  else if (running !== null) statusLine = "Running the eval…";
  else if (results && resultsSource === "fresh")
    statusLine = `Run complete: ${results.n_pass ?? 0} of ${results.n_personas ?? 0} passed.`;
  else if (results && resultsSource === "stored") statusLine = "Showing the last stored run.";

  const showEmpty = !results && !resultsLoading && !resultsLoadError && !runError;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Eval</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-600">
          Replays scripted personas through the real API and compares the engine's output with a
          hand-written answer key (CLAUDE.md §8). The personas are deterministic, so the shipped set
          must pass 100%. Change an input below and the output changes; nothing here is generated by
          a language model.
        </p>
      </div>

      <Card title="Run the test set">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => void run({ kind: "shipped" })}
            busy={running === "shipped"}
            disabled={running !== null}
          >
            Run the shipped personas{personas ? ` (${counts.shipped})` : ""}
          </Button>
          <Button
            variant="secondary"
            onClick={() => void run({ kind: "hidden" })}
            busy={running === "hidden"}
            // Disabled until the catalogue is here: without the hidden ids the
            // request would carry an empty list, which the API reads as "all".
            disabled={running !== null || personas === null || counts.hidden === 0}
          >
            Run hidden judge personas{personas ? ` (${counts.hidden})` : ""}
          </Button>
        </div>
        <p className="mt-3 min-h-5 text-sm text-slate-600" role="status" aria-live="polite">
          {statusLine}
        </p>
        <ErrorBanner
          error={resultsLoadError}
          message="Could not load the last stored run"
          onRetry={reload}
          className="mt-3"
        />
        <ErrorBanner
          error={runError}
          message="The eval run failed"
          onRetry={() => {
            if (lastRun.current) void run(lastRun.current);
          }}
          className="mt-3"
        />
        {results && (
          <div className="mt-4">
            <EvalResultsView results={results} personas={personas ?? []} />
          </div>
        )}
        {showEmpty && (
          <p className="mt-3 text-sm text-slate-600">
            No run yet. Click a button above; results appear here with per-tier precision/recall,
            the grade confusion matrix and a link to every replayed session.
          </p>
        )}
      </Card>

      {personasError ? (
        <ErrorBanner
          error={personasError}
          message="Could not load the persona catalogue"
          onRetry={reload}
        />
      ) : personas === null ? (
        <Card title="Personas">
          <p className="text-sm text-slate-600" role="status">
            Loading personas…
          </p>
        </Card>
      ) : (
        <PersonaCatalogue
          personas={personas}
          onRunOne={(p) => void run({ kind: "one", persona: p })}
          busyId={running === "one" ? runningId : null}
          disabled={running !== null}
        />
      )}

      <section aria-labelledby="build-your-own">
        <h2 id="build-your-own" className="mb-3 text-lg font-semibold text-slate-900">
          Build your own persona
        </h2>
        {itemsError ? (
          <ErrorBanner
            error={itemsError}
            message="Could not load the item table"
            onRetry={reload}
          />
        ) : items === null ? (
          <Card>
            <p className="text-sm text-slate-600" role="status">
              Loading items…
            </p>
          </Card>
        ) : (
          <PersonaBuilder items={items} gates={gates} />
        )}
      </section>
    </div>
  );
}

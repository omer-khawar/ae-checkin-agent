/**
 * "Build your own persona" (CLAUDE.md §8, §11 step 6): the judge edits the
 * inputs and watches the outputs change. Pre-filled with the demo persona so a
 * single click runs; changing shortness-of-breath severity to "Severe" moves
 * the tier.
 *
 * Attribute labels come from `GET /items` (the rules table), never from code.
 * Vitals samples are generated client-side from a preset (always simulated,
 * always labeled). The "treat simulated as measured" toggle is the admin demo
 * switch applied to this run only, and it carries its warning.
 */
import { useId, useMemo, useState } from "react";

import { Button } from "@/pages/admin/SysUI";
import { Panel as Card } from "@/pages/admin/SysUI";
import { ErrorBanner } from "../../../components/ErrorBanner";
import { MeasuredBadge } from "../../../components/MeasuredBadge";
import { runCustomEval } from "../../../lib/api";
import { cx, formatConfidence, optionsFor, temperatureField } from "../../../lib/format";
import { gateLabel, gatePrompts } from "../../../lib/gates";
import type {
  Attribute,
  ConmedDirection,
  EvalCustomResponse,
  GateQuestion,
  Item,
} from "../../../lib/types";
import { CustomResultView } from "./CustomResultView";
import {
  buildPersona,
  demoFormState,
  DEMO_PERSONA_ID,
  orderedItems,
  responseValue,
  withPreset,
  withResponse,
  type PersonaFormState,
} from "./personaForm";
import {
  generateSamples,
  parseLevel,
  VITALS_PRESET_ORDER,
  VITALS_PRESETS,
  type VitalsPreset,
} from "./vitalsPresets";

export interface PersonaBuilderProps {
  items: Item[];
  /**
   * Gate questions from `GET /items` (gate_questions.json). Their `label`,
   * `text_prompt`, `direction_prompt` and `note` are the wording shown here,
   * exactly as on the kiosk; the CLAUDE.md §3.2 text is the fallback only.
   */
  gates?: GateQuestion[];
}

const ATTRIBUTE_TITLES: Record<Attribute, string> = {
  frequency: "Frequency",
  severity: "Severity",
  interference: "Interference",
  presence: "Present",
};

const DIRECTIONS: ConmedDirection[] = ["started", "stopped", "both"];

const SELECT_CLASS =
  "w-full rounded-control border border-input bg-surface px-2 py-1.5 text-table text-foreground focus-visible:ring-4";
const INPUT_CLASS = SELECT_CLASS;

function ItemRow({
  item,
  state,
  onChange,
}: {
  item: Item;
  state: PersonaFormState;
  onChange: (attr: Attribute, value: number) => void;
}) {
  const attrs = item.attributes.length ? item.attributes : (["severity"] as Attribute[]);
  const name = item.short_label || item.label;
  return (
    <div className="grid gap-2 border-b border-border py-2 sm:grid-cols-[minmax(10rem,1fr)_2fr]">
      <div className="text-table font-medium text-foreground">
        {name}
        <div className="text-caption font-normal text-muted-foreground">{item.ctcae_term}</div>
      </div>
      <div className={cx("grid gap-2", attrs.length > 1 ? "sm:grid-cols-2" : "sm:grid-cols-1")}>
        {attrs.map((attr) => {
          const id = `pb-${item.id}-${attr}`;
          return (
            <div key={attr}>
              <label htmlFor={id} className="block text-caption text-muted-foreground">
                <span className="sr-only">{name} </span>
                {ATTRIBUTE_TITLES[attr]}
              </label>
              <select
                id={id}
                className={SELECT_CLASS}
                value={responseValue(state, item.id, attr)}
                onChange={(e) => onChange(attr, Number(e.target.value))}
              >
                {optionsFor(item, attr).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function PersonaBuilder({ items, gates = [] }: PersonaBuilderProps) {
  const [state, setState] = useState<PersonaFormState>(() => demoFormState());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [outcome, setOutcome] = useState<EvalCustomResponse | null>(null);
  const uid = useId();

  const ordered = useMemo(() => orderedItems(items), [items]);
  const prompts = useMemo(() => gatePrompts(gates), [gates]);
  const feverItem = ordered.find((it) => it.id === "fever_or_chills");
  const tempField = feverItem ? temperatureField(feverItem) : null;
  const preset = VITALS_PRESETS[state.preset];
  const samples = useMemo(
    () => generateSamples(state.preset, state.levels),
    [state.preset, state.levels],
  );

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const persona = buildPersona(state, ordered);
      const res = await runCustomEval(persona);
      setOutcome(res);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const levelInput = (
    key: keyof PersonaFormState["levels"],
    label: string,
    step: number,
    unit: string,
  ) => {
    const id = `${uid}-${key}`;
    return (
      <div>
        <label htmlFor={id} className="block text-caption text-muted-foreground">
          {label} <span className="text-muted-foreground">({unit})</span>
        </label>
        <input
          id={id}
          type="number"
          step={step}
          className={INPUT_CLASS}
          value={state.levels[key]}
          onChange={(e) =>
            setState((s) => ({
              ...s,
              levels: { ...s.levels, [key]: parseLevel(e.target.value, preset.defaults[key]) },
            }))
          }
        />
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <form
        className="grid gap-4 lg:grid-cols-[3fr_2fr]"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
        aria-label="Build your own persona"
      >
        <Card
          title="Answers (labels from the PRO-CTCAE-style item table)"
          aside={
            <span className="text-caption text-muted-foreground">
              pre-filled with <span className="font-mono">{DEMO_PERSONA_ID}</span>
            </span>
          }
        >
          {ordered.length === 0 ? (
            <p className="text-table text-muted-foreground">No items loaded.</p>
          ) : (
            ordered.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                state={state}
                onChange={(attr, value) => setState((s) => withResponse(s, item.id, attr, value))}
              />
            ))
          )}

          <h3 className="mt-4 text-table font-semibold text-foreground">
            Gate questions{" "}
            <span className="text-caption font-normal text-muted-foreground">
              (wording from the gate table)
            </span>
          </h3>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`${uid}-hosp`} className="block text-caption text-muted-foreground">
                {gateLabel(gates, "hospitalization")}
              </label>
              <select
                id={`${uid}-hosp`}
                className={SELECT_CLASS}
                value={state.hospitalization ? "yes" : "no"}
                onChange={(e) =>
                  setState((s) => ({ ...s, hospitalization: e.target.value === "yes" }))
                }
              >
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </select>
            </div>
            <div>
              <label htmlFor={`${uid}-cm`} className="block text-caption text-muted-foreground">
                {gateLabel(gates, "conmed")}
              </label>
              <select
                id={`${uid}-cm`}
                className={SELECT_CLASS}
                value={state.conmedChanged ? "yes" : "no"}
                onChange={(e) =>
                  setState((s) => ({ ...s, conmedChanged: e.target.value === "yes" }))
                }
              >
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </select>
            </div>
            {state.conmedChanged && (
              <>
                <div>
                  <label
                    htmlFor={`${uid}-cmtext`}
                    className="block text-caption text-muted-foreground"
                  >
                    {prompts.conmedText}
                  </label>
                  <input
                    id={`${uid}-cmtext`}
                    type="text"
                    className={INPUT_CLASS}
                    value={state.conmedText}
                    aria-describedby={`${uid}-cmtext-note`}
                    onChange={(e) => setState((s) => ({ ...s, conmedText: e.target.value }))}
                  />
                  <p
                    id={`${uid}-cmtext-note`}
                    className="mt-0.5 text-caption text-muted-foreground"
                  >
                    Sent verbatim; the server's string matcher proposes a name.
                  </p>
                </div>
                <div>
                  <label
                    htmlFor={`${uid}-cmdir`}
                    className="block text-caption text-muted-foreground"
                  >
                    {prompts.conmedDirection}
                  </label>
                  <select
                    id={`${uid}-cmdir`}
                    className={SELECT_CLASS}
                    value={state.conmedDirection}
                    onChange={(e) =>
                      setState((s) => ({
                        ...s,
                        conmedDirection: e.target.value as ConmedDirection,
                      }))
                    }
                  >
                    {DIRECTIONS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}
            <div className="sm:col-span-2">
              <label htmlFor={`${uid}-other`} className="block text-caption text-muted-foreground">
                {gateLabel(gates, "other")}
              </label>
              <input
                id={`${uid}-other`}
                type="text"
                className={INPUT_CLASS}
                value={state.otherText}
                aria-describedby={`${uid}-other-note`}
                onChange={(e) => setState((s) => ({ ...s, otherText: e.target.value }))}
              />
              <p id={`${uid}-other-note`} className="mt-0.5 text-caption text-muted-foreground">
                {prompts.otherNote}
              </p>
            </div>
            {tempField && (
              <div>
                <label htmlFor={`${uid}-temp`} className="block text-caption text-muted-foreground">
                  Typed temperature, optional ({tempField.unit})
                </label>
                <input
                  id={`${uid}-temp`}
                  type="number"
                  step={0.1}
                  min={tempField.min}
                  max={tempField.max}
                  className={INPUT_CLASS}
                  value={state.tempC}
                  onChange={(e) => setState((s) => ({ ...s, tempC: e.target.value }))}
                />
              </div>
            )}
          </div>
        </Card>

        <div className="space-y-4">
          <Card
            title="Vitals (generated client-side)"
            aside={<MeasuredBadge isMeasured={false} source="mock" />}
          >
            <label htmlFor={`${uid}-preset`} className="block text-caption text-muted-foreground">
              Scenario preset
            </label>
            <select
              id={`${uid}-preset`}
              className={SELECT_CLASS}
              value={state.preset}
              onChange={(e) => setState((s) => withPreset(s, e.target.value as VitalsPreset))}
            >
              {VITALS_PRESET_ORDER.map((p) => (
                <option key={p} value={p}>
                  {VITALS_PRESETS[p].label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-caption text-muted-foreground">{preset.description}</p>

            {state.preset !== "none" && (
              <>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  {levelInput("pulse", "Pulse", 1, "beats/min")}
                  {levelInput("breathing", "Breathing", 1, "breaths/min")}
                  {levelInput("confidence", "Confidence", 0.05, "0–1")}
                </div>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-caption" data-testid="sample-preview">
                    <caption className="sr-only">Generated simulated samples</caption>
                    <thead>
                      <tr className="border-b border-border text-left uppercase tracking-wide text-muted-foreground">
                        <th scope="col" className="py-1 pr-2">
                          t (s)
                        </th>
                        <th scope="col" className="py-1 pr-2">
                          Pulse
                        </th>
                        <th scope="col" className="py-1 pr-2">
                          Breathing
                        </th>
                        <th scope="col" className="py-1 pr-2">
                          Conf
                        </th>
                        <th scope="col" className="py-1 pr-2">
                          Window
                        </th>
                        <th scope="col" className="py-1">
                          Flags
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {samples.map((s) => (
                        <tr key={s.tsOffsetS} className="border-b border-border">
                          <td className="tnum py-1 pr-2">{s.tsOffsetS}</td>
                          <td className="tnum py-1 pr-2">{s.pulseBpm ?? "—"}</td>
                          <td className="tnum py-1 pr-2">{s.breathingBpm ?? "—"}</td>
                          <td className="tnum py-1 pr-2">{formatConfidence(s.pulseConf)}</td>
                          <td className="tnum py-1 pr-2">{s.windowS} s</td>
                          <td className="py-1 font-mono">{s.qualityFlags.join(" ") || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="mt-1 text-caption text-muted-foreground">
                    {samples.length} simulated samples, every one{" "}
                    <span className="font-mono">isMeasured: false</span>.
                  </p>
                </div>
              </>
            )}
          </Card>

          <Card title="Demo toggle">
            <label className="flex items-start gap-2 text-table text-foreground">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4"
                checked={state.simulatedAsMeasured}
                onChange={(e) => setState((s) => ({ ...s, simulatedAsMeasured: e.target.checked }))}
              />
              <span>Treat simulated vitals as measured for this run</span>
            </label>
            <p
              className={cx(
                "mt-2 rounded-control border px-3 py-2 text-caption",
                state.simulatedAsMeasured
                  ? "border-warning-border bg-warning-bg text-warning-fg"
                  : "border-border bg-surface-subtle text-foreground",
              )}
              role={state.simulatedAsMeasured ? "alert" : undefined}
            >
              Warning: with this ON, simulated samples become eligible for the corroboration rules
              and can raise the escalation tier by one step. They still never change a grade, and
              every VS row stays labeled Simulated. Default is OFF.
            </p>
          </Card>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" busy={busy} disabled={ordered.length === 0}>
              Run this persona
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setState(demoFormState());
                setOutcome(null);
                setError(null);
              }}
            >
              Reset to demo persona
            </Button>
          </div>
          <ErrorBanner error={error} message="The custom run failed" onRetry={() => void run()} />
        </div>
      </form>

      {outcome && (
        <Card title="Outcome of this run">
          <CustomResultView result={outcome.result} sessionId={outcome.session_id ?? null} />
        </Card>
      )}
    </div>
  );
}

/**
 * The three non-PRO-CTCAE gate questions, one per screen (CLAUDE.md §3.2):
 *   0. hospitalization / ER (yes/no)
 *   1. medication started or stopped (yes/no, then verbatim name + direction)
 *   2. anything else (free text, stored verbatim, never parsed)
 * Wording comes from GET /items `gates` (`label`, `text_prompt`,
 * `direction_prompt`, `note`) with the brief's text as fallback; see
 * `gatePrompts()` in lib/gates.ts. The participant never sees what each answer
 * triggers, and nothing typed here is altered before it is sent.
 */
import { Button } from "../../components/Button";
import { ErrorBanner } from "../../components/ErrorBanner";
import { GATE_ORDER, gateComplete, gateLabel, gatePrompts, type GateState } from "../../lib/gates";
import type { ConmedDirection, GateQuestion } from "../../lib/types";

const DIRECTIONS: Array<{ value: ConmedDirection; label: string }> = [
  { value: "started", label: "Started" },
  { value: "stopped", label: "Stopped" },
  { value: "both", label: "Both" },
];

export interface GateScreenProps {
  index: number;
  questions: GateQuestion[];
  itemCount: number;
  state: GateState;
  onChange: (patch: Partial<GateState>) => void;
  onBack: () => void;
  onNext: () => void;
  busy: boolean;
  error: unknown;
  onRetry: () => void;
}

export function GateScreen({
  index,
  questions,
  itemCount,
  state,
  onChange,
  onBack,
  onNext,
  busy,
  error,
  onRetry,
}: GateScreenProps) {
  const id = GATE_ORDER[index] ?? "other";
  const label = gateLabel(questions, id);
  const prompts = gatePrompts(questions);
  const complete = gateComplete(state, index);
  const isLast = index === GATE_ORDER.length - 1;

  return (
    <div className="mx-auto max-w-3xl">
      <p className="text-base font-medium uppercase tracking-wide text-slate-500">
        Question {itemCount + index + 1} of {itemCount + GATE_ORDER.length}
      </p>
      <h1 className="mt-1 text-3xl font-bold leading-snug text-slate-900 sm:text-4xl">{label}</h1>

      <div className="mt-8 space-y-8">
        {id === "hospitalization" && (
          <YesNo
            name="hospitalization"
            value={state.hospitalization}
            onChange={(v) => onChange({ hospitalization: v })}
          />
        )}

        {id === "conmed" && (
          <>
            <YesNo
              name="conmed"
              value={state.conmedChanged}
              onChange={(v) => onChange({ conmedChanged: v })}
            />
            {state.conmedChanged === true && (
              <>
                <div>
                  <label
                    htmlFor="conmed-text"
                    className="block text-xl font-semibold text-slate-800"
                  >
                    {prompts.conmedText}
                  </label>
                  <input
                    id="conmed-text"
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    value={state.conmedText}
                    onChange={(e) => onChange({ conmedText: e.target.value })}
                    className="mt-3 block w-full rounded-xl border border-slate-300 bg-white px-4 py-4 text-2xl text-slate-900"
                    placeholder="Type the name as it appears on the package"
                  />
                  <p className="mt-2 text-base text-slate-600">{prompts.conmedTextNote}</p>
                </div>
                <fieldset aria-labelledby="conmed-direction-label">
                  <legend
                    id="conmed-direction-label"
                    className="text-xl font-semibold text-slate-800"
                  >
                    {prompts.conmedDirection}
                  </legend>
                  <div
                    role="group"
                    aria-labelledby="conmed-direction-label"
                    className="mt-3 grid gap-3 sm:grid-cols-3"
                  >
                    {DIRECTIONS.map((d) => (
                      <Button
                        key={d.value}
                        variant="option"
                        size="lg"
                        block
                        selected={state.conmedDirection === d.value}
                        onClick={() => onChange({ conmedDirection: d.value })}
                      >
                        {d.label}
                      </Button>
                    ))}
                  </div>
                </fieldset>
              </>
            )}
          </>
        )}

        {id === "other" && (
          <div>
            <label htmlFor="other-text" className="sr-only">
              {label}
            </label>
            <textarea
              id="other-text"
              rows={5}
              value={state.otherText}
              onChange={(e) => onChange({ otherText: e.target.value })}
              className="block w-full rounded-xl border border-slate-300 bg-white px-4 py-4 text-xl text-slate-900"
              placeholder="Optional"
            />
            <p className="mt-2 text-base text-slate-600">{prompts.otherNote}</p>
          </div>
        )}
      </div>

      {error ? (
        <ErrorBanner
          className="mt-6"
          error={error}
          message="Your answers were not saved. Please try again."
          onRetry={onRetry}
        />
      ) : null}

      <div className="mt-10 flex items-center justify-between gap-4">
        <Button variant="ghost" size="lg" onClick={onBack} disabled={busy}>
          Back
        </Button>
        <Button
          size="xl"
          onClick={onNext}
          disabled={!complete || busy}
          busy={busy}
          className="min-w-48"
        >
          {isLast ? "Finish check-in" : "Next"}
        </Button>
      </div>
    </div>
  );
}

function YesNo({
  name,
  value,
  onChange,
}: {
  name: string;
  value: boolean | null;
  onChange: (v: boolean) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Yes or no"
      className="grid gap-3 sm:grid-cols-2"
      data-testid={`yesno-${name}`}
    >
      <Button
        variant="option"
        size="xl"
        block
        selected={value === true}
        onClick={() => onChange(true)}
      >
        Yes
      </Button>
      <Button
        variant="option"
        size="xl"
        block
        selected={value === false}
        onClick={() => onChange(false)}
      >
        No
      </Button>
    </div>
  );
}

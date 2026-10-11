/**
 * One PRO-CTCAE-style item per screen. The item's attributes (e.g. severity then
 * interference) are stacked as big button rows; each tap is POSTed immediately.
 *
 * Wording comes from the rules table via GET /items: the heading is the item's
 * `label` (the symptom in plain words), each attribute's question is
 * `prompts.<attribute>`, and the optional temperature box (fever item) takes its
 * label, unit and plausibility bounds from `optional_fields[]`. No clinical
 * number is hardcoded here.
 */
import { Button } from "../../components/Button";
import { ErrorBanner } from "../../components/ErrorBanner";
import {
  optionsFor,
  parseTemperature,
  promptFor,
  recallLine,
  temperatureField,
  temperatureProblem,
} from "../../lib/format";
import type { Attribute, Item } from "../../lib/types";

export interface ItemScreenProps {
  item: Item;
  /** 0-based position among items. */
  index: number;
  /** Number of symptom items (decides "Next" vs "Continue" on the last one). */
  total: number;
  /**
   * Total screens in the check-in (items + gate questions), so the counter reads
   * "Question 10 of 13" here and "Question 11 of 13" on the first gate, not "10 of 10".
   * Defaults to `total`.
   */
  screenTotal?: number;
  recallWindow: string;
  values: Partial<Record<Attribute, number>>;
  onSelect: (attribute: Attribute, value: number) => void;
  /** Optional typed temperature for items that allow it (fever_or_chills). */
  tempC: string;
  onTempChange: (raw: string) => void;
  canBack: boolean;
  onBack: () => void;
  canNext: boolean;
  nextBusy: boolean;
  onNext: () => void;
  error: unknown;
  onRetry: () => void;
}

export function ItemScreen({
  item,
  index,
  total,
  screenTotal,
  recallWindow,
  values,
  onSelect,
  tempC,
  onTempChange,
  canBack,
  onBack,
  canNext,
  nextBusy,
  onNext,
  error,
  onRetry,
}: ItemScreenProps) {
  const temp = temperatureField(item);
  const showTemp = temp !== null && values.presence === 1;
  const tempParsed = parseTemperature(tempC, temp);
  const tempProblem = showTemp ? temperatureProblem(tempParsed, temp) : null;
  const recall = recallLine(item, recallWindow);

  return (
    <div className="mx-auto max-w-3xl">
      <p className="text-base font-medium uppercase tracking-wide text-slate-500">
        Question {index + 1} of {screenTotal ?? total}
      </p>
      <h1
        id={`item-${item.id}-stem`}
        className="mt-1 text-3xl font-bold leading-snug text-slate-900 sm:text-4xl"
      >
        {item.label}
      </h1>
      {recall && <p className="mt-2 text-lg text-slate-600">{recall}</p>}

      <div className="mt-8 space-y-8">
        {item.attributes.map((attribute) => {
          const options = optionsFor(item, attribute);
          const groupId = `item-${item.id}-${attribute}`;
          return (
            <fieldset key={attribute} aria-labelledby={`${groupId}-label`} className="min-w-0">
              <legend id={`${groupId}-label`} className="text-xl font-semibold text-slate-800">
                {promptFor(item, attribute)}
              </legend>
              <div
                role="group"
                aria-labelledby={`${groupId}-label`}
                className="mt-3 grid gap-3 sm:grid-cols-2"
                data-testid={`options-${item.id}-${attribute}`}
              >
                {options.map((opt) => (
                  <Button
                    key={opt.value}
                    variant="option"
                    size="lg"
                    block
                    selected={values[attribute] === opt.value}
                    onClick={() => onSelect(attribute, opt.value)}
                    data-value={opt.value}
                  >
                    {opt.label}
                  </Button>
                ))}
              </div>
            </fieldset>
          );
        })}

        {showTemp && temp && (
          <div>
            <label
              htmlFor={`item-${item.id}-temp`}
              className="block text-xl font-semibold text-slate-800"
            >
              {temp.label}
            </label>
            <div className="mt-3 flex items-center gap-3">
              <input
                id={`item-${item.id}-temp`}
                type="number"
                inputMode="decimal"
                step="0.1"
                min={temp.min}
                max={temp.max}
                value={tempC}
                onChange={(e) => onTempChange(e.target.value)}
                aria-describedby={tempProblem ? `item-${item.id}-temp-problem` : undefined}
                aria-invalid={tempProblem ? true : undefined}
                className="tnum w-40 rounded-xl border border-slate-300 bg-white px-4 py-3 text-2xl text-slate-900"
                placeholder="37.0"
              />
              <span className="text-xl text-slate-700">{temp.unit}</span>
            </div>
            {tempProblem && (
              <p
                id={`item-${item.id}-temp-problem`}
                className="mt-2 text-base font-medium text-red-700"
                aria-live="polite"
              >
                {tempProblem}
              </p>
            )}
          </div>
        )}
      </div>

      {error ? (
        <ErrorBanner
          className="mt-6"
          error={error}
          message="Your answer was not saved. Please try again."
          onRetry={onRetry}
        />
      ) : null}

      <div className="mt-10 flex items-center justify-between gap-4">
        <Button variant="ghost" size="lg" onClick={onBack} disabled={!canBack}>
          Back
        </Button>
        <Button size="xl" onClick={onNext} disabled={!canNext} busy={nextBusy} className="min-w-48">
          {index + 1 === total ? "Continue" : "Next"}
        </Button>
      </div>
    </div>
  );
}

/**
 * One PRO-CTCAE-style item per screen on a glass question card. Each attribute
 * (e.g. severity then interference) is an AnswerGroup: single column, 64px rows,
 * solid selected + check. Each tap is POSTed immediately by the flow.
 *
 * Next is always enabled (KioskActionBar). Pressing it with a question unanswered
 * shows "Please choose an answer" next to that question instead of doing nothing.
 *
 * Wording comes from the rules table via GET /items: the heading is the item's
 * `label` (the symptom in plain words), each attribute's question is
 * `prompts.<attribute>`, and the optional temperature box (fever item) takes its
 * label, unit and plausibility bounds from `optional_fields[]`. No clinical
 * number is hardcoded here.
 */
import { useState } from "react";

import {
  optionsFor,
  parseTemperature,
  promptFor,
  recallLine,
  temperatureField,
  temperatureProblem,
} from "../../lib/format";
import { yesFirst } from "../../lib/gates";
import { useReadAloud, useSpeakOnShow } from "../../lib/speech";
import type { Attribute, Item } from "../../lib/types";
import { cn } from "@/lib/cn";
import { AnswerGroup } from "@/ui/kiosk/answer-group";
import { KioskActionBar } from "@/ui/kiosk/action-bar";
import { KioskProgress } from "@/ui/kiosk/progress";
import { QuestionCard } from "@/ui/kiosk/question-card";
import { KioskError } from "./KioskError";
import { KioskBottom } from "./KioskShell";

export const CHOOSE_ANSWER_TEXT = "Please choose an answer";

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
  /** Everything else allows moving on (no save in flight or failed, temperature valid). */
  canNext: boolean;
  nextBusy: boolean;
  onNext: () => void;
  error: unknown;
  onRetry: () => void;
  /** When the participant came here from the review screen, Next says "Done". */
  nextLabel?: string;
  /** Screens that come before the first item (the urgent question): shifts "Question N of M". */
  progressOffset?: number;
}

/** Answer options in display order: yes/no scales always list Yes first (R5.6). */
function displayOptions(item: Item, attribute: Attribute) {
  const options = optionsFor(item, attribute).map((o) => ({ value: o.value, label: o.label }));
  return attribute === "presence" ? yesFirst(options) : options;
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
  nextLabel,
  progressOffset = 0,
}: ItemScreenProps) {
  const [attempted, setAttempted] = useState(false);
  const temp = temperatureField(item);
  const showTemp = temp !== null && values.presence === 1;
  const tempParsed = parseTemperature(tempC, temp);
  const tempProblem = showTemp ? temperatureProblem(tempParsed, temp) : null;
  const recall = recallLine(item, recallWindow);
  const complete = item.attributes.every((a) => values[a] !== undefined);
  const titleId = `item-${item.id}-stem`;
  /** Two-part questions put both halves side by side so neither is below the fold (R5.6). */
  const twoPart = item.attributes.length > 1;

  const { on: readAloud } = useReadAloud();
  useSpeakOnShow(
    [
      item.label,
      ...(recall ? [recall] : []),
      ...item.attributes.flatMap((a) => [
        promptFor(item, a),
        ...displayOptions(item, a).map((o) => o.label),
      ]),
    ],
    readAloud,
  );

  function handleNext() {
    if (!complete) {
      setAttempted(true);
      return;
    }
    if (!canNext) return;
    onNext();
  }

  return (
    <div
      className={cn(
        "mx-auto flex w-full flex-col",
        twoPart ? "max-w-none gap-3" : "max-w-k-content gap-6",
      )}
    >
      <KioskProgress current={index + 1 + progressOffset} total={screenTotal ?? total} />
      <QuestionCard
        title={item.label}
        titleId={titleId}
        description={recall ?? undefined}
        focusKey={item.id}
        compact={twoPart}
        wide={twoPart}
      >
        <div className={twoPart ? "grid gap-x-10 gap-y-4 lg:grid-cols-2" : "flex flex-col gap-6"}>
          {item.attributes.map((attribute) => {
            const groupId = `item-${item.id}-${attribute}`;
            const missing = attempted && values[attribute] === undefined;
            return (
              <AnswerGroup<number>
                key={attribute}
                name={groupId}
                id={groupId}
                legend={
                  <span className={cn("text-k-lead font-semibold", twoPart && "leading-snug")}>
                    {promptFor(item, attribute)}
                  </span>
                }
                options={displayOptions(item, attribute)}
                density={twoPart ? "compact" : "comfortable"}
                value={values[attribute] ?? null}
                onValueChange={(v) => onSelect(attribute, v)}
                error={missing ? CHOOSE_ANSWER_TEXT : undefined}
                data-testid={`options-${item.id}-${attribute}`}
              />
            );
          })}
        </div>

        {showTemp && temp && (
          <div>
            <label
              htmlFor={`item-${item.id}-temp`}
              className="block text-k-lead font-semibold text-foreground"
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
                className="tabular min-h-k-option w-44 rounded-control border-2 border-input bg-surface px-5 text-k-answer text-foreground"
                placeholder="37.0"
              />
              <span className="text-k-answer text-muted-foreground">{temp.unit}</span>
            </div>
            {tempProblem && (
              <p
                id={`item-${item.id}-temp-problem`}
                className="mt-3 text-k-helper font-semibold text-destructive"
                aria-live="polite"
              >
                {tempProblem}
              </p>
            )}
          </div>
        )}
      </QuestionCard>

      {error ? (
        <KioskError message="Your answer was not saved. Please try again." onRetry={onRetry} />
      ) : null}

      <KioskBottom>
        <KioskActionBar
          showBack={canBack}
          onBack={onBack}
          onNext={handleNext}
          nextLoading={nextBusy}
          nextLabel={nextLabel ?? (index + 1 === total ? "Continue" : "Next")}
        />
      </KioskBottom>
    </div>
  );
}

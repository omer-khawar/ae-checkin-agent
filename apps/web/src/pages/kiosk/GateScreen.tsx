/**
 * The three non-PRO-CTCAE gate questions, one per screen (CLAUDE.md §3.2):
 *   0. hospitalization / ER (yes/no)
 *   1. medication started or stopped (yes/no, then verbatim name + direction)
 *   2. anything else (free text, stored verbatim, never parsed)
 * Wording comes from GET /items `gates` (`label`, `text_prompt`,
 * `direction_prompt`, `note`) with the brief's text as fallback; see
 * `gatePrompts()` in lib/gates.ts. The participant never sees what each answer
 * triggers, and nothing typed here is altered before it is sent.
 *
 * Nothing is posted from here any more: the last gate's Next opens the review
 * screen, and "Send my answers" there posts the gates. Next is always enabled;
 * with something missing it shows an inline prompt.
 */
import { Plus, X } from "lucide-react";
import { useState } from "react";

import {
  EMPTY_CONMED_ROW,
  GATE_ORDER,
  MAX_CONMEDS,
  MAX_CONMED_TEXT,
  gateComplete,
  gateLabel,
  gatePrompts,
  type ConmedRow,
  type GateState,
} from "../../lib/gates";
import { useReadAloud, useSpeakOnShow } from "../../lib/speech";
import type { ConmedDirection, GateQuestion } from "../../lib/types";
import { Button } from "@/ui/button";
import { AnswerGroup } from "@/ui/kiosk/answer-group";
import { KioskActionBar } from "@/ui/kiosk/action-bar";
import { KioskProgress } from "@/ui/kiosk/progress";
import { QuestionCard } from "@/ui/kiosk/question-card";
import { CHOOSE_ANSWER_TEXT } from "./ItemScreen";
import { KioskBottom } from "./KioskShell";

const DIRECTIONS: Array<{ value: ConmedDirection; label: string }> = [
  { value: "started", label: "Started" },
  { value: "stopped", label: "Stopped" },
  { value: "both", label: "Both" },
];

const YES_NO = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
] as const;

const INPUT_CLASS =
  "block w-full rounded-control border-2 border-input bg-surface px-5 py-4 text-k-answer text-foreground placeholder:text-subtle-foreground";

export interface GateScreenProps {
  index: number;
  questions: GateQuestion[];
  itemCount: number;
  state: GateState;
  onChange: (patch: Partial<GateState>) => void;
  onBack: () => void;
  onNext: () => void;
  /** Reserved for a future save-on-next; the screen never blocks on it today. */
  busy?: boolean;
  /** When the participant came here from the review screen, Next says "Done". */
  nextLabel?: string;
}

function yesNo(v: boolean | null): "yes" | "no" | null {
  return v === null ? null : v ? "yes" : "no";
}

export function GateScreen({
  index,
  questions,
  itemCount,
  state,
  onChange,
  onBack,
  onNext,
  busy = false,
  nextLabel,
}: GateScreenProps) {
  const [attempted, setAttempted] = useState(false);
  const id = GATE_ORDER[index] ?? "other";
  const label = gateLabel(questions, id);
  const prompts = gatePrompts(questions);
  const complete = gateComplete(state, index);
  const isLast = index === GATE_ORDER.length - 1;
  const titleId = `gate-${id}-stem`;
  const medsOn = state.conmedChanged === true;
  const manyMeds = state.conmeds.length > 1;

  const { on: readAloud } = useReadAloud();
  useSpeakOnShow(id === "other" ? [label] : [label, ...YES_NO.map((o) => o.label)], readAloud);

  function updateRow(i: number, patch: Partial<ConmedRow>) {
    onChange({ conmeds: state.conmeds.map((r, k) => (k === i ? { ...r, ...patch } : r)) });
  }
  function addRow() {
    if (state.conmeds.length >= MAX_CONMEDS) return;
    onChange({ conmeds: [...state.conmeds, { ...EMPTY_CONMED_ROW }] });
  }
  function removeRow(i: number) {
    onChange({ conmeds: state.conmeds.filter((_, k) => k !== i) });
  }

  function handleNext() {
    if (!complete) {
      setAttempted(true);
      return;
    }
    onNext();
  }

  return (
    <div className="mx-auto flex w-full max-w-k-content flex-col gap-6">
      <KioskProgress current={itemCount + index + 1} total={itemCount + GATE_ORDER.length} />
      <QuestionCard title={label} titleId={titleId} focusKey={`gate-${index}`}>
        {id === "hospitalization" && (
          <AnswerGroup<"yes" | "no">
            name="hospitalization"
            aria-labelledby={titleId}
            options={YES_NO}
            value={yesNo(state.hospitalization)}
            onValueChange={(v) => onChange({ hospitalization: v === "yes" })}
            error={attempted && state.hospitalization === null ? CHOOSE_ANSWER_TEXT : undefined}
            data-testid="yesno-hospitalization"
          />
        )}

        {id === "conmed" && (
          <>
            <AnswerGroup<"yes" | "no">
              name="conmed"
              aria-labelledby={titleId}
              options={YES_NO}
              value={yesNo(state.conmedChanged)}
              onValueChange={(v) => onChange({ conmedChanged: v === "yes" })}
              error={attempted && state.conmedChanged === null ? CHOOSE_ANSWER_TEXT : undefined}
              data-testid="yesno-conmed"
            />
            {medsOn && (
              <>
                {state.conmeds.map((row, i) => {
                  const inputId = i === 0 ? "conmed-text" : `conmed-text-${i}`;
                  const needMed = row.text.trim().length === 0;
                  const needDirection = row.direction === null;
                  return (
                    <div
                      key={i}
                      data-testid={`conmed-row-${i}`}
                      className={
                        manyMeds
                          ? "flex flex-col gap-4 rounded-control border-2 border-border p-4"
                          : "flex flex-col gap-6"
                      }
                    >
                      <div>
                        <div className="flex items-start justify-between gap-3">
                          <label
                            htmlFor={inputId}
                            className="block text-k-lead font-semibold text-foreground"
                          >
                            {i === 0 ? prompts.conmedText : `Medication ${i + 1}`}
                          </label>
                          {i > 0 && (
                            <Button
                              variant="secondary"
                              size="xl"
                              className="min-h-12 min-w-0 px-4 text-k-helper"
                              aria-label={`Remove medication ${i + 1}`}
                              leadingIcon={<X />}
                              onClick={() => removeRow(i)}
                            >
                              Remove
                            </Button>
                          )}
                        </div>
                        <input
                          id={inputId}
                          type="text"
                          autoComplete="off"
                          spellCheck={false}
                          maxLength={MAX_CONMED_TEXT}
                          value={row.text}
                          onChange={(e) => updateRow(i, { text: e.target.value })}
                          aria-invalid={attempted && needMed ? true : undefined}
                          className={`${INPUT_CLASS} mt-3`}
                          placeholder="Type the name as it appears on the package"
                        />
                        {i === 0 && (
                          <p className="mt-2 text-k-helper text-muted-foreground">
                            {prompts.conmedTextNote}
                          </p>
                        )}
                        {attempted && needMed && (
                          <p
                            role="alert"
                            className="mt-2 text-k-helper font-semibold text-destructive"
                          >
                            Please type the name of the medication
                          </p>
                        )}
                      </div>
                      <AnswerGroup<ConmedDirection>
                        name={`conmed-direction-${i}`}
                        legend={
                          <span className="text-k-lead font-semibold">
                            {prompts.conmedDirection}
                          </span>
                        }
                        options={DIRECTIONS}
                        density={manyMeds ? "compact" : "comfortable"}
                        value={row.direction}
                        onValueChange={(v) => updateRow(i, { direction: v })}
                        error={attempted && needDirection ? CHOOSE_ANSWER_TEXT : undefined}
                        data-testid={`conmed-direction-${i}`}
                      />
                    </div>
                  );
                })}
                <div>
                  <Button
                    variant="secondary"
                    size="xl"
                    leadingIcon={<Plus />}
                    disabled={state.conmeds.length >= MAX_CONMEDS}
                    onClick={addRow}
                  >
                    Add another medication
                  </Button>
                </div>
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
              className={INPUT_CLASS}
              placeholder="Optional"
            />
            <p className="mt-2 text-k-helper text-muted-foreground">{prompts.otherNote}</p>
          </div>
        )}
      </QuestionCard>

      <KioskBottom>
        <KioskActionBar
          onBack={onBack}
          onNext={handleNext}
          nextLoading={busy}
          nextLabel={nextLabel ?? (isLast ? "Review my answers" : "Next")}
        />
      </KioskBottom>
    </div>
  );
}

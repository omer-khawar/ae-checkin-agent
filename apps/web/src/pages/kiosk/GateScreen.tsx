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
import { useState } from "react";

import { GATE_ORDER, gateComplete, gateLabel, gatePrompts, type GateState } from "../../lib/gates";
import type { ConmedDirection, GateQuestion } from "../../lib/types";
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
  const needMed = state.conmedChanged === true && state.conmedText.trim().length === 0;
  const needDirection = state.conmedChanged === true && state.conmedDirection === null;

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
            {state.conmedChanged === true && (
              <>
                <div>
                  <label
                    htmlFor="conmed-text"
                    className="block text-k-lead font-semibold text-foreground"
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
                    aria-invalid={attempted && needMed ? true : undefined}
                    className={`${INPUT_CLASS} mt-3`}
                    placeholder="Type the name as it appears on the package"
                  />
                  <p className="mt-2 text-k-helper text-muted-foreground">
                    {prompts.conmedTextNote}
                  </p>
                  {attempted && needMed && (
                    <p role="alert" className="mt-2 text-k-helper font-semibold text-destructive">
                      Please type the name of the medication
                    </p>
                  )}
                </div>
                <AnswerGroup<ConmedDirection>
                  name="conmed-direction"
                  legend={
                    <span className="text-k-lead font-semibold">{prompts.conmedDirection}</span>
                  }
                  options={DIRECTIONS}
                  value={state.conmedDirection}
                  onValueChange={(v) => onChange({ conmedDirection: v })}
                  error={attempted && needDirection ? CHOOSE_ANSWER_TEXT : undefined}
                />
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

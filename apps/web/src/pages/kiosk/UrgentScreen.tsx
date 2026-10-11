/**
 * The first question after the study ID (R5.1): "Right now, are you having trouble
 * breathing, or chest pain or tightness?" Options are always Yes, No.
 *
 * Choosing Yes ends the check-in at once (the flow posts /urgent and shows the stop
 * screen; there is no Next to press). Choosing No keeps the answer on screen and Next
 * moves to the symptom questions. Pressing Next with nothing chosen shows
 * "Please choose an answer". The participant never sees what the answer triggers.
 */
import { useState } from "react";

import { yesFirst } from "../../lib/gates";
import { useReadAloud, useSpeakOnShow } from "../../lib/speech";
import { AnswerGroup } from "@/ui/kiosk/answer-group";
import { KioskActionBar } from "@/ui/kiosk/action-bar";
import { KioskProgress } from "@/ui/kiosk/progress";
import { QuestionCard } from "@/ui/kiosk/question-card";
import { CHOOSE_ANSWER_TEXT } from "./ItemScreen";
import { KioskBottom } from "./KioskShell";

const OPTIONS = yesFirst([
  { value: "no" as const, label: "No" },
  { value: "yes" as const, label: "Yes" },
]);

export interface UrgentScreenProps {
  label: string;
  /** "Question 1 of N" total across the whole check-in. */
  screenTotal: number;
  /** The remembered answer when the participant comes back with Back (only "no" is possible). */
  value: "yes" | "no" | null;
  onAnswer: (value: "yes" | "no") => void;
  onNext: () => void;
}

export function UrgentScreen({ label, screenTotal, value, onAnswer, onNext }: UrgentScreenProps) {
  const [attempted, setAttempted] = useState(false);
  const titleId = "gate-urgent-now-stem";
  const { on: readAloud } = useReadAloud();
  useSpeakOnShow([label, ...OPTIONS.map((o) => o.label)], readAloud);

  function handleNext() {
    if (value === null) {
      setAttempted(true);
      return;
    }
    onNext();
  }

  return (
    <div className="mx-auto flex w-full max-w-k-content flex-col gap-6">
      <KioskProgress current={1} total={screenTotal} />
      <QuestionCard title={label} titleId={titleId} focusKey="urgent-now">
        <AnswerGroup<"yes" | "no">
          name="urgent-now"
          aria-labelledby={titleId}
          options={OPTIONS}
          value={value}
          onValueChange={onAnswer}
          error={attempted && value === null ? CHOOSE_ANSWER_TEXT : undefined}
          data-testid="yesno-urgent-now"
        />
      </QuestionCard>

      <KioskBottom>
        <KioskActionBar showBack={false} onNext={handleNext} nextLabel="Next" />
      </KioskBottom>
    </div>
  );
}

/**
 * "Check your answers": a plain list of everything the participant said, each with an
 * Edit link, and one "Send my answers" button. Only here are the gate answers posted
 * and the check-in completed. Wording is the participant's own words, never a grade.
 */
import { Pencil } from "lucide-react";

import type { AnswerMap } from "../../lib/answers";
import { optionsFor, temperatureField } from "../../lib/format";
import { GATE_ORDER, gateLabel, type GateState } from "../../lib/gates";
import type { Attribute, GateQuestion, Item } from "../../lib/types";
import { KioskActionBar } from "@/ui/kiosk/action-bar";
import { QuestionCard } from "@/ui/kiosk/question-card";
import { Button } from "@/ui/button";
import { KioskError } from "./KioskError";
import { KioskBottom } from "./KioskShell";

export interface ReviewScreenProps {
  items: Item[];
  answers: AnswerMap;
  gateQuestions: GateQuestion[];
  gates: GateState;
  tempC: string;
  onEditItem: (index: number) => void;
  onEditGate: (index: number) => void;
  onBack: () => void;
  onSend: () => void;
  busy: boolean;
  error: unknown;
}

const DIRECTION_TEXT = { started: "started", stopped: "stopped", both: "started and stopped" };

function itemSummary(item: Item, answers: AnswerMap, tempC: string): string {
  const values = answers[item.id] ?? {};
  const parts = item.attributes.map((attribute: Attribute) => {
    const v = values[attribute];
    if (v === undefined) return "Not answered";
    return optionsFor(item, attribute).find((o) => o.value === v)?.label ?? String(v);
  });
  const temp = temperatureField(item);
  if (temp && values.presence === 1 && tempC.trim()) parts.push(`${tempC.trim()} ${temp.unit}`);
  return parts.join(" · ");
}

/** One line per answer: a single medicine reads "Yes: name (started)"; several list each one. */
function gateLines(id: (typeof GATE_ORDER)[number], g: GateState): string[] {
  if (id === "hospitalization") {
    return [g.hospitalization === null ? "Not answered" : g.hospitalization ? "Yes" : "No"];
  }
  if (id === "conmed") {
    if (g.conmedChanged === null) return ["Not answered"];
    if (!g.conmedChanged) return ["No"];
    const meds = g.conmeds.filter((r) => r.text.trim().length > 0);
    const line = (r: (typeof meds)[number]) =>
      `${r.text.trim()}${r.direction ? ` (${DIRECTION_TEXT[r.direction]})` : ""}`;
    if (meds.length <= 1) return [`Yes: ${meds[0] ? line(meds[0]) : ""}`.trimEnd()];
    return [`Yes, ${meds.length} medications:`, ...meds.map(line)];
  }
  return [g.otherText.trim() || "Nothing added"];
}

export function ReviewScreen({
  items,
  answers,
  gateQuestions,
  gates,
  tempC,
  onEditItem,
  onEditGate,
  onBack,
  onSend,
  busy,
  error,
}: ReviewScreenProps) {
  return (
    <div className="mx-auto flex w-full max-w-k-content flex-col gap-6" data-testid="review-screen">
      <QuestionCard
        title="Check your answers"
        titleSize="screen"
        description="Look over your answers. Tap Edit to change one. Nothing is sent until you press Send."
        focusKey="review"
      >
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {items.map((item, i) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-control border-2 border-border bg-surface px-5 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="m-0 text-k-helper text-muted-foreground">{item.label}</p>
                <p className="m-0 text-k-answer font-semibold">
                  {itemSummary(item, answers, tempC)}
                </p>
              </div>
              <Button
                variant="secondary"
                size="xl"
                className="min-h-12 min-w-0 px-4 text-k-helper"
                aria-label={`Edit: ${item.label}`}
                leadingIcon={<Pencil />}
                onClick={() => onEditItem(i)}
              >
                Edit
              </Button>
            </li>
          ))}
          {GATE_ORDER.map((id, i) => (
            <li
              key={id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-control border-2 border-border bg-surface px-5 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="m-0 text-k-helper text-muted-foreground">
                  {gateLabel(gateQuestions, id)}
                </p>
                <p className="m-0 break-words text-k-answer font-semibold">
                  {gateLines(id, gates).map((line, k) => (
                    <span key={k} className="block">
                      {line}
                    </span>
                  ))}
                </p>
              </div>
              <Button
                variant="secondary"
                size="xl"
                className="min-h-12 min-w-0 px-4 text-k-helper"
                aria-label={`Edit: ${gateLabel(gateQuestions, id)}`}
                leadingIcon={<Pencil />}
                onClick={() => onEditGate(i)}
              >
                Edit
              </Button>
            </li>
          ))}
        </ul>
      </QuestionCard>

      {error ? (
        <KioskError message="Your answers were not saved. Please try again." onRetry={onSend} />
      ) : null}

      <KioskBottom>
        <KioskActionBar
          onBack={onBack}
          onNext={onSend}
          nextLoading={busy}
          nextLabel="Send my answers"
          label="Send your answers"
        />
      </KioskBottom>
    </div>
  );
}

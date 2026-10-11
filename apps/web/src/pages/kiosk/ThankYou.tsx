import { Check } from "lucide-react";
import { useEffect } from "react";

import { Button } from "@/ui/button";
import { QuestionCard } from "@/ui/kiosk/question-card";

export interface ThankYouProps {
  onDone: () => void;
  /** Return to the welcome screen automatically after this many ms (0 = never). */
  autoResetMs?: number;
}

/** Final screen for Tiers 0–2. Next steps only; no grades, tiers or clinical words. */
export function ThankYou({ onDone, autoResetMs = 45_000 }: ThankYouProps) {
  useEffect(() => {
    if (!autoResetMs) return;
    const t = setTimeout(onDone, autoResetMs);
    return () => clearTimeout(t);
  }, [onDone, autoResetMs]);

  return (
    <div className="mx-auto w-full max-w-k-content">
      <QuestionCard
        title="Thank you. Your check-in is complete."
        titleSize="screen"
        focusKey="thankyou"
        className="items-center text-center"
      >
        <span
          aria-hidden="true"
          className="mx-auto flex size-16 items-center justify-center rounded-full bg-primary text-primary-foreground"
        >
          <Check className="size-9" strokeWidth={3} />
        </span>
        <div className="flex flex-col gap-3 text-k-body">
          <p className="m-0">Your answers have been saved for the study team to review.</p>
          <p className="m-0">
            If anything changes before your next visit, you can do another check-in or contact the
            study team.
          </p>
          <p className="m-0 text-k-helper text-muted-foreground">
            If you feel you need urgent help at any time, call 911 or go to the nearest emergency
            room.
          </p>
        </div>
        <Button size="xl" variant="primary" onClick={onDone}>
          Done
        </Button>
      </QuestionCard>
    </div>
  );
}

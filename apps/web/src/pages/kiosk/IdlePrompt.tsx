import { Button } from "@/ui/button";

export interface IdlePromptProps {
  secondsLeft: number;
  onStay: () => void;
}

/** "Are you still there?" overlay shown before an unattended check-in is discarded. */
export function IdlePrompt({ secondsLeft, onStay }: IdlePromptProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-6">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="idle-title"
        aria-describedby="idle-body"
        className="glass-strong flex w-full max-w-k-content flex-col gap-6 rounded-sheet p-10 text-center"
      >
        <h2 id="idle-title" className="m-0 text-k-question">
          Are you still there?
        </h2>
        <p id="idle-body" className="m-0 text-k-body text-muted-foreground">
          This check-in will start over in <span className="tabular">{secondsLeft}</span> seconds if
          you do nothing. Your unsent answers will not be kept.
        </p>
        <Button variant="primary" size="xl" autoFocus onClick={onStay}>
          I&apos;m still here
        </Button>
      </div>
    </div>
  );
}

import { Volume2 } from "lucide-react";
import { useReadAloud } from "@/lib/speech";
import { Button } from "@/ui/button";

/** Header toggle for kiosk read-aloud; styled like "Larger text". */
export function ReadAloudToggle() {
  const { on, setOn } = useReadAloud();
  return (
    <Button
      variant="secondary"
      size="xl"
      className="min-h-12 min-w-0 px-4 text-k-helper"
      aria-pressed={on}
      leadingIcon={<Volume2 />}
      onClick={() => setOn(!on)}
    >
      Read aloud
    </Button>
  );
}

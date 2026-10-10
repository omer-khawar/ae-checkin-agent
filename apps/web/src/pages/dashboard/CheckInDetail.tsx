import { useParams } from "react-router-dom";

import { Stub } from "./Stub";

/** /dashboard/checkins/:sessionId — answers · drafts with evidence · Why panel (CLAUDE.md §3.7.2). */
export function CheckInDetail() {
  const { sessionId } = useParams<{ sessionId: string }>();
  return (
    <Stub
      title="Check-in detail"
      description="Answers in order, AE/VS/CM drafts with clickable evidence, and the Why panel."
      params={{ sessionId }}
    />
  );
}

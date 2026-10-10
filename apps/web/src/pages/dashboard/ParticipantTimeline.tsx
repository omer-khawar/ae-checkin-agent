import { useParams } from "react-router-dom";

import { Stub } from "./Stub";

/** /dashboard/participants/:usubjid — symptom sparklines, vitals over time, open AEs, con-meds (CLAUDE.md §3.7.3). */
export function ParticipantTimeline() {
  const { usubjid } = useParams<{ usubjid: string }>();
  return (
    <Stub
      title="Participant timeline"
      description="Symptoms over time, vitals over time, open AEs and con-med changes."
      params={{ usubjid }}
    />
  );
}

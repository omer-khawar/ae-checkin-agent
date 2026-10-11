/**
 * Words for phone-call records (CONTRACTS.md R4.1) and note types. Plain
 * labels only; the components that use them live in PhoneCall.tsx.
 */
import { PHONE_CALL_NOTE_TYPE } from "../../../lib/api";
import type { CallDirection, CallerKind } from "../../../lib/types";

export function isPhoneCall(noteType: string | null | undefined): boolean {
  return noteType === PHONE_CALL_NOTE_TYPE;
}

export const CALLER_LABELS: Record<CallerKind, string> = {
  participant: "Participant",
  caregiver: "Caregiver",
  other: "Someone else",
};

export const DIRECTION_LABELS: Record<CallDirection, string> = {
  inbound: "They called the site",
  outbound: "The site called them",
};

const NOTE_TYPE_WORDS: Record<string, string> = {
  phone_call: "Phone call",
  progress_note: "Progress note",
  phone_note: "Phone note",
  consult: "Consult",
  outside_record: "Outside record",
  ed_note: "Emergency department note",
  urgent_care: "Urgent-care note",
  other: "Other",
};

/** "phone_call" → "Phone call", "ed_note" → "Emergency department note". */
export function noteTypeWords(noteType: string | null | undefined): string {
  if (!noteType) return "Note";
  return NOTE_TYPE_WORDS[noteType] ?? noteType.replace(/_/g, " ");
}

/** "Caregiver · they called the site", or null when neither is known. */
export function callSummary(caller?: string | null, direction?: string | null): string | null {
  const parts: string[] = [];
  if (caller) parts.push(CALLER_LABELS[caller as CallerKind] ?? caller);
  if (direction) {
    const d = DIRECTION_LABELS[direction as CallDirection] ?? direction;
    parts.push(parts.length ? d.charAt(0).toLowerCase() + d.slice(1) : d);
  }
  return parts.length ? parts.join(" · ") : null;
}

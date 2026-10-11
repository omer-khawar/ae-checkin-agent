/**
 * R6: the texts sent to the participant about this check-in ("Confirmation texted ✓"
 * plus the message), shown under the header. Nothing renders when none were sent.
 */
import { Time } from "../../../lib/format";
import type { ParticipantMessage } from "../../../lib/types";

function label(m: ParticipantMessage): string {
  const what = m.kind === "review_ack" ? "Review note" : "Confirmation";
  return m.status === "failed" ? `${what} text failed` : `${what} texted ✓`;
}

export function ParticipantTexts({ messages }: { messages?: ParticipantMessage[] }) {
  if (!messages?.length) return null;
  return (
    <section
      aria-label="Texts to the participant"
      className="rounded-panel border border-border bg-surface px-3 py-2 text-table"
      data-testid="participant-texts"
    >
      <ul className="m-0 list-none space-y-2 p-0">
        {messages.map((m) => (
          <li key={m.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span
              className={
                m.status === "failed"
                  ? "font-semibold text-danger-fg"
                  : "font-semibold text-success-fg"
              }
            >
              {label(m)}
            </span>
            <span className="text-muted-foreground">
              to {m.to_masked} · <Time iso={m.created_at} />
              {m.channel === "outbox" ? " · mock outbox (no SMS keys set)" : ""}
              {m.error ? ` · ${m.error}` : ""}
            </span>
            <q className="basis-full text-foreground">{m.body}</q>
          </li>
        ))}
      </ul>
    </section>
  );
}

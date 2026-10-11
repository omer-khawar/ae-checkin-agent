/**
 * /admin/outbox (R6): every text sent to a participant, newest first. With no Twilio keys
 * this list is the whole delivery (the mock outbox); with keys it is the send log.
 */
import { Link } from "react-router-dom";

import { ErrorBanner } from "../../components/ErrorBanner";
import { getMessages } from "../../lib/api";
import { Time } from "../../lib/format";
import type { MessageList } from "../../lib/types";
import { Button, PageHead, Panel } from "./SysUI";
import { useLoad } from "./useLoad";

const STATUS: Record<string, string> = {
  sent: "Sent (SMS)",
  outbox: "Mock outbox",
  failed: "Failed",
};

export function Outbox() {
  const list = useLoad<MessageList>(getMessages);
  const data = list.data;
  return (
    <div className="space-y-4">
      <PageHead
        title="Outbox"
        actions={
          <div className="flex items-center gap-3">
            <Link to="/admin" className="text-table text-primary underline underline-offset-2">
              Back to Admin
            </Link>
            <Button size="sm" variant="secondary" busy={list.loading} onClick={list.reload}>
              Refresh
            </Button>
          </div>
        }
      >
        Texts to participants: a confirmation when a check-in completes and a note when the study
        nurse acknowledges it.{" "}
        {data?.channel === "twilio"
          ? "Twilio keys are set, so new texts go out as real SMS."
          : "No Twilio keys are set, so texts are only stored here (mock outbox). All numbers are synthetic."}
      </PageHead>

      {list.error ? (
        <ErrorBanner error={list.error} message="Could not load the outbox" onRetry={list.reload} />
      ) : (
        <Panel title={`Messages (${data?.total ?? 0})`} flush>
          {!data ? (
            <p className="p-4 text-table text-muted-foreground" role="status">
              Loading…
            </p>
          ) : data.items.length === 0 ? (
            <p className="p-4 text-table text-muted-foreground">
              No texts yet. Complete a kiosk check-in for a participant with a phone on file.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-table" data-testid="outbox-table">
                <thead className="text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="px-4 py-2 font-medium">Time</th>
                    <th className="px-4 py-2 font-medium">Participant</th>
                    <th className="px-4 py-2 font-medium">To</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((m) => (
                    <tr key={m.id} className="border-b border-border align-top last:border-0">
                      <td className="whitespace-nowrap px-4 py-2">
                        <Time iso={m.created_at} />
                      </td>
                      <td className="whitespace-nowrap px-4 py-2">
                        {m.session_id ? (
                          <Link
                            to={`/dashboard/checkins/${m.session_id}`}
                            className="text-primary underline underline-offset-2"
                          >
                            {m.usubjid}
                          </Link>
                        ) : (
                          m.usubjid
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 tabular-nums">
                        {m.to ?? m.to_masked}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2">
                        {STATUS[m.status] ?? m.status}
                        {m.error ? <span className="block text-danger-fg">{m.error}</span> : null}
                      </td>
                      <td className="min-w-[18rem] px-4 py-2">{m.body}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}

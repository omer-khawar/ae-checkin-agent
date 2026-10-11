/** R6: the thank-you screen names the masked number a confirmation text went to. */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ParticipantTexts } from "../../dashboard/detail/ParticipantTexts";
import { ThankYou } from "../ThankYou";

describe("confirmation texts", () => {
  it("says where the confirmation was texted", () => {
    render(<ThankYou onDone={() => {}} autoResetMs={0} textedTo="•••-4821" />);
    expect(screen.getByTestId("thankyou-texted")).toHaveTextContent(
      "We texted a confirmation to •••-4821.",
    );
  });

  it("says nothing about a text when none was sent", () => {
    render(<ThankYou onDone={() => {}} autoResetMs={0} />);
    expect(screen.queryByTestId("thankyou-texted")).toBeNull();
  });

  it("shows 'Confirmation texted ✓' with the message on the check-in detail", () => {
    render(
      <ParticipantTexts
        messages={[
          {
            id: "m1",
            created_at: "2026-10-11T13:14:00Z",
            usubjid: "P-007",
            session_id: "s1",
            escalation_id: null,
            kind: "checkin_confirmation",
            to_masked: "•••-4821",
            body: "Study team: We received your check-in at 9:14 AM on Sun, Oct 11.",
            channel: "outbox",
            status: "outbox",
            error: null,
          },
        ]}
      />,
    );
    expect(screen.getByText("Confirmation texted ✓")).toBeInTheDocument();
    expect(screen.getByText(/We received your check-in at 9:14 AM/)).toBeInTheDocument();
  });
});

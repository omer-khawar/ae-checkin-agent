import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AnswerGroup } from "@/ui/kiosk/answer-group";
import { QuestionCard } from "@/ui/kiosk/question-card";

describe("QuestionCard", () => {
  it("renders a glass section named by its H1, with eyebrow and description", () => {
    render(
      <QuestionCard
        eyebrow="Shortness of breath"
        title="How severe was it at its worst?"
        description="Think about the last 7 days."
      />,
    );
    const heading = screen.getByRole("heading", {
      level: 1,
      name: "How severe was it at its worst?",
    });
    const section = screen.getByRole("region", { name: "How severe was it at its worst?" });
    expect(section.className).toContain("glass");
    expect(section).toContainElement(heading);
    expect(screen.getByText("Shortness of breath")).toBeInTheDocument();
    expect(screen.getByText("Think about the last 7 days.")).toBeInTheDocument();
  });

  it("focuses the heading on mount and when focusKey changes", () => {
    const { rerender } = render(<QuestionCard title="Question one" focusKey={1} />);
    expect(screen.getByRole("heading", { name: "Question one" })).toHaveFocus();
    (document.activeElement as HTMLElement).blur();
    rerender(<QuestionCard title="Question two" focusKey={2} />);
    expect(screen.getByRole("heading", { name: "Question two" })).toHaveFocus();
  });

  it("does not steal focus without a focusKey", () => {
    render(<QuestionCard title="Welcome" titleSize="screen" headingLevel={2} />);
    const heading = screen.getByRole("heading", { level: 2, name: "Welcome" });
    expect(heading).not.toHaveFocus();
    expect(heading.className).toContain("text-k-title");
  });

  it("lets the answer group reuse the heading as its name, so the question is read once", () => {
    render(
      <QuestionCard title="Did you have a fever or chills?" titleId="q-fever">
        <AnswerGroup
          name="fever"
          aria-labelledby="q-fever"
          options={[
            { value: "yes", label: "Yes" },
            { value: "no", label: "No" },
          ]}
        />
      </QuestionCard>,
    );
    expect(
      screen.getByRole("radiogroup", { name: "Did you have a fever or chills?" }),
    ).toBeInTheDocument();
  });
});

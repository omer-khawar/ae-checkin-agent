/** Note "Why" panel empty state names the source type (chart note vs phone call, R4.1). */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { WhyPanel } from "../WhyPanel";

describe("notes WhyPanel · empty state", () => {
  it("says 'note' for a chart note", () => {
    render(<WhyPanel why={[]} rulesFired={[]} />);
    expect(screen.getByText(/No rules fired for this note/)).toBeInTheDocument();
  });

  it("says 'phone call' for a logged call", () => {
    render(<WhyPanel why={[]} rulesFired={[]} isPhoneCall />);
    expect(screen.getByText(/No rules fired for this phone call/)).toBeInTheDocument();
    expect(screen.queryByText(/for this note/)).toBeNull();
  });
});

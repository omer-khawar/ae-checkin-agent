import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { UNAVAILABLE_TEXT, VitalsPanel, type VitalsPanelProps } from "../components/VitalsPanel";
import type { VitalsSample } from "../lib/types";
import { metricReady, metricSlot, signalQuality } from "../lib/vitals";

function sample(overrides: Partial<VitalsSample> = {}): VitalsSample {
  return {
    tsUtc: "2026-10-10T18:00:13.000Z",
    source: "mock",
    isMeasured: false,
    pulseBpm: 72,
    pulseConf: 0.93,
    breathingBpm: 14,
    breathingConf: 0.88,
    windowS: 12,
    qualityFlags: [],
    ...overrides,
  };
}

function bridge(overrides: Partial<VitalsPanelProps["bridge"]> = {}): VitalsPanelProps["bridge"] {
  return {
    connected: true,
    hello: {
      type: "hello",
      source: "mock",
      isMeasured: false,
      scenario: "resting",
      minConf: 0.6,
      gates: { pulseS: 12, breathingS: 30, hrvS: 60 },
      version: "0.1.0",
    },
    state: "collecting",
    status: { type: "status", state: "collecting", elapsedS: 13, sessionId: "s" },
    sample: sample(),
    published: { pulse: false, breathing: false, hrv: false },
    elapsedS: 13,
    waveform: [],
    lastError: null,
    activeSessionId: "s",
    captureLost: false,
    ...overrides,
  };
}

/** What the bridge actually emits during the timing gate: values AND confidences stripped. */
function gatePendingSample(): VitalsSample {
  return {
    tsUtc: "2026-10-10T18:00:03.000Z",
    source: "mock",
    isMeasured: false,
    windowS: 12,
    qualityFlags: ["gate_pending_pulse", "gate_pending_breathing", "gate_pending_hrv"],
  };
}

describe("VitalsPanel gating", () => {
  it("shows collecting… until the bridge publishes the metric", () => {
    render(<VitalsPanel bridge={bridge()} />);
    const pulse = screen.getByTestId("vital-pulse");
    expect(within(pulse).getByText("collecting…")).toBeInTheDocument();
    expect(within(pulse).queryByText("72")).not.toBeInTheDocument();
  });

  it("shows the value once published and confidence ≥ threshold", () => {
    render(
      <VitalsPanel bridge={bridge({ published: { pulse: true, breathing: false, hrv: false } })} />,
    );
    const pulse = screen.getByTestId("vital-pulse");
    expect(within(pulse).getByText("72")).toBeInTheDocument();
    expect(within(pulse).getByText("beats/min")).toBeInTheDocument();
    // breathing still gated
    expect(
      within(screen.getByTestId("vital-breathing")).getByText("collecting…"),
    ).toBeInTheDocument();
  });

  it("keeps collecting… when published but confidence is below threshold", () => {
    render(
      <VitalsPanel
        bridge={bridge({
          sample: sample({ pulseConf: 0.4, breathingConf: 0.4 }),
          published: { pulse: true, breathing: false, hrv: false },
        })}
      />,
    );
    expect(within(screen.getByTestId("vital-pulse")).getByText("collecting…")).toBeInTheDocument();
    expect(screen.getByText("Signal is weak")).toBeInTheDocument();
  });

  it("respects the bridge's low_conf_<metric> flag even with a high number", () => {
    render(
      <VitalsPanel
        bridge={bridge({
          sample: sample({ qualityFlags: ["low_conf_pulse"] }),
          published: { pulse: true, breathing: false, hrv: false },
        })}
      />,
    );
    expect(within(screen.getByTestId("vital-pulse")).getByText("collecting…")).toBeInTheDocument();
  });

  it("says Collecting, not Signal is weak, during the timing gate (confidences stripped)", () => {
    const { rerender } = render(
      <VitalsPanel bridge={bridge({ sample: gatePendingSample(), elapsedS: 3 })} />,
    );
    expect(screen.getByTestId("vitals-quality")).toHaveTextContent("Collecting");
    expect(screen.queryByText("Signal is weak")).not.toBeInTheDocument();
    expect(screen.queryByText("No signal")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("vital-pulse")).getByText("collecting…")).toBeInTheDocument();
    expect(screen.getByText("Capturing 0:03")).toBeInTheDocument();

    // Connected and warming, no sample yet: still Collecting.
    rerender(
      <VitalsPanel
        bridge={bridge({ sample: null, state: "warming", elapsedS: 0, status: null })}
      />,
    );
    expect(screen.getByTestId("vitals-quality")).toHaveTextContent("Collecting");

    // Pulse published with good confidence while breathing/HRV still gate-pending: Good signal.
    rerender(
      <VitalsPanel
        bridge={bridge({
          sample: sample({
            breathingBpm: undefined,
            breathingConf: undefined,
            qualityFlags: ["gate_pending_breathing", "gate_pending_hrv"],
          }),
          published: { pulse: true, breathing: false, hrv: false },
        })}
      />,
    );
    expect(screen.getByTestId("vitals-quality")).toHaveTextContent("Good signal");

    // A degraded-capture flag is reported at any time.
    rerender(
      <VitalsPanel
        bridge={bridge({
          sample: {
            ...gatePendingSample(),
            qualityFlags: ["gate_pending_pulse", "face_not_found"],
          },
        })}
      />,
    );
    expect(screen.getByTestId("vitals-quality")).toHaveTextContent("Signal is weak");
  });

  it("shows 'not available' for a metric the source never provides once its gate has elapsed", () => {
    const { rerender } = render(
      <VitalsPanel
        bridge={bridge({
          sample: sample({ hrvRmssdMs: undefined, hrvConf: undefined }),
          published: { pulse: true, breathing: true, hrv: false },
          elapsedS: 45,
        })}
      />,
    );
    // Before 60 s the HRV slot is still collecting.
    expect(within(screen.getByTestId("vital-hrv")).getByText("collecting…")).toBeInTheDocument();

    rerender(
      <VitalsPanel
        bridge={bridge({
          sample: sample({ hrvRmssdMs: undefined, hrvConf: undefined }),
          published: { pulse: true, breathing: true, hrv: false },
          elapsedS: 61,
        })}
      />,
    );
    expect(within(screen.getByTestId("vital-hrv")).getByText("not available")).toBeInTheDocument();
    expect(within(screen.getByTestId("vital-pulse")).getByText("72")).toBeInTheDocument();
    expect(screen.getByText("SIMULATED")).toBeInTheDocument();
  });

  it("always shows the SIMULATED / MEASURED word and the source", () => {
    const { rerender } = render(<VitalsPanel bridge={bridge()} />);
    expect(screen.getByText("SIMULATED")).toBeInTheDocument();
    expect(screen.getByText("mock")).toBeInTheDocument();
    rerender(
      <VitalsPanel bridge={bridge({ sample: sample({ isMeasured: true, source: "presage" }) })} />,
    );
    expect(screen.getByText("MEASURED")).toBeInTheDocument();
    expect(screen.getByText("presage")).toBeInTheDocument();
  });

  it("says vitals are unavailable when disconnected or on source error", () => {
    const { rerender } = render(
      <VitalsPanel bridge={bridge({ connected: false, state: "disconnected" })} />,
    );
    expect(screen.getByText(UNAVAILABLE_TEXT)).toBeInTheDocument();
    rerender(<VitalsPanel bridge={bridge({ state: "error", lastError: "camera lost" })} />);
    expect(screen.getByText(UNAVAILABLE_TEXT)).toBeInTheDocument();
    expect(screen.queryByText("72")).not.toBeInTheDocument();
  });

  it("says vitals are unavailable when capture is lost or the bridge is idle with nothing to capture", () => {
    const { rerender } = render(
      <VitalsPanel bridge={bridge({ captureLost: true, state: "idle", sample: null })} />,
    );
    expect(screen.getByText(UNAVAILABLE_TEXT)).toBeInTheDocument();
    expect(screen.getByText("SIMULATED")).toBeInTheDocument();
    expect(screen.queryByText("collecting…")).not.toBeInTheDocument();

    // Idle bridge, no active session (e.g. the panel rendered outside a check-in).
    rerender(
      <VitalsPanel
        bridge={bridge({ state: "idle", sample: null, activeSessionId: null, captureLost: false })}
      />,
    );
    expect(screen.getByText(UNAVAILABLE_TEXT)).toBeInTheDocument();
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();

    // Idle but a session was just requested (bridge still resolving): Starting…, within grace.
    rerender(
      <VitalsPanel
        bridge={bridge({ state: "idle", sample: null, activeSessionId: "s", captureLost: false })}
      />,
    );
    expect(screen.queryByText(UNAVAILABLE_TEXT)).not.toBeInTheDocument();
    expect(screen.getByText("Starting…")).toBeInTheDocument();
  });

  it("draws the pleth sparkline from waveform points", () => {
    render(<VitalsPanel bridge={bridge({ waveform: [0, 1, 0.5, 0.2, 0.9] })} />);
    expect(screen.getByTestId("pleth-sparkline")).toBeInTheDocument();
  });

  it("metricReady is a pure gate", () => {
    expect(metricReady({ value: 72, conf: 0.9, published: true }, 0.6, [], "low_conf_pulse")).toBe(
      true,
    );
    expect(metricReady({ value: 72, conf: 0.9, published: false }, 0.6, [], "low_conf_pulse")).toBe(
      false,
    );
    expect(metricReady({ value: 72, conf: 0.5, published: true }, 0.6, [], "low_conf_pulse")).toBe(
      false,
    );
    expect(
      metricReady({ value: undefined, conf: 0.9, published: true }, 0.6, [], "low_conf_pulse"),
    ).toBe(false);
    expect(
      metricReady(
        { value: 72, conf: 0.9, published: true },
        0.6,
        ["low_conf_pulse"],
        "low_conf_pulse",
      ),
    ).toBe(false);
    expect(
      metricReady({ value: 72, conf: undefined, published: true }, 0.6, [], "low_conf_pulse"),
    ).toBe(true);
  });

  it("metricSlot and signalQuality are pure", () => {
    const base = { metric: "hrv" as const, conf: undefined, published: false, gateS: 60 };
    expect(metricSlot({ ...base, value: undefined, elapsedS: 10 }, 0.6, ["gate_pending_hrv"])).toBe(
      "collecting",
    );
    expect(metricSlot({ ...base, value: undefined, elapsedS: 70 }, 0.6, [])).toBe("not_available");
    expect(metricSlot({ ...base, value: 40, conf: 0.3, elapsedS: 70 }, 0.6, ["low_conf_hrv"])).toBe(
      "collecting",
    );
    expect(
      metricSlot({ ...base, value: 40, conf: 0.9, published: true, elapsedS: 70 }, 0.6, []),
    ).toBe("value");

    const q = (over: Partial<Parameters<typeof signalQuality>[0]>) =>
      signalQuality(
        {
          unavailable: false,
          hasSample: true,
          flags: [],
          publishedConfs: [],
          lowConfPublished: false,
          ...over,
        },
        0.6,
      );
    expect(q({ unavailable: true })).toBe("unavailable");
    expect(q({ hasSample: false })).toBe("collecting");
    expect(q({ flags: ["gate_pending_pulse"] })).toBe("collecting");
    expect(q({ publishedConfs: [0.9] })).toBe("good");
    expect(q({ publishedConfs: [0.9, 0.4] })).toBe("degraded");
    expect(q({ publishedConfs: [undefined] })).toBe("good");
    expect(q({ lowConfPublished: true })).toBe("degraded");
    expect(q({ flags: ["motion"], publishedConfs: [0.95] })).toBe("degraded");
  });
});

import { describe, expect, it } from "vitest";

import type { AuditEvent } from "../../../../lib/types";
import {
  CHAIN_LINK_TEXT,
  chainLinkTo,
  describeAction,
  entityLinkFor,
  GENESIS_PREV_HASH,
  KNOWN_ACTIONS,
  measuredFlags,
  payloadHighlights,
  prettyJson,
  sortNewestFirst,
  truncateHash,
} from "../auditLib";

function ev(overrides: Partial<AuditEvent>): AuditEvent {
  return {
    id: "01JAUDIT0000000000000000AA",
    seq: 1,
    ts_utc: "2026-10-10T18:00:00.000Z",
    actor_id: "coordinator",
    actor_role: "coordinator",
    action: "draft.confirmed",
    entity_type: "draft",
    entity_id: "01JDRAFT0000000000000000AA",
    payload: {},
    prev_hash: GENESIS_PREV_HASH,
    hash: "a".repeat(64),
    ...overrides,
  };
}

describe("truncateHash", () => {
  it("keeps a 10-char prefix and an ellipsis", () => {
    expect(truncateHash("0123456789abcdef")).toBe("0123456789…");
    expect(truncateHash("short")).toBe("short");
    expect(truncateHash(null)).toBe("—");
    expect(truncateHash("")).toBe("—");
  });
});

describe("chainLinkTo", () => {
  const older = ev({ seq: 4, hash: "b".repeat(64), prev_hash: "c".repeat(64) });
  it("is linked when prev_hash equals the older row's hash and seq is adjacent", () => {
    expect(chainLinkTo(ev({ seq: 5, prev_hash: "b".repeat(64) }), older)).toBe("linked");
  });
  it("is broken when adjacent by seq but hashes disagree", () => {
    expect(chainLinkTo(ev({ seq: 5, prev_hash: "d".repeat(64) }), older)).toBe("broken");
  });
  it("is a gap when the older row is not the immediate predecessor", () => {
    expect(chainLinkTo(ev({ seq: 9, prev_hash: "b".repeat(64) }), older)).toBe("gap");
  });
  it("recognises genesis and the end of the page", () => {
    expect(chainLinkTo(ev({ seq: 1, prev_hash: GENESIS_PREV_HASH }), older)).toBe("genesis");
    expect(chainLinkTo(ev({ seq: 5, prev_hash: "b".repeat(64) }), undefined)).toBe("end");
  });
  it("does not claim the predecessor is on the next page (it may be filtered out)", () => {
    expect(CHAIN_LINK_TEXT.end).not.toMatch(/is on the next page/);
    expect(CHAIN_LINK_TEXT.end).toMatch(/nothing below it to compare/);
  });
});

describe("describeAction / KNOWN_ACTIONS", () => {
  it("glosses known actions and humanises unknown ones", () => {
    expect(describeAction("draft.confirmed")).toMatch(/confirmed by a coordinator/i);
    expect(describeAction("note.scanned")).toMatch(/chart note/i);
    expect(describeAction("widget.frobbed_hard")).toBe("widget: frobbed hard");
    expect(describeAction("plain")).toBe("plain");
    expect(describeAction(undefined)).toBe("Unknown action");
  });
  it("glosses the actions the API emits beyond the contract list", () => {
    expect(describeAction("demo.seeded")).toMatch(/synthetic/i);
    expect(describeAction("ae_open.closed")).toMatch(/no longer ongoing/i);
    expect(describeAction("drafts.applied")).toMatch(/drafts/i);
    for (const a of ["vitals.batch", "rule.fired", "export.generated", "demo.seeded"]) {
      expect(KNOWN_ACTIONS).toContain(a);
    }
  });
});

describe("entityLinkFor", () => {
  it("links sessions to the check-in page", () => {
    expect(entityLinkFor(ev({ entity_type: "session", entity_id: "01JS" }))?.to).toBe(
      "/dashboard/checkins/01JS",
    );
  });
  it("links chart notes to the note detail page", () => {
    expect(entityLinkFor(ev({ entity_type: "note", entity_id: "01JN" }))?.to).toBe(
      "/dashboard/notes/01JN",
    );
  });
  it("links participants to their timeline", () => {
    expect(entityLinkFor(ev({ entity_type: "participant", entity_id: "NCT-P-007" }))?.to).toBe(
      "/dashboard/participants/NCT-P-007",
    );
  });
  it("falls back to payload.session_id, else null", () => {
    expect(entityLinkFor(ev({ entity_type: "draft", payload: { session_id: "01JS" } }))?.to).toBe(
      "/dashboard/checkins/01JS",
    );
    expect(entityLinkFor(ev({ entity_type: "settings", payload: { key: "x" } }))).toBeNull();
    expect(entityLinkFor(ev({ entity_type: "draft", payload: null as never }))).toBeNull();
  });
});

describe("measuredFlags", () => {
  it("reads the real vitals.batch shape: is_measured list + simulated + sources", () => {
    expect(measuredFlags({ is_measured: [false], simulated: true, sources: ["mock"] })).toEqual([
      false,
    ]);
    expect(measuredFlags({ is_measured: [true], simulated: false, sources: ["presage"] })).toEqual([
      true,
    ]);
  });
  it("reports both values for a mixed batch, measured first", () => {
    expect(measuredFlags({ is_measured: [false, true] })).toEqual([true, false]);
  });
  it("falls back to the simulated boolean, then the per-sample boolean", () => {
    expect(measuredFlags({ simulated: true })).toEqual([false]);
    expect(measuredFlags({ simulated: false })).toEqual([true]);
    expect(measuredFlags({ is_measured: true })).toEqual([true]);
    expect(measuredFlags({ isMeasured: false })).toEqual([false]);
  });
  it("says nothing for payloads without a measurement flag or with a malformed one", () => {
    expect(measuredFlags({ tier: 2 })).toEqual([]);
    expect(measuredFlags({ is_measured: [] })).toEqual([]);
    expect(measuredFlags({ is_measured: ["yes"] })).toEqual([]);
    expect(measuredFlags({ is_measured: "false" })).toEqual([]);
  });
});

describe("payloadHighlights", () => {
  it("surfaces the measured/simulated flag for a per-sample payload", () => {
    const h = payloadHighlights(
      ev({ action: "vitals.batch", payload: { is_measured: false, source: "mock", accepted: 7 } }),
    );
    expect(h[0]).toEqual({ kind: "measured", isMeasured: false, source: "mock" });
    expect(h).toContainEqual({ kind: "text", label: "accepted", value: "7" });
  });
  it("surfaces SIMULATED for the shipped vitals.batch payload (list + simulated + sources)", () => {
    const h = payloadHighlights(
      ev({
        action: "vitals.batch",
        payload: {
          n: 5,
          first_ts: "2026-10-10T18:00:01.000Z",
          last_ts: "2026-10-10T18:00:05.000Z",
          sources: ["mock"],
          is_measured: [false],
          simulated: true,
          posted_by: null,
        },
      }),
    );
    expect(h[0]).toEqual({ kind: "measured", isMeasured: false, source: "mock" });
    // The consumed keys are not repeated as text chips.
    const labels = h.filter((x) => x.kind === "text").map((x) => (x as { label: string }).label);
    expect(labels).toEqual(["n", "first_ts", "last_ts"]);
  });
  it("shows both badges for a mixed batch with the sources joined", () => {
    const h = payloadHighlights(
      ev({ payload: { is_measured: [false, true], sources: ["mock", "presage"] } }),
    );
    expect(h.slice(0, 2)).toEqual([
      { kind: "measured", isMeasured: true, source: "mock, presage" },
      { kind: "measured", isMeasured: false, source: "mock, presage" },
    ]);
  });
  it("surfaces a tier and caps scalar fields at three", () => {
    const h = payloadHighlights(
      ev({ payload: { tier: 2, a: "1", b: 2, c: true, d: "4", nested: { x: 1 } } }),
    );
    expect(h[0]).toEqual({ kind: "tier", tier: 2 });
    expect(h.filter((x) => x.kind === "text")).toHaveLength(3);
  });
  it("tolerates non-object payloads", () => {
    expect(payloadHighlights(ev({ payload: null as never }))).toEqual([]);
    expect(payloadHighlights(ev({ payload: "str" as never }))).toEqual([]);
  });
});

describe("prettyJson / sortNewestFirst", () => {
  it("pretty prints and never throws", () => {
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(prettyJson(undefined)).toBe("null");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(typeof prettyJson(circular)).toBe("string");
  });
  it("sorts by seq descending without mutating the input", () => {
    const input = [ev({ seq: 1 }), ev({ seq: 3 }), ev({ seq: 2 })];
    const out = sortNewestFirst(input);
    expect(out.map((e) => e.seq)).toEqual([3, 2, 1]);
    expect(input.map((e) => e.seq)).toEqual([1, 3, 2]);
  });
});

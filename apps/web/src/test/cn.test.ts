/**
 * cn() resolves conflicts between our custom theme keys and Tailwind defaults.
 * Imported through the "@/" alias on purpose: this test also proves the alias
 * resolves under Vitest (tsconfig paths + vite resolve.alias).
 */
import { describe, expect, it } from "vitest";

import { cn } from "@/lib/cn";

describe("cn", () => {
  it("joins conditional classes", () => {
    const off = false as boolean;
    expect(cn("a", off && "b", undefined, ["c", { d: true, e: false }])).toBe("a c d");
  });

  it("keeps a custom font size next to a token text colour", () => {
    expect(cn("text-caption", "text-muted-foreground")).toBe("text-caption text-muted-foreground");
    expect(cn("text-k-question text-foreground")).toBe("text-k-question text-foreground");
  });

  it("lets the later font size win", () => {
    expect(cn("text-sm", "text-table")).toBe("text-table");
    expect(cn("text-k-body", "text-k-answer")).toBe("text-k-answer");
  });

  it("lets the later colour win", () => {
    expect(cn("text-foreground", "text-tier-3-fg")).toBe("text-tier-3-fg");
    expect(cn("bg-surface", "bg-primary")).toBe("bg-primary");
  });

  it("merges named radii and shadows", () => {
    expect(cn("rounded-lg", "rounded-sheet")).toBe("rounded-sheet");
    expect(cn("shadow-card", "shadow-glass")).toBe("shadow-glass");
  });
});

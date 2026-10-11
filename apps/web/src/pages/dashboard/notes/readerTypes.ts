/**
 * R5.3 Gemini second reader: optional response fields and helpers.
 * Every field is optional so an older API response still renders unchanged.
 */
import type { ScanResult } from "../../../lib/types";

export type FoundBy = "scanner" | "gemini" | "both";

export interface ReaderInfo {
  status: "off" | "cache" | "live" | "error" | string;
  model: string | null;
  cached: boolean;
  reason: string | null;
}

export interface ReaderRejected {
  quote: string;
  reason: string;
}

export interface ReaderExtras {
  reader?: ReaderInfo | null;
  reader_rejected?: ReaderRejected[];
}

export type ScanWithReader = ScanResult & ReaderExtras;

export function foundByOf(f: unknown): FoundBy {
  const v = (f as { found_by?: unknown } | null)?.found_by;
  return v === "gemini" || v === "both" ? v : "scanner";
}

export const FOUND_BY_LABEL: Record<FoundBy, string> = {
  scanner: "Scanner",
  gemini: "Gemini",
  both: "Both",
};

export function readerOf(scan: unknown): ReaderInfo | null {
  const r = (scan as ReaderExtras | null)?.reader;
  return r && typeof r === "object" ? r : null;
}

export function rejectedOf(scan: unknown): ReaderRejected[] {
  const r = (scan as ReaderExtras | null)?.reader_rejected;
  return Array.isArray(r) ? r : [];
}

/** Plain-language status line, e.g. "Gemini second reader: on (cached, gemini-2.5-flash)". */
export function readerStatusText(reader: ReaderInfo | null): string {
  if (!reader) return "Gemini second reader: not reported by this server";
  if (reader.status === "off") {
    return `Gemini second reader: off: rules-only reading (${reader.reason || "no key"})`;
  }
  if (reader.status === "error") {
    return `Gemini second reader: unavailable, rules-only reading${reader.reason ? ` (${reader.reason})` : ""}`;
  }
  const how = reader.cached || reader.status === "cache" ? "cached" : "live";
  return `Gemini second reader: on (${how}${reader.model ? `, ${reader.model}` : ""})`;
}

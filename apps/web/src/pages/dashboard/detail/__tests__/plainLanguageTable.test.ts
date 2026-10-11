/**
 * Drift guard: the local plain-language fallback (`plainLanguageTable.ts`) must
 * match `packages/rules/data/plain_language.json` exactly (CONTRACTS.md R3.1).
 * When this fails, regenerate the copy from apps/web with
 * `node src/pages/dashboard/detail/genPlainLanguageTable.mjs`.
 */
import { describe, expect, it } from "vitest";

// The source of truth, imported straight from the rules package (resolveJsonModule).
import rawTable from "../../../../../../../packages/rules/data/plain_language.json";
import {
  PLAIN_CLOCK_KINDS,
  PLAIN_DOMAINS,
  PLAIN_EVIDENCE_KINDS,
  PLAIN_FIELDS,
  PLAIN_GRADES,
  PLAIN_INPUT_ALIASES,
  PLAIN_RENDER_AS,
  PLAIN_RULES,
  PLAIN_TIERS,
} from "../plainLanguageTable";

interface PlainLanguageJson {
  fields: Record<string, string | { label: string }>;
  rules: Record<string, { sentence: string; fallback: string }>;
  input_aliases: Record<string, string[]>;
  render_as: Record<string, string>;
  tiers: Record<string, string>;
  grades: Record<string, string>;
  clock_kinds: Record<string, unknown>;
  evidence_kinds: Record<string, string>;
  domains: Record<string, string>;
}

const table = rawTable as unknown as PlainLanguageJson;

describe("plainLanguageTable.ts matches plain_language.json", () => {
  it("has every field label, and no stale ones", () => {
    const expected = Object.fromEntries(
      Object.entries(table.fields).map(([k, v]) => [k, typeof v === "string" ? v : v.label]),
    );
    expect(PLAIN_FIELDS).toEqual(expected);
  });

  it("has every rule sentence (including the query.* edit checks), and no stale ones", () => {
    const expected = Object.fromEntries(
      Object.entries(table.rules).map(([k, v]) => [
        k,
        { sentence: v.sentence, fallback: v.fallback },
      ]),
    );
    expect(Object.keys(PLAIN_RULES).sort()).toEqual(Object.keys(expected).sort());
    expect(PLAIN_RULES).toEqual(expected);
    expect(PLAIN_RULES["query.vs_value_implausible"]?.sentence).toMatch(/vital-sign value/);
  });

  it("has the same tiers, grades, clock kinds, evidence kinds, domains and aliases", () => {
    expect(PLAIN_TIERS).toEqual(table.tiers);
    expect(PLAIN_GRADES).toEqual(table.grades);
    expect(PLAIN_CLOCK_KINDS).toEqual(table.clock_kinds);
    expect(PLAIN_EVIDENCE_KINDS).toEqual(table.evidence_kinds);
    expect(PLAIN_DOMAINS).toEqual(table.domains);
    expect(PLAIN_INPUT_ALIASES).toEqual(table.input_aliases);
    expect(PLAIN_RENDER_AS).toEqual(table.render_as);
  });
});

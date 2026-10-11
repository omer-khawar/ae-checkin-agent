/**
 * One section of the visit brief (new side effects, open side effects,
 * medication changes, escalations and clocks, notes and calls, vitals context,
 * or anything else the API adds). The API's plain-language title and item text
 * always lead; the decorations below are added by section kind:
 *
 * - side effects → grade trend arrow (provisional grades, investigator to confirm)
 * - medication changes → protocol flag chip (+ protocol section, exception text,
 *   missing CRF fields in plain words)
 * - escalations / clocks → tier chip (explicit tier name) and SAE/AESI clock chip
 * - notes → note type ("Phone call", "ER note")
 * - vitals → the word MEASURED or SIMULATED beside every line
 *
 * Every item is clickable: its text links to the record when the API gives a
 * link, and its evidence chips highlight everything else that cites the same id.
 */
import { Link } from "react-router-dom";

import { Card } from "../../../components/Card";
import { MeasuredBadge } from "../../../components/MeasuredBadge";
import { TierChip } from "../../../components/TierChip";
import { cx, Time } from "../../../lib/format";
import { EvidenceChips } from "./EvidenceChips";
import {
  CLOCK_LABELS,
  cites,
  formatDay,
  gradeTrend,
  measuredOf,
  noteTypeLabel,
  plainCmField,
  PROTOCOL_FLAG_STYLES,
  protocolFlagOf,
  protocolRef,
  safeLink,
  sectionKind,
  TREND_STYLES,
  type SectionKind,
} from "./model";
import type { BriefEvidenceRef, BriefItem, BriefSection } from "../../../lib/types";

export interface BriefSectionCardProps {
  section: BriefSection;
  /** Position on the page; used for stable element ids. */
  index: number;
  since: string | null;
  selected: string | null;
  onSelectEvidence: (id: string) => void;
  evidence?: Record<string, BriefEvidenceRef>;
  showTechnical: boolean;
}

/** Small explanatory line under some section titles. Plain language. */
const SECTION_CAPTIONS: Partial<Record<SectionKind, string>> = {
  side_effects:
    "Grades are provisional, from the participant's answers; the investigator confirms.",
  meds: "Checked against the study protocol's medication rules (§7.7).",
  vitals: "Context only. Vitals never change a grade.",
};

const EMPTY_TEXT: Record<SectionKind, string> = {
  side_effects: "No new side effects",
  open_aes: "No open side effects",
  meds: "No medication changes",
  escalations: "No escalations or report clocks",
  notes: "No notes or calls",
  vitals: "No vitals captured",
  other: "Nothing recorded",
};

function ItemText({ item }: { item: BriefItem }) {
  // Only in-app routes and http(s) URLs become links; anything else is plain text.
  const link = safeLink(item.link);
  if (!link) return <span>{item.text}</span>;
  const cls =
    "rounded text-slate-900 underline decoration-slate-300 underline-offset-2 hover:decoration-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 print:no-underline";
  if (link.kind === "internal") {
    return (
      <Link to={link.to} className={cls} title="Open the record">
        {item.text}
      </Link>
    );
  }
  return (
    <a href={link.href} className={cls} target="_blank" rel="noreferrer" title="Open the source">
      {item.text}
    </a>
  );
}

function TrendChip({ item }: { item: BriefItem }) {
  const trend = gradeTrend(item);
  if (!trend) return null;
  const s = TREND_STYLES[trend.direction];
  const path = trend.grades.length > 1 ? `grade ${trend.grades.join(" → ")}` : null;
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold",
        s.cls,
      )}
      title={`${s.label}${path ? ` (${path}, provisional)` : ""}`}
      data-trend={trend.direction}
    >
      <span aria-hidden="true" className="text-sm leading-none">
        {s.arrow}
      </span>
      <span>{s.label}</span>
      {path && <span className="font-normal opacity-80">· {path}</span>}
    </span>
  );
}

function ProtocolChips({ item, showTechnical }: { item: BriefItem; showTechnical: boolean }) {
  const flag = protocolFlagOf(item);
  const ref = protocolRef(item);
  return (
    <>
      {flag && (
        <span
          className={cx(
            "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold",
            PROTOCOL_FLAG_STYLES[flag].cls,
          )}
          data-protocol-flag={flag}
          title={`Protocol status: ${flag}${ref ? ` (${ref})` : ""}`}
        >
          {PROTOCOL_FLAG_STYLES[flag].label}
          {ref && <span className="font-mono font-normal">{ref}</span>}
        </span>
      )}
      {item.missing_fields && item.missing_fields.length > 0 && (
        <span className="text-xs text-slate-700">
          Still need: {item.missing_fields.map(plainCmField).join(", ")}
          {showTechnical && (
            <span className="ml-1 font-mono text-[11px] text-slate-500">
              ({item.missing_fields.join(", ")})
            </span>
          )}
        </span>
      )}
    </>
  );
}

function EscalationChips({ item }: { item: BriefItem }) {
  return (
    <>
      {item.tier !== null && item.tier !== undefined && <TierChip tier={item.tier} />}
      {typeof item.acknowledged === "boolean" && (
        <span
          className={cx(
            "rounded px-1.5 py-0.5 text-xs",
            item.acknowledged ? "bg-slate-100 text-slate-700" : "bg-amber-100 text-amber-900",
          )}
          data-acknowledged={item.acknowledged ? "true" : "false"}
        >
          {item.acknowledged ? "Acknowledged" : "Not yet acknowledged"}
        </span>
      )}
      {item.clock_kind && (
        <span
          className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-red-300 bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-900"
          title={CLOCK_LABELS[item.clock_kind].plain}
        >
          {CLOCK_LABELS[item.clock_kind].chip}
          <span className="font-normal">· {CLOCK_LABELS[item.clock_kind].plain}</span>
        </span>
      )}
      {item.due_at && (
        <span className="text-xs text-slate-700">
          due <Time iso={item.due_at} style="short" />
        </span>
      )}
      {item.status && (
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">
          {item.status}
        </span>
      )}
      {item.packet_id && (
        <Link
          to={`/dashboard/packets/${encodeURIComponent(item.packet_id)}`}
          className="rounded text-xs font-medium text-brand-700 underline decoration-slate-300 underline-offset-2 hover:decoration-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 print:hidden"
          data-packet-link={item.packet_id}
        >
          {item.packet_status === "signed" ? "Open signed report" : "Open report draft"}
        </Link>
      )}
    </>
  );
}

function Decorations({
  kind,
  item,
  showTechnical,
}: {
  kind: SectionKind;
  item: BriefItem;
  showTechnical: boolean;
}) {
  switch (kind) {
    case "side_effects":
      return <TrendChip item={item} />;
    case "meds":
      return <ProtocolChips item={item} showTechnical={showTechnical} />;
    case "escalations":
      return <EscalationChips item={item} />;
    case "notes": {
      const label = noteTypeLabel(item.note_type);
      return label ? (
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-800">
          {label}
        </span>
      ) : null;
    }
    case "vitals": {
      const m = measuredOf(item);
      return <MeasuredBadge isMeasured={m.isMeasured} source={item.source ?? undefined} />;
    }
    default:
      // A section we do not know still shows its own structured hints.
      return (
        <>
          {item.tier !== null && item.tier !== undefined && <TierChip tier={item.tier} />}
          {typeof item.is_measured === "boolean" && (
            <MeasuredBadge isMeasured={item.is_measured} source={item.source ?? undefined} />
          )}
        </>
      );
  }
}

export function BriefSectionCard({
  section,
  index,
  since,
  selected,
  onSelectEvidence,
  evidence,
  showTechnical,
}: BriefSectionCardProps) {
  const kind = sectionKind(section.key);
  const caption = SECTION_CAPTIONS[kind];
  const headingId = `brief-section-${index}`;
  return (
    <Card
      title={<span id={headingId}>{section.title}</span>}
      aside={
        <span className="flex items-center gap-2 text-xs text-slate-600">
          {showTechnical && (
            <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px]">
              {section.key}
            </span>
          )}
          <span className="tnum">{section.items.length}</span>
        </span>
      }
      aria-labelledby={headingId}
      data-section-key={section.key}
      className="break-inside-avoid print:shadow-none"
    >
      {caption && <p className="-mt-1 mb-3 text-xs text-slate-600">{caption}</p>}
      {section.items.length === 0 ? (
        <p className="text-sm text-slate-600">
          {EMPTY_TEXT[kind]}
          {since ? ` since ${formatDay(since)}` : ""}.
        </p>
      ) : (
        <ul className="space-y-2">
          {section.items.map((item, i) => {
            const hit = cites(item.evidence_ids, selected);
            return (
              <li
                key={`${i}-${item.text}`}
                id={`brief-item-${index}-${i}`}
                data-cited={hit ? "true" : undefined}
                className={cx(
                  "rounded-xl border px-3 py-2 transition-colors",
                  hit
                    ? "border-brand-500 bg-brand-50 ring-2 ring-brand-500/40"
                    : "border-slate-200",
                  "print:border-slate-300 print:bg-white print:ring-0",
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Decorations kind={kind} item={item} showTechnical={showTechnical} />
                  <span className="min-w-0 flex-1 text-sm leading-6 text-slate-900">
                    <ItemText item={item} />
                  </span>
                  {item.ts && (
                    <Time iso={item.ts} style="short" className="text-xs text-slate-500" />
                  )}
                </div>
                {item.exception_text && (
                  <blockquote className="mt-1 border-l-2 border-amber-300 pl-2 text-xs italic text-slate-700">
                    Protocol exception: “{item.exception_text}”
                  </blockquote>
                )}
                <EvidenceChips
                  ids={item.evidence_ids}
                  selected={selected}
                  onSelect={onSelectEvidence}
                  evidence={evidence}
                  showTechnical={showTechnical}
                  className="mt-1.5"
                />
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

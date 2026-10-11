/**
 * Findings / medications / red flags / excluded mentions as tables. Each row has
 * a "Show" button that selects the row's span so the note view outlines it.
 * Grade hints are explicitly labelled "provisional" with their basis.
 */
import { Button } from "../../../components/Button";
import { cx } from "../../../lib/format";
import { exclusionWording } from "./highlight";
import type { MedFinding, RedFlag, ScanResult, SymptomFinding } from "../../../lib/types";

type Range = { start: number; end: number };

export interface ScanTablesProps {
  scan: ScanResult;
  selectedRange?: Range | null;
  onSelectRange?: (range: Range | null) => void;
}

const TH = "px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-600";
const TD = "px-3 py-2 align-top text-sm";

function isSelected(f: { span_start: number; span_end: number }, r: Range | null | undefined) {
  return !!r && r.start === f.span_start && r.end === f.span_end;
}

function ShowButton({
  f,
  selected,
  onSelectRange,
  label,
}: {
  f: { span_start: number; span_end: number };
  selected: boolean;
  onSelectRange?: (range: Range | null) => void;
  label: string;
}) {
  if (!onSelectRange) return null;
  return (
    <Button
      size="sm"
      variant={selected ? "primary" : "ghost"}
      aria-pressed={selected}
      aria-label={`Show ${label} in the note`}
      onClick={() => onSelectRange(selected ? null : { start: f.span_start, end: f.span_end })}
    >
      {selected ? "Shown" : "Show"}
    </Button>
  );
}

function gradeText(f: SymptomFinding): string {
  if (f.grade_hint === null) return "—";
  return `G${f.grade_hint} (provisional)`;
}

function onsetText(f: SymptomFinding): string {
  if (f.onset_days === null) return "—";
  if (f.onset_days === 0) return "today";
  return `${f.onset_days} day${f.onset_days === 1 ? "" : "s"} before the note`;
}

export function SymptomTable({
  rows,
  excluded,
  selectedRange,
  onSelectRange,
}: {
  rows: SymptomFinding[];
  excluded?: boolean;
  selectedRange?: Range | null;
  onSelectRange?: (range: Range | null) => void;
}) {
  if (rows.length === 0) {
    return (
      <p className="px-3 py-2 text-sm text-slate-500">
        {excluded ? "No excluded symptom mentions." : "No symptom mentions found."}
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200">
        <thead>
          <tr>
            <th className={TH}>CTCAE term</th>
            <th className={TH}>Quote</th>
            {excluded ? (
              <th className={TH}>Why excluded</th>
            ) : (
              <>
                <th className={TH}>Grade hint</th>
                <th className={TH}>Onset</th>
                <th className={TH}>Worsening</th>
                <th className={TH}>Reason</th>
              </>
            )}
            {onSelectRange && (
              <th className={TH}>
                <span className="sr-only">Show in note</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((f, i) => {
            const sel = isSelected(f, selectedRange);
            return (
              <tr
                key={`${f.term}-${f.span_start}-${i}`}
                className={cx(sel && "bg-brand-50", excluded && "text-slate-500")}
                data-testid={excluded ? "excluded-symptom-row" : "symptom-row"}
              >
                <td
                  className={cx(TD, "font-medium", excluded ? "text-slate-600" : "text-slate-900")}
                >
                  {f.term}
                </td>
                <td className={cx(TD, "font-mono text-xs")}>“{f.quote}”</td>
                {excluded ? (
                  <td className={TD}>
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium">
                      {f.excluded_reason ?? "excluded"}
                    </span>
                    <div className="mt-1 text-xs text-slate-500">
                      {f.reason || exclusionWording(f.excluded_reason)}
                    </div>
                  </td>
                ) : (
                  <>
                    <td className={TD} title={f.grade_basis || undefined}>
                      <div className="font-medium">{gradeText(f)}</div>
                      {f.grade_basis && (
                        <div className="text-xs text-slate-600">{f.grade_basis}</div>
                      )}
                    </td>
                    <td className={TD}>{onsetText(f)}</td>
                    <td className={TD}>{f.worsening ? "Yes" : "—"}</td>
                    <td className={cx(TD, "text-slate-700")}>{f.reason || "—"}</td>
                  </>
                )}
                {onSelectRange && (
                  <td className={cx(TD, "text-right")}>
                    <ShowButton
                      f={f}
                      selected={sel}
                      onSelectRange={onSelectRange}
                      label={`“${f.quote}”`}
                    />
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function MedTable({
  rows,
  excluded,
  selectedRange,
  onSelectRange,
}: {
  rows: MedFinding[];
  excluded?: boolean;
  selectedRange?: Range | null;
  onSelectRange?: (range: Range | null) => void;
}) {
  if (rows.length === 0) {
    return (
      <p className="px-3 py-2 text-sm text-slate-500">
        {excluded ? "No excluded medication mentions." : "No medication mentions found."}
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200">
        <thead>
          <tr>
            <th className={TH}>Drug (lexicon)</th>
            <th className={TH}>Change</th>
            <th className={TH}>Quote</th>
            <th className={TH}>{excluded ? "Why excluded" : "Reason"}</th>
            {onSelectRange && (
              <th className={TH}>
                <span className="sr-only">Show in note</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((f, i) => {
            const sel = isSelected(f, selectedRange);
            return (
              <tr
                key={`${f.drug}-${f.span_start}-${i}`}
                className={cx(sel && "bg-brand-50", excluded && "text-slate-500")}
                data-testid={excluded ? "excluded-med-row" : "med-row"}
              >
                <td
                  className={cx(TD, "font-medium", excluded ? "text-slate-600" : "text-slate-900")}
                >
                  {f.drug}
                </td>
                <td className={TD}>
                  <span className="rounded bg-sky-50 px-1.5 py-0.5 text-xs font-medium text-sky-900">
                    {f.change}
                  </span>
                </td>
                <td className={cx(TD, "font-mono text-xs")}>“{f.quote}”</td>
                <td className={cx(TD, "text-slate-700")}>
                  {excluded ? (
                    <>
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium">
                        {f.excluded_reason ?? "excluded"}
                      </span>
                      <div className="mt-1 text-xs text-slate-500">
                        {f.reason || exclusionWording(f.excluded_reason)}
                      </div>
                    </>
                  ) : (
                    f.reason || "—"
                  )}
                </td>
                {onSelectRange && (
                  <td className={cx(TD, "text-right")}>
                    <ShowButton
                      f={f}
                      selected={sel}
                      onSelectRange={onSelectRange}
                      label={`“${f.quote}”`}
                    />
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function RedFlagTable({
  rows,
  selectedRange,
  onSelectRange,
}: {
  rows: RedFlag[];
  selectedRange?: Range | null;
  onSelectRange?: (range: Range | null) => void;
}) {
  if (rows.length === 0) {
    return <p className="px-3 py-2 text-sm text-slate-500">No red flags.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200">
        <thead>
          <tr>
            <th className={TH}>Level</th>
            <th className={TH}>Category</th>
            <th className={TH}>Quote</th>
            <th className={TH}>Reason</th>
            {onSelectRange && (
              <th className={TH}>
                <span className="sr-only">Show in note</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((f, i) => {
            const sel = isSelected(f, selectedRange);
            return (
              <tr
                key={`${f.category}-${f.span_start}-${i}`}
                className={cx(sel && "bg-brand-50")}
                data-testid="red-flag-row"
              >
                <td className={TD}>
                  <span
                    className={cx(
                      "rounded-full border px-2 py-0.5 text-xs font-semibold uppercase",
                      f.level === "emergency"
                        ? "border-red-700 bg-red-600 text-white"
                        : "border-orange-300 bg-orange-200 text-orange-900",
                    )}
                  >
                    {f.level}
                  </span>
                </td>
                <td className={cx(TD, "font-medium text-slate-900")}>{f.category}</td>
                <td className={cx(TD, "font-mono text-xs")}>“{f.quote}”</td>
                <td className={cx(TD, "text-slate-700")}>{f.reason || "—"}</td>
                {onSelectRange && (
                  <td className={cx(TD, "text-right")}>
                    <ShowButton
                      f={f}
                      selected={sel}
                      onSelectRange={onSelectRange}
                      label={`red flag “${f.quote}”`}
                    />
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The `id` is what the enclosing `<section aria-labelledby>` points at. */
function SectionHeading({ id, children, count }: { id: string; children: string; count: number }) {
  return (
    <h3 id={id} className="flex items-center gap-2 px-3 pt-3 text-sm font-semibold text-slate-900">
      {children}
      <span className="tnum rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
        {count}
      </span>
    </h3>
  );
}

/** All five tables stacked, in the order a reviewer reads them. */
export function ScanTables({ scan, selectedRange, onSelectRange }: ScanTablesProps) {
  const excludedCount = scan.excluded_symptoms.length + scan.excluded_meds.length;
  return (
    <div className="divide-y divide-slate-200">
      <section aria-labelledby="scan-red-flags">
        <SectionHeading id="scan-red-flags" count={scan.red_flags.length}>
          Red flags
        </SectionHeading>
        <RedFlagTable
          rows={scan.red_flags}
          selectedRange={selectedRange}
          onSelectRange={onSelectRange}
        />
      </section>
      <section aria-labelledby="scan-symptoms">
        <SectionHeading id="scan-symptoms" count={scan.symptoms.length}>
          Symptom findings
        </SectionHeading>
        <SymptomTable
          rows={scan.symptoms}
          selectedRange={selectedRange}
          onSelectRange={onSelectRange}
        />
      </section>
      <section aria-labelledby="scan-meds">
        <SectionHeading id="scan-meds" count={scan.meds.length}>
          Medication findings
        </SectionHeading>
        <MedTable rows={scan.meds} selectedRange={selectedRange} onSelectRange={onSelectRange} />
      </section>
      <section aria-labelledby="scan-excluded">
        <SectionHeading id="scan-excluded" count={excludedCount}>
          Excluded mentions
        </SectionHeading>
        <p className="px-3 pt-1 text-xs text-slate-600">
          Matched by a pattern but ruled out by a NegEx-style cue (negated, historical,
          hypothetical, resolved, allergy, indication). Shown so a reviewer can disagree.
        </p>
        <SymptomTable
          rows={scan.excluded_symptoms}
          excluded
          selectedRange={selectedRange}
          onSelectRange={onSelectRange}
        />
        <MedTable
          rows={scan.excluded_meds}
          excluded
          selectedRange={selectedRange}
          onSelectRange={onSelectRange}
        />
      </section>
    </div>
  );
}

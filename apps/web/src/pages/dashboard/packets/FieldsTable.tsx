/**
 * The report fields: plain label first, the value, its evidence chips, and the
 * SDTM / form field name in a small monospace badge one level deeper.
 *
 * Editing is staged: "Edit" opens an inline input, "Apply" stages the new value
 * on the page (the row then shows before → after), and the page's Save button
 * sends every staged change in one `PATCH /packets/{id}`, which the API stores
 * as a new version and audits. Nothing is overwritten in place.
 */
import { useId, useState } from "react";

import { Button } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { MeasuredBadge } from "../../../components/MeasuredBadge";
import { cx } from "../../../lib/format";
import { EvidenceChips, type EvidenceSelection } from "./EvidenceBits";
import {
  fieldMeasured,
  formatValue,
  isEmptyValue,
  parseEditText,
  valuesEqual,
  valueToEditText,
} from "./model";
import type { PacketField, PacketValue } from "../../../lib/types";

export interface FieldsTableProps {
  fields: PacketField[];
  /** Field name → staged (unsaved) value. */
  staged: Record<string, PacketValue>;
  canEdit: boolean;
  /** Why editing is off, shown once above the table (signed, or role). */
  readOnlyReason?: string | null;
  onStage: (name: string, value: PacketValue | undefined) => void;
  selectedKey: string | null;
  onSelectEvidence: (s: EvidenceSelection) => void;
}

export function FieldsTable({
  fields,
  staged,
  canEdit,
  readOnlyReason,
  onStage,
  selectedKey,
  onSelectEvidence,
}: FieldsTableProps) {
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <Card
      title="Report fields"
      flush
      aside={
        <span className="text-xs text-slate-500">
          {fields.length} field{fields.length === 1 ? "" : "s"}, pre-filled from evidence
        </span>
      }
    >
      {readOnlyReason && (
        <p className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-600">
          {readOnlyReason}
        </p>
      )}
      {fields.length === 0 ? (
        <p className="p-4 text-sm text-slate-600">
          This report has no pre-filled fields yet. The investigator can still write the narrative
          below.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-4 py-2 font-semibold">
                  Field
                </th>
                <th scope="col" className="px-4 py-2 font-semibold">
                  Value
                </th>
                <th scope="col" className="px-4 py-2 font-semibold">
                  Evidence
                </th>
                {canEdit && (
                  <th scope="col" className="px-4 py-2 font-semibold">
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {fields.map((f) => (
                <FieldRow
                  key={f.name}
                  field={f}
                  // Staged values and open editors only exist while editing is
                  // allowed; a frozen or signed table shows the server's values.
                  staged={canEdit && Object.prototype.hasOwnProperty.call(staged, f.name)}
                  stagedValue={staged[f.name]}
                  canEdit={canEdit}
                  isEditing={canEdit && editing === f.name}
                  onEdit={() => setEditing(f.name)}
                  onCancel={() => setEditing(null)}
                  onApply={(v) => {
                    onStage(f.name, valuesEqual(v, f.value) ? undefined : v);
                    setEditing(null);
                  }}
                  onUndo={() => onStage(f.name, undefined)}
                  selectedKey={selectedKey}
                  onSelectEvidence={onSelectEvidence}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

interface FieldRowProps {
  field: PacketField;
  staged: boolean;
  stagedValue: PacketValue | undefined;
  canEdit: boolean;
  isEditing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onApply: (v: PacketValue) => void;
  onUndo: () => void;
  selectedKey: string | null;
  onSelectEvidence: (s: EvidenceSelection) => void;
}

function FieldRow({
  field,
  staged,
  stagedValue,
  canEdit,
  isEditing,
  onEdit,
  onCancel,
  onApply,
  onUndo,
  selectedKey,
  onSelectEvidence,
}: FieldRowProps) {
  const inputId = useId();
  const current = staged ? (stagedValue ?? null) : field.value;
  const [text, setText] = useState(() => valueToEditText(current));
  const long = valueToEditText(field.value).length > 60;
  const measured = fieldMeasured(field);

  function startEdit() {
    setText(valueToEditText(current));
    onEdit();
  }

  return (
    <tr className={cx("align-top", staged && "bg-amber-50/60")} data-field={field.name}>
      <th scope="row" className="px-4 py-3 font-normal">
        <div className="font-semibold text-slate-900">{field.plain_label}</div>
        <code
          className="mt-0.5 inline-block rounded border border-slate-200 bg-slate-50 px-1 py-px font-mono text-[10px] text-slate-500"
          title="Form / SDTM field name"
        >
          {field.name}
        </code>
      </th>
      <td className="px-4 py-3">
        {isEditing ? (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              onApply(parseEditText(text, field.value));
            }}
          >
            <label htmlFor={inputId} className="sr-only">
              New value for {field.plain_label}
            </label>
            {long ? (
              <textarea
                id={inputId}
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                autoFocus
                className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/30"
              />
            ) : (
              <input
                id={inputId}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") onCancel();
                }}
                autoFocus
                className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/30"
              />
            )}
            <p className="text-xs text-slate-500">Leave empty for “not known yet”.</p>
            <div className="flex gap-2">
              <Button type="submit" size="sm">
                Apply
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cx(
                  "break-words",
                  isEmptyValue(current) ? "italic text-slate-500" : "text-slate-900",
                )}
              >
                {formatValue(current)}
              </span>
              {typeof measured === "boolean" && <MeasuredBadge isMeasured={measured} />}
              {measured === "not_stated" && (
                <span
                  className="whitespace-nowrap rounded-md border border-slate-400 bg-white px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-slate-700"
                  title="The server did not say whether this vitals value was measured by a sensor or simulated"
                  data-measured="not_stated"
                >
                  MEASURED / SIMULATED: not stated
                </span>
              )}
            </div>
            {staged && (
              <p className="text-xs text-amber-900">
                Changed, not saved yet. Was:{" "}
                <span className="line-through">{formatValue(field.value)}</span>
              </p>
            )}
            {!staged && field.edited && (
              <p className="text-xs text-slate-500">Edited by a person</p>
            )}
          </div>
        )}
      </td>
      <td className="px-4 py-3">
        <EvidenceChips
          items={field.evidence.map((e) => ({ id: e.id, evidence: e }))}
          keyPrefix={`field:${field.name}`}
          context={field.plain_label}
          selectedKey={selectedKey}
          onSelect={onSelectEvidence}
          emptyText="None: to be filled by the site"
        />
      </td>
      {canEdit && (
        <td className="whitespace-nowrap px-4 py-3 text-right">
          {!isEditing && (
            <div className="flex justify-end gap-1">
              <Button
                size="sm"
                variant="secondary"
                onClick={startEdit}
                aria-label={`Edit ${field.plain_label}`}
              >
                Edit
              </Button>
              {staged && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onUndo}
                  aria-label={`Undo change to ${field.plain_label}`}
                >
                  Undo
                </Button>
              )}
            </div>
          )}
        </td>
      )}
    </tr>
  );
}

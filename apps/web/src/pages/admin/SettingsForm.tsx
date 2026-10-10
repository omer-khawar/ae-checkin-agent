/**
 * Vitals source / mock scenario / simulated-as-measured form (CLAUDE.md §3.7.7).
 *
 * The form holds a draft; "Save" PUTs only the keys that changed (the API
 * audits the before/after as `settings.changed`). The toggle is OFF by default
 * and its warning is rendered the moment it is switched on, before saving, so
 * nobody saves it by accident.
 */
import { useEffect, useId, useState } from "react";

import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { ErrorBanner } from "../../components/ErrorBanner";
import { MeasuredBadge } from "../../components/MeasuredBadge";
import { useToast } from "../../components/Toast";
import { putAdminSettings } from "../../lib/api";
import { cx } from "../../lib/format";
import type { Settings } from "../../lib/types";
import {
  diffSettings,
  draftFrom,
  hasChanges,
  MOCK_SCENARIOS,
  SCENARIO_TABLE_SOURCE,
  SIMULATED_AS_MEASURED_WARNING,
  SOURCE_RESTART_NOTE,
  SOURCE_STATUS_LABELS,
  VITALS_SOURCES,
  VITALS_SOURCES_DOC,
  type SettingsDraft,
} from "./tables";

export interface SettingsFormProps {
  saved: Settings;
  /** Called with the API's response after a successful PUT. */
  onSaved: (next: Settings) => void;
  /**
   * Push the new mock scenario to a connected bridge (`set_scenario`, applies on
   * its next start). Returns whether the message went out.
   */
  notifyBridgeScenario?: (scenario: string) => boolean;
}

export function SettingsForm({ saved, onSaved, notifyBridgeScenario }: SettingsFormProps) {
  const toast = useToast();
  const [draft, setDraft] = useState<SettingsDraft>(() => draftFrom(saved));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const ids = { source: useId(), scenario: useId(), toggle: useId(), warn: useId() };

  // A reload/reset from the parent replaces the draft (the operator's unsaved
  // edits are dropped on purpose: the server copy is the truth after a reset).
  useEffect(() => {
    setDraft(draftFrom(saved));
  }, [saved]);

  const update = diffSettings(saved, draft);
  const dirty = hasChanges(update);
  const savedToggle = saved.simulated_as_measured === true;

  async function save() {
    if (!dirty) return;
    setSaving(true);
    setSaveError(null);
    try {
      const next = await putAdminSettings(update);
      onSaved(next);
      const changed = Object.keys(update).join(", ");
      let bridgeNote = "";
      if (update.mock_scenario !== undefined && notifyBridgeScenario) {
        bridgeNote = notifyBridgeScenario(update.mock_scenario)
          ? " Bridge notified (set_scenario, applies on its next start)."
          : " Bridge not connected; it reads the scenario from GET /settings/public on its next start.";
      }
      toast.push({
        kind: "success",
        title: "Settings saved",
        message: `Changed: ${changed}. Audited as settings.changed.${bridgeNote}`,
      });
    } catch (e) {
      setSaveError(e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card
      title="Vitals settings"
      aside={
        dirty ? (
          <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
            Unsaved changes
          </span>
        ) : (
          <span className="text-xs text-slate-500">Saved</span>
        )
      }
    >
      <form
        className="space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        aria-busy={saving || undefined}
      >
        {/* ---- Vitals source --------------------------------------------- */}
        <fieldset>
          <legend id={ids.source} className="text-sm font-semibold text-slate-900">
            Vitals source
          </legend>
          <p className="mt-1 text-xs text-slate-600">
            Saved: <code className="font-mono">{String(saved.vitals_source)}</code>
          </p>
          <div className="mt-2 space-y-2" role="radiogroup" aria-labelledby={ids.source}>
            {VITALS_SOURCES.map((s) => {
              const checked = draft.vitals_source === s.id;
              return (
                <label
                  key={s.id}
                  className={cx(
                    "flex cursor-pointer gap-3 rounded-xl border p-3",
                    checked ? "border-brand-700 bg-brand-50" : "border-slate-200 bg-white",
                  )}
                >
                  <input
                    type="radio"
                    name="vitals_source"
                    value={s.id}
                    checked={checked}
                    onChange={() => setDraft((d) => ({ ...d, vitals_source: s.id }))}
                    className="mt-1 h-4 w-4 accent-brand-700"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-slate-900">{s.label}</span>
                      <MeasuredBadge isMeasured={s.isMeasured} source={s.id} />
                      <span className="text-xs text-slate-500">
                        {SOURCE_STATUS_LABELS[s.status]}
                      </span>
                    </span>
                    <span className="mt-0.5 block text-sm text-slate-700">{s.description}</span>
                    {s.requirements && (
                      <span className="mt-0.5 block text-xs text-slate-600">
                        Needs: {s.requirements}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-slate-600">
            {SOURCE_RESTART_NOTE} Adapter contract and setup notes:{" "}
            <code className="font-mono">{VITALS_SOURCES_DOC}</code>.
          </p>
        </fieldset>

        {/* ---- Mock scenario --------------------------------------------- */}
        <fieldset>
          <legend id={ids.scenario} className="text-sm font-semibold text-slate-900">
            Mock scenario
          </legend>
          <p className="mt-1 text-xs text-slate-600">
            Saved: <code className="font-mono">{String(saved.mock_scenario)}</code>. Used only by
            the mock source; every sample it produces is <MeasuredBadge isMeasured={false} />.
            Table: {SCENARIO_TABLE_SOURCE}.
          </p>
          <div className="mt-2 space-y-2" role="radiogroup" aria-labelledby={ids.scenario}>
            {MOCK_SCENARIOS.map((sc) => {
              const checked = draft.mock_scenario === sc.id;
              // The row is a <div>, not one big <label>: a <summary> is not
              // interactive content in the HTML sense, so a click on it inside
              // a <label> would also activate the radio (and its text would
              // pad the radio's accessible name). The <details> is therefore a
              // sibling of the <label>, so "Why these numbers" only expands.
              return (
                <div
                  key={sc.id}
                  className={cx(
                    "rounded-xl border p-3",
                    checked ? "border-brand-700 bg-brand-50" : "border-slate-200 bg-white",
                  )}
                >
                  <label className="flex cursor-pointer gap-3" title={sc.rationale}>
                    <input
                      type="radio"
                      name="mock_scenario"
                      value={sc.id}
                      checked={checked}
                      onChange={() => setDraft((d) => ({ ...d, mock_scenario: sc.id }))}
                      className="mt-1 h-4 w-4 accent-brand-700"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-slate-900">{sc.label}</span>
                        <code className="font-mono text-xs text-slate-500">{sc.id}</code>
                      </span>
                      <span className="mt-0.5 block text-sm text-slate-700">{sc.physiology}</span>
                    </span>
                  </label>
                  <details className="ml-7 mt-0.5 text-xs text-slate-600">
                    <summary className="cursor-pointer select-none">
                      Why these numbers ({sc.label})
                    </summary>
                    <span className="block pt-1">{sc.rationale}</span>
                    <span className="block pt-1">Demo use: {sc.demoUse}</span>
                  </details>
                </div>
              );
            })}
          </div>
        </fieldset>

        {/* ---- Simulated as measured ------------------------------------- */}
        <div className="rounded-xl border border-slate-200 p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div id={ids.toggle} className="text-sm font-semibold text-slate-900">
                Treat simulated vitals as measured
              </div>
              <div className="mt-0.5 text-xs text-slate-600">
                Saved:{" "}
                <strong className={savedToggle ? "text-amber-900" : "text-slate-800"}>
                  {savedToggle ? "ON" : "OFF"}
                </strong>{" "}
                (default OFF). Grades are never affected; this only lets simulated samples pass the
                corroboration gate (rule vitals.simulated_as_measured).
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={draft.simulated_as_measured}
              aria-labelledby={ids.toggle}
              aria-describedby={draft.simulated_as_measured ? ids.warn : undefined}
              onClick={() =>
                setDraft((d) => ({ ...d, simulated_as_measured: !d.simulated_as_measured }))
              }
              className={cx(
                "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors duration-200 focus-visible:ring-4",
                draft.simulated_as_measured
                  ? "border-amber-600 bg-amber-500"
                  : "border-slate-300 bg-slate-200",
              )}
            >
              <span
                aria-hidden="true"
                className={cx(
                  "inline-block h-5 w-5 rounded-full bg-white shadow transition-transform duration-200",
                  draft.simulated_as_measured ? "translate-x-6" : "translate-x-1",
                )}
              />
              <span className="sr-only">{draft.simulated_as_measured ? "On" : "Off"}</span>
            </button>
          </div>
          {draft.simulated_as_measured && (
            <p
              id={ids.warn}
              role="alert"
              className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900"
            >
              {SIMULATED_AS_MEASURED_WARNING}
            </p>
          )}
        </div>

        <ErrorBanner error={saveError} message="Could not save settings" />

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={!dirty} busy={saving}>
            Save settings
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={!dirty || saving}
            onClick={() => setDraft(draftFrom(saved))}
          >
            Discard changes
          </Button>
          <span className="text-xs text-slate-500">
            PUT /api/v1/admin/settings · admin only · audited
          </span>
        </div>
      </form>
    </Card>
  );
}

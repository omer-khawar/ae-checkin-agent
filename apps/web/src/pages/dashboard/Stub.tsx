/**
 * Placeholder body for dashboard pages that a later wave replaces. Pages that use
 * it are the ONLY files that wave should need to touch; shared logic lives in
 * src/lib and src/components.
 */
import { Card } from "../../components/Card";

export interface StubProps {
  title: string;
  description: string;
  params?: Record<string, string | undefined>;
}

export function Stub({ title, description, params }: StubProps) {
  const entries = Object.entries(params ?? {}).filter(([, v]) => v !== undefined);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
      <Card>
        <p className="text-slate-700">{description}</p>
        <p className="mt-2 text-sm font-medium text-brand-800">Coming in the next wave.</p>
        {entries.length > 0 && (
          <dl className="mt-4 grid gap-1 text-sm">
            {entries.map(([k, v]) => (
              <div key={k} className="flex gap-2">
                <dt className="font-mono text-slate-500">{k}</dt>
                <dd className="font-mono text-slate-900">{v}</dd>
              </div>
            ))}
          </dl>
        )}
      </Card>
    </div>
  );
}

/**
 * Dashboard chrome: header with the demo study (GET /study), the synthetic-data
 * note, navigation, the signed-in role, the "time saved this week (estimate)"
 * strip (CLAUDE.md §00.5; hidden when the metric is unavailable), and the
 * persistent disclaimer footer. Pages render into <Outlet/>.
 */
import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";

import { getStudy } from "../lib/api";
import { ROLE_LABELS, useAuth } from "../lib/auth";
import { cx } from "../lib/format";
import type { Study } from "../lib/types";
import { Button } from "./Button";
import { Disclaimer } from "./Disclaimer";
import { TimeSavedStrip } from "./TimeSavedStrip";

const NAV: Array<{ to: string; label: string; end?: boolean }> = [
  { to: "/dashboard", label: "Queue", end: true },
  { to: "/dashboard/escalations", label: "Escalations" },
  { to: "/dashboard/notes", label: "Notes" },
  // Sponsor queries (CONTRACTS R4.4, step 7 of a side effect's life).
  { to: "/dashboard/queries", label: "Queries" },
  { to: "/dashboard/audit", label: "Audit" },
  { to: "/dashboard/eval", label: "Eval" },
];

export function Layout() {
  const { auth, role, logout } = useAuth();
  const navigate = useNavigate();
  const [study, setStudy] = useState<Study | null>(null);
  const [studyError, setStudyError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getStudy()
      .then((s) => {
        if (!cancelled) setStudy(s);
      })
      .catch(() => {
        if (!cancelled) setStudyError("Study record unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-screen-2xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link
            to="/dashboard"
            className="flex items-center gap-2 text-lg font-bold text-brand-800"
          >
            <span className="inline-block h-6 w-6 rounded-md bg-brand-700" aria-hidden="true" />
            Interim
          </Link>

          <div className="min-w-0 flex-1">
            <div
              className="truncate text-sm font-medium text-slate-900"
              title={study?.title ?? undefined}
            >
              {study ? (
                <>
                  {study.title}{" "}
                  <a
                    href={study.source_url}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-xs text-brand-700 underline"
                  >
                    {study.nct_id}
                  </a>
                </>
              ) : (
                <span className="text-slate-500">{studyError ?? "Loading study…"}</span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 text-xs text-slate-600">
              <span className="rounded bg-slate-100 px-1.5 py-0.5">
                Demo study (public registry record)
              </span>
              <span className="font-medium text-violet-800">
                {study?.participants_note ?? "All participants are synthetic."}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 text-sm">
            <span className="text-slate-600">
              {auth?.display_name ?? "—"} <span className="text-slate-400">·</span>{" "}
              <span className="font-medium text-slate-800">{role ? ROLE_LABELS[role] : ""}</span>
            </span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                logout();
                navigate("/login");
              }}
            >
              Sign out
            </Button>
            <Link to="/kiosk" className="text-xs text-brand-700 underline">
              Open kiosk
            </Link>
          </div>
        </div>
        {/* Row 2: navigation, with the time-saved strip on the right. Kept off row 1
            so the study title and the "synthetic" note get the full width at 1440 px
            instead of wrapping into a narrow column (intake e2e walkthrough). */}
        <div className="mx-auto flex max-w-screen-2xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 pb-2">
          <nav aria-label="Dashboard" className="flex flex-wrap items-center gap-1">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  cx(
                    "rounded-lg px-3 py-1.5 text-sm font-medium",
                    isActive ? "bg-brand-50 text-brand-900" : "text-slate-700 hover:bg-slate-100",
                  )
                }
              >
                {n.label}
              </NavLink>
            ))}
            {role === "admin" && (
              <NavLink
                to="/admin"
                className={({ isActive }) =>
                  cx(
                    "rounded-lg px-3 py-1.5 text-sm font-medium",
                    isActive ? "bg-brand-50 text-brand-900" : "text-slate-700 hover:bg-slate-100",
                  )
                }
              >
                Admin
              </NavLink>
            )}
          </nav>

          <TimeSavedStrip />
        </div>
      </header>

      <main className="mx-auto w-full max-w-screen-2xl flex-1 px-4 py-6">
        <Outlet />
      </main>

      <Disclaimer />
    </div>
  );
}

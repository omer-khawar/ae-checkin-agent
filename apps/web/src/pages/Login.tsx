/**
 * Role picker + shared demo password (CLAUDE.md §4.2). Username is the role name
 * for the three seeded users. After login → /dashboard (or the page the guard
 * bounced from).
 */
import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";

import { Button } from "../components/Button";
import { Disclaimer } from "../components/Disclaimer";
import { ErrorBanner } from "../components/ErrorBanner";
import { ROLE_LABELS, ROLES, useAuth } from "../lib/auth";
import type { Role } from "../lib/types";

export function Login() {
  const { isAuthenticated, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? "/dashboard";

  const [role, setRole] = useState<Role>("coordinator");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (isAuthenticated) return <Navigate to={from} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(role, password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-12">
        <div className="flex items-center gap-2 text-2xl font-bold text-brand-800">
          <span className="inline-block h-8 w-8 rounded-lg bg-brand-700" aria-hidden="true" />
          Interim
        </div>
        <p className="mt-1 text-slate-600">Between-visit check-in desk for study sites.</p>

        <form
          onSubmit={submit}
          className="mt-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-card"
        >
          <fieldset>
            <legend className="text-sm font-semibold text-slate-800">Sign in as</legend>
            <div role="group" aria-label="Role" className="mt-2 grid gap-2">
              {ROLES.map((r) => (
                <Button
                  key={r}
                  variant="option"
                  size="md"
                  block
                  selected={role === r}
                  onClick={() => setRole(r)}
                  data-role={r}
                >
                  <span className="font-mono text-xs text-slate-500">{r}</span>
                  <span>{ROLE_LABELS[r]}</span>
                </Button>
              ))}
            </div>
          </fieldset>

          <label htmlFor="password" className="mt-5 block text-sm font-semibold text-slate-800">
            Demo password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 block w-full rounded-xl border border-slate-300 px-3 py-2 text-base"
            required
          />
          <p className="mt-1 text-xs text-slate-500">
            Shared demo password from <code className="font-mono">DEMO_PASSWORD</code> in{" "}
            <code>.env</code>.
          </p>

          <ErrorBanner className="mt-4" error={error} message="Sign-in failed" />

          <Button type="submit" size="lg" block className="mt-5" busy={busy} disabled={!password}>
            Sign in
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-slate-600">
          Running a check-in?{" "}
          <Link to="/kiosk" className="font-medium text-brand-700 underline">
            Open kiosk
          </Link>
        </p>
        <p className="mt-6 text-center text-xs text-slate-500">
          Demo auth model: three seeded users and a shared password. Production would need SSO and
          per-user audit identity (see README).
        </p>
      </main>
      <Disclaimer />
    </div>
  );
}

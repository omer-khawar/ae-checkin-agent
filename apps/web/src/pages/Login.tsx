/**
 * Role picker + shared demo password (CLAUDE.md §4.2). Username is the role name
 * for the three seeded users. After login → /dashboard (or the page the guard
 * bounced from).
 */
import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";

import { BRAND_TAGLINE, BrandLockup, BrandWaves } from "@/ui/brand";
import { Button } from "@/ui/button";
import { GlassCard, GlassCardDescription, GlassCardTitle } from "@/ui/glass-card";
import { cn } from "@/lib/cn";
import { Disclaimer } from "../components/Disclaimer";
import { ErrorBanner } from "../components/ErrorBanner";
import { ROLE_LABELS, ROLES, useAuth } from "../lib/auth";
import type { Role } from "../lib/types";

export function Login() {
  const { isAuthenticated, login, sessionExpired } = useAuth();
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
    <div
      data-surface="console"
      className="login relative isolate flex min-h-screen flex-col overflow-hidden bg-background text-foreground"
    >
      <BrandWaves className="absolute inset-x-0 bottom-0 -z-10 h-[34vh] w-full" />
      <main
        id="main"
        className="relative mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-10"
      >
        <Link
          to="/"
          className="mb-4 inline-flex w-fit items-center gap-1 text-table text-muted-foreground hover:text-foreground"
        >
          <span aria-hidden="true">←</span> Back to home
        </Link>

        <GlassCard as="form" strength="strong" onSubmit={submit} className="shadow-elev-2">
          <div>
            <BrandLockup size="lg" />
            <p className="mt-3 font-display text-title font-semibold text-foreground">
              {BRAND_TAGLINE}
            </p>
            <GlassCardTitle className="mt-3 text-title">
              Sign in to the safety-data desk
            </GlassCardTitle>
            <GlassCardDescription className="text-table">
              Pick a role, enter the shared demo password.
            </GlassCardDescription>
          </div>

          <fieldset className="min-w-0">
            <legend className="text-table font-medium text-foreground">Role</legend>
            <div
              role="radiogroup"
              aria-label="Role"
              className="mt-1.5 grid gap-1 rounded-control border border-input bg-surface-subtle p-1"
            >
              {ROLES.map((r) => {
                const on = role === r;
                return (
                  <button
                    key={r}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    data-role={r}
                    onClick={() => setRole(r)}
                    className={cn(
                      "focus-ring transition-calm flex h-9 items-center justify-between gap-3 rounded-control border px-3 text-body",
                      on
                        ? "border-input bg-surface font-semibold text-foreground shadow-elev-1"
                        : "border-transparent text-muted-foreground hover:bg-surface hover:text-foreground",
                    )}
                  >
                    <span>{ROLE_LABELS[r]}</span>
                    <span className="font-mono text-caption text-muted-foreground">{r}</span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          <div>
            <label htmlFor="password" className="block text-table font-medium text-foreground">
              Demo password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1.5 block h-9 w-full rounded-control border border-input bg-surface px-3 text-body"
              required
            />
            <p className="mt-1 text-caption text-muted-foreground">
              Shared demo password from <code className="font-mono">DEMO_PASSWORD</code> in{" "}
              <code className="font-mono">.env</code>.
            </p>
          </div>

          {sessionExpired && !error && (
            <p role="status" className="m-0 text-table font-medium text-foreground">
              Your session expired. Please sign in again.
            </p>
          )}
          <ErrorBanner error={error} message="Sign-in failed" />

          <Button type="submit" variant="primary" fullWidth loading={busy} disabled={!password}>
            Sign in
          </Button>
        </GlassCard>

        <p className="mt-5 text-center text-table text-muted-foreground">
          Running a check-in?{" "}
          <Link to="/kiosk" className="font-medium text-primary underline underline-offset-2">
            Try the patient kiosk
          </Link>
        </p>
        <p className="mt-3 text-center text-caption text-muted-foreground">
          Demo auth model: three seeded users and a shared password. Production would need SSO and
          per-user audit identity (see README).
        </p>
      </main>
      <Disclaimer />
    </div>
  );
}

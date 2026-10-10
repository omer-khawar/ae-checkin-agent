/**
 * Demo auth model (CLAUDE.md §4.2): three seeded users share one password; the
 * API issues an HMAC-signed bearer token that we keep in `sessionStorage` so it
 * dies with the tab. The API enforces roles server-side on every mutating
 * endpoint; the client-side guard in `components/RequireRole.tsx` only shapes
 * navigation.
 *
 * This module is a tiny external store (no context needed) so `useAuth()` can be
 * called from anywhere, including outside the router.
 */
import { useSyncExternalStore } from "react";

import { AUTH_STORAGE_KEY, login as apiLogin } from "./api";
import type { LoginResponse, Role } from "./types";

export type AuthSession = LoginResponse;

export const ROLES: readonly Role[] = ["coordinator", "investigator", "admin"] as const;

export const ROLE_LABELS: Record<Role, string> = {
  coordinator: "Coordinator / research nurse",
  investigator: "Investigator",
  admin: "Admin / developer",
};

export function isRole(x: unknown): x is Role {
  return typeof x === "string" && (ROLES as readonly string[]).includes(x);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

type Listener = () => void;
const listeners = new Set<Listener>();
let cached: AuthSession | null | undefined; // undefined = not read yet

function read(): AuthSession | null {
  try {
    const raw = sessionStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AuthSession>;
    if (typeof parsed.token !== "string" || !isRole(parsed.role)) return null;
    if (typeof parsed.expires_at === "string" && Date.parse(parsed.expires_at) < Date.now()) {
      sessionStorage.removeItem(AUTH_STORAGE_KEY);
      return null;
    }
    return parsed as AuthSession;
  } catch {
    return null;
  }
}

function write(session: AuthSession | null): void {
  try {
    if (session) sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(AUTH_STORAGE_KEY);
  } catch {
    /* storage unavailable (private mode); auth still works in-memory */
  }
  cached = session;
  listeners.forEach((l) => l());
}

export function getAuth(): AuthSession | null {
  if (cached === undefined) cached = read();
  return cached;
}

export function getRole(): Role | null {
  return getAuth()?.role ?? null;
}

export function isAuthenticated(): boolean {
  return getAuth() !== null;
}

/** POST /auth/login then persist the session. Username is the role name for seeded users. */
export async function login(username: string, password: string): Promise<AuthSession> {
  const session = await apiLogin({ username, password });
  write(session);
  return session;
}

export function logout(): void {
  write(null);
}

/** Test/admin helper to drop the cache (e.g. after sessionStorage is cleared). */
export function resetAuthCache(): void {
  cached = undefined;
  listeners.forEach((l) => l());
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseAuth {
  auth: AuthSession | null;
  role: Role | null;
  isAuthenticated: boolean;
  login: typeof login;
  logout: typeof logout;
  /** True when the current role is one of `roles` (admin is NOT implicitly everything). */
  hasRole: (...roles: Role[]) => boolean;
}

export function useAuth(): UseAuth {
  const auth = useSyncExternalStore(subscribe, getAuth, getAuth);
  const role = auth?.role ?? null;
  return {
    auth,
    role,
    isAuthenticated: auth !== null,
    login,
    logout,
    hasRole: (...roles) => role !== null && roles.includes(role),
  };
}

/**
 * Client-side route guard. Not a security boundary (the API enforces roles); it
 * just sends unauthenticated people to the login page and shows a clear message
 * when a role is not allowed on a route.
 */
import type { ReactNode } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";

import { ROLE_LABELS, useAuth } from "../lib/auth";
import type { Role } from "../lib/types";

export interface RequireRoleProps {
  /** Allowed roles. Omit to allow any authenticated role. */
  roles?: Role[];
  children: ReactNode;
}

export function RequireRole({ roles, children }: RequireRoleProps) {
  const { auth, role } = useAuth();
  const location = useLocation();

  if (!auth || !role) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (roles && !roles.includes(role)) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <h1 className="text-page font-semibold text-foreground">Not available for your role</h1>
        <p className="mt-2 text-muted-foreground">
          You are signed in as <strong>{ROLE_LABELS[role]}</strong>. This page needs:{" "}
          {roles.map((r) => ROLE_LABELS[r]).join(" or ")}.
        </p>
        <p className="mt-6">
          <Link to="/dashboard" className="text-primary underline">
            Back to the dashboard
          </Link>
        </p>
      </div>
    );
  }
  return <>{children}</>;
}

/**
 * Route table, exactly as CONTRACTS.md §4:
 *   /                                   public landing page (pages/landing)
 *   /login                              login / role picker + link to kiosk
 *   /kiosk                              participant flow (no auth)
 *   /dashboard                          queue
 *   /dashboard/checkins/:sessionId      check-in detail
 *   /dashboard/participants/:usubjid    participant timeline
 *   /dashboard/escalations
 *   /dashboard/audit
 *   /dashboard/eval
 *   /dashboard/notes                    chart notes (ingest + list, R2.4)
 *   /dashboard/notes/:noteId            chart note detail
 *   /dashboard/packets/:id              serious-event report packet (R3.2/R3.3)
 *   /dashboard/participants/:usubjid/brief   visit-prep brief (R3.3)
 *   /dashboard/queries                  sponsor queries (R4.4)
 *   /admin                              admin only
 *   /ui-preview                         design-system preview (UI revamp phase 1;
 *                                       synthetic data only, no API calls, no auth)
 *
 * The dashboard shell (components/Layout.tsx) owns the header, command menu, shortcuts and
 * global toasts for every /dashboard and /admin page.
 *
 * `AppRoutes` is router-agnostic so tests can mount it in a MemoryRouter.
 *
 * The three stage-2 pages are code-split and loaded through `import.meta.glob`
 * rather than a plain `import()`: Vite resolves a glob to `{}` when the file
 * does not exist yet, so the shell (and its tests) keep working while those
 * pages are still being written, and the route shows a clear "not available in
 * this build" panel instead of crashing. Once all three files exist this is
 * equivalent to `lazy(() => import("./pages/dashboard/packets/PacketPage"))`.
 */
import { type ComponentType, lazy, type ReactNode, Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";

import { Layout } from "./components/Layout";
import { RequireRole } from "./components/RequireRole";
import { ToastProvider } from "./components/Toast";
import { Admin } from "./pages/Admin";
import { Outbox } from "./pages/admin/Outbox";
import { Audit } from "./pages/dashboard/Audit";
import { CheckInDetail } from "./pages/dashboard/CheckInDetail";
import { Escalations } from "./pages/dashboard/Escalations";
import { Eval } from "./pages/dashboard/Eval";
import { NoteDetail } from "./pages/dashboard/NoteDetail";
import { Notes } from "./pages/dashboard/Notes";
import { ParticipantTimeline } from "./pages/dashboard/ParticipantTimeline";
import { Queue } from "./pages/dashboard/Queue";
import { KioskFlow } from "./pages/kiosk/KioskFlow";
import { LandingPage } from "./pages/landing/LandingPage";
import { Login } from "./pages/Login";
import { NotFound } from "./pages/NotFound";

// ---------------------------------------------------------------------------
// Lazily loaded stage-2 pages
// ---------------------------------------------------------------------------

type PageModule = { default?: ComponentType; [name: string]: unknown };

/** Every candidate module, keyed by path; a missing file is simply absent. */
const STAGE2_PAGES = import.meta.glob<PageModule>([
  "./pages/dashboard/packets/PacketPage.tsx",
  "./pages/dashboard/brief/BriefPage.tsx",
  "./pages/dashboard/queries/QueriesPage.tsx",
]);

/** Shown when a page module is not in this build (or exports no component). */
function PageUnavailable({ name }: { name: string }) {
  return (
    <div
      className="rounded-panel border border-border bg-surface p-6 text-foreground"
      role="status"
    >
      <h1 className="text-page font-semibold text-foreground">{name} is not available yet</h1>
      <p className="mt-1 text-body text-muted-foreground">
        This page is not part of the current build. The rest of the dashboard works as usual.
      </p>
    </div>
  );
}

/**
 * `React.lazy` over the glob: prefers the default export, then a named export
 * matching the file name (e.g. `export function PacketPage`), else the
 * "not available" panel.
 */
function lazyPage(path: string, exportName: string, displayName: string) {
  return lazy(async () => {
    const load = STAGE2_PAGES[path];
    const Fallback = () => <PageUnavailable name={displayName} />;
    if (!load) return { default: Fallback };
    try {
      const mod = await load();
      // Read the named export only when there is no default (a module mock throws
      // on access to an export it does not define).
      const pickNamed = () => {
        const named = mod[exportName];
        return typeof named === "function" ? (named as ComponentType) : undefined;
      };
      const Comp = mod.default ?? pickNamed();
      return { default: Comp ?? Fallback };
    } catch (e) {
      // A page that fails to load must not take the dashboard down; say why in the console.
      console.error(`Could not load ${path}`, e);
      return { default: Fallback };
    }
  });
}

const PacketPage = lazyPage(
  "./pages/dashboard/packets/PacketPage.tsx",
  "PacketPage",
  "The report packet page",
);
const BriefPage = lazyPage(
  "./pages/dashboard/brief/BriefPage.tsx",
  "BriefPage",
  "The visit brief page",
);
/** Design-system preview: code-split so TanStack Table, cmdk and sonner stay out of the main chunk. */
const UiPreview = lazy(() => import("./pages/UiPreview"));

const QueriesPage = lazyPage(
  "./pages/dashboard/queries/QueriesPage.tsx",
  "QueriesPage",
  "The sponsor queries page",
);

/** Suspense boundary with the dashboard's loading look. */
function Lazy({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="px-4 py-12 text-center text-muted-foreground" role="status">
          <span
            aria-hidden="true"
            className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent align-middle"
          />
          Loading page…
        </div>
      }
    >
      {children}
    </Suspense>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<Login />} />
      <Route path="/kiosk" element={<KioskFlow />} />
      <Route
        path="/ui-preview"
        element={
          <Lazy>
            <UiPreview />
          </Lazy>
        }
      />

      <Route
        path="/dashboard"
        element={
          <RequireRole>
            <Layout />
          </RequireRole>
        }
      >
        <Route index element={<Queue />} />
        <Route path="checkins/:sessionId" element={<CheckInDetail />} />
        <Route path="participants/:usubjid" element={<ParticipantTimeline />} />
        <Route
          path="participants/:usubjid/brief"
          element={
            <Lazy>
              <BriefPage />
            </Lazy>
          }
        />
        <Route
          path="packets/:id"
          element={
            <Lazy>
              <PacketPage />
            </Lazy>
          }
        />
        <Route
          path="queries"
          element={
            <Lazy>
              <QueriesPage />
            </Lazy>
          }
        />
        <Route path="escalations" element={<Escalations />} />
        <Route path="audit" element={<Audit />} />
        <Route path="eval" element={<Eval />} />
        <Route path="notes" element={<Notes />} />
        <Route path="notes/:noteId" element={<NoteDetail />} />
      </Route>

      <Route
        path="/admin"
        element={
          <RequireRole roles={["admin"]}>
            <Layout />
          </RequireRole>
        }
      >
        <Route index element={<Admin />} />
        <Route path="outbox" element={<Outbox />} />
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <AppRoutes />
      </ToastProvider>
    </BrowserRouter>
  );
}

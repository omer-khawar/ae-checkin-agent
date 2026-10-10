/**
 * Route table, exactly as CONTRACTS.md §4:
 *   /                                   login / role picker + link to kiosk
 *   /kiosk                              participant flow (no auth)
 *   /dashboard                          queue
 *   /dashboard/checkins/:sessionId      check-in detail
 *   /dashboard/participants/:usubjid    participant timeline
 *   /dashboard/escalations
 *   /dashboard/audit
 *   /dashboard/eval
 *   /dashboard/notes                    chart notes (ingest + list, R2.4)
 *   /dashboard/notes/:noteId            chart note detail
 *   /admin                              admin only
 *
 * `AppRoutes` is router-agnostic so tests can mount it in a MemoryRouter.
 */
import { BrowserRouter, Route, Routes } from "react-router-dom";

import { Layout } from "./components/Layout";
import { RequireRole } from "./components/RequireRole";
import { ToastProvider } from "./components/Toast";
import { Admin } from "./pages/Admin";
import { Audit } from "./pages/dashboard/Audit";
import { CheckInDetail } from "./pages/dashboard/CheckInDetail";
import { Escalations } from "./pages/dashboard/Escalations";
import { Eval } from "./pages/dashboard/Eval";
import { NoteDetail } from "./pages/dashboard/NoteDetail";
import { Notes } from "./pages/dashboard/Notes";
import { ParticipantTimeline } from "./pages/dashboard/ParticipantTimeline";
import { Queue } from "./pages/dashboard/Queue";
import { KioskFlow } from "./pages/kiosk/KioskFlow";
import { Login } from "./pages/Login";
import { NotFound } from "./pages/NotFound";

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Login />} />
      <Route path="/kiosk" element={<KioskFlow />} />

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

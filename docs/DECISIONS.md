# Decisions (ADR-style log)

Format: date, decision, why, consequences. Newest at the bottom.

## 2026-10-10 — D-001: Shared interface contract before parallel build
**Decision:** Write `docs/CONTRACTS.md` pinning rules-package types, API JSON shapes, bridge WS/HTTP messages, persona schema and seed rules before any app code.
**Why:** Five components are built in parallel by independent workers; the brief leaves JSON shapes implicit.
**Consequences:** The contract is the tie-breaker. Changes get logged here.

## 2026-10-10 — D-002: API JSON is snake_case; the vitals POST also accepts camelCase
**Decision:** The API emits snake_case everywhere. `POST /sessions/{id}/vitals` accepts the bridge's camelCase `VitalsSample` (CLAUDE.md §7.1) via Pydantic aliases and stores snake_case.
**Why:** Keeps the bridge contract verbatim from the brief while keeping the API consistent.
**Consequences:** The web app handles camelCase on the WS stream and snake_case from REST; types for both live in `apps/web/src/lib/types.ts`.

## 2026-10-10 — D-003: Bridge enforces timing gates by nulling, not by withholding samples
**Decision:** Before a metric's timing gate elapses, the bridge still emits/persists the sample but sets that metric to `undefined` and adds `gate_pending_<metric>`. Sub-threshold confidence values are kept and flagged `low_conf_<metric>`.
**Why:** "Samples are never averaged away" and the raw series must stay auditable; the rules engine applies the confidence threshold itself.
**Consequences:** The UI hides flagged values; the rules ignore them with a logged reason.

## 2026-10-10 — D-004: Backdating only via admin-authenticated override fields
**Decision:** `POST /sessions` and `POST /sessions/{id}/complete` accept `started_at_override` / `completed_at_override` / `settings_override` only when the caller holds an admin token. Seed and eval use them.
**Why:** Seeded timelines need prior check-ins in the past; eval personas need per-persona `simulated_as_measured` without flipping the global setting under a live kiosk.
**Consequences:** Documented in README as demo-only; every override is an audit event.

## 2026-10-10 — D-005: Eval replays explicit vitals samples, not the bridge
**Decision:** Personas carry an explicit `vitals_samples[]` list (deterministic) plus an informational `vitals_scenario` name for live demos.
**Why:** Determinism; `make eval` must be 100% reproducible without a running bridge.
**Consequences:** The mock bridge scenarios and the persona samples describe the same physiology but are separate data.

## 2026-10-10 — D-006: Light theme only; same-origin API via proxy
**Decision:** Kiosk and dashboard are light, high-contrast. The web app calls `/api/v1` relative; Vite proxies in dev, nginx in Docker.
**Why:** CLAUDE.md §14 recommendation; one fewer env var to get wrong on a cold-start laptop.

## 2026-10-10 — D-007: SQLite in a Docker volume; Postgres via `DATABASE_URL`
**Decision:** Compose uses SQLite in a named volume. Postgres is a one-line env change, documented but not run in compose.
**Why:** Zero extra services on the demo laptop.

## 2026-10-10 — D-008: VS exports are per-summary by default, per-sample on request
**Decision:** `GET /export/VS.csv` emits one row per metric summary per session; `?per_sample=true` and the bundle's `VS_samples.csv` give the raw series.
**Why:** Matches what a data manager expects to see in VS while keeping the raw eSource series exportable.

## 2026-10-10 — D-009: Root `package.json` mirrors the Makefile
**Decision:** `npm run dev|test|eval|seed` work on Windows without `make`.
**Why:** The build machine is Windows; judges' laptops may be too.

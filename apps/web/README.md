# apps/web — Interim web app

React 18 + Vite 5 + TypeScript 5.8 + Tailwind 3.4 + React Router 6 + Recharts, built as one SPA with
two faces:

- **Kiosk** (`/kiosk`): the participant's between-visit check-in. No login. Large type, one question
  per screen, calm vitals card, never shows a grade or a tier.
- **Dashboard** (`/dashboard/*`, `/admin`): coordinator / investigator / admin views. Login at `/`.

This wave ships the scaffold, the shared library, login, and the complete kiosk flow. Dashboard pages
are stubs with their routes wired; a later wave replaces only `src/pages/dashboard/*.tsx` and
`src/pages/Admin.tsx`.

## Run

```bash
npm install
npm run dev          # http://localhost:5173  (proxies /api → http://localhost:8000)
npm run build        # dist/
npm run preview
npm run lint         # eslint, zero warnings allowed
npm run typecheck    # tsc --noEmit
npm test             # vitest (jsdom)
```

Environment: `VITE_BRIDGE_WS_URL` (default `ws://<hostname>:8787`). Nothing else; the API is always
reached at the relative `/api/v1` (Vite proxy in dev, `nginx.conf` in Docker).

Kiosk query param: `/kiosk?scenario=post_exercise` makes the bridge use that mock scenario for the
session (CLAUDE.md §7.2).

## Layout

```
src/
├── App.tsx                 route table (CONTRACTS.md §4); AppRoutes is router-agnostic for tests
├── main.tsx
├── lib/
│   ├── types.ts            TS mirrors of CONTRACTS.md §2 (API, snake_case) and §3.3 (bridge, camelCase)
│   ├── api.ts              the one typed client: one function per endpoint, ApiError (RFC 7807), pagination
│   ├── auth.ts             sessionStorage token store + useAuth()
│   ├── bridge.ts           BridgeClient (reconnect/backoff, start re-send, post-flush idle) + useBridge() (captureLost)
│   ├── format.tsx          <Time/> (local, UTC on hover), TIERS table, MEASURED/SIMULATED helpers, item prompts,
│   │                       recall line, table-driven temperature field + validation
│   ├── gates.ts            gate state, gatePrompts() from the gate table, buildGatesBody() (verbatim text)
│   ├── answers.ts          per-(item, attribute) answer keys and the "not yet acknowledged" diff
│   ├── participant.ts      resolveUsubjid(): "{study_id}-{label}" with the bare label as 404 fallback
│   └── vitals.ts           metricReady / metricSlot / signalQuality (pure display gating)
├── components/             Layout, Disclaimer, RequireRole, Button, Card, ProgressBar, TierChip,
│                           MeasuredBadge, Pagination, Toast, ErrorBanner, VitalsPanel
├── pages/
│   ├── Login.tsx           three role buttons + demo password
│   ├── kiosk/              KioskFlow (state machine) + one file per screen
│   ├── dashboard/          Queue, CheckInDetail, ParticipantTimeline, Escalations, Audit, Eval (stubs)
│   └── Admin.tsx           stub
├── styles/                 index.css + README.md (palette)
└── test/                   vitest suites, fake WebSocket, route-table fetch mock, fixtures
```

## Kiosk flow and API calls

| Screen           | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Welcome          | `GET /study`, `GET /items`. The participant types the label printed on their card ("P-007"); it is trimmed and upper-cased.                                                                                                                                                                                                                                                                                                                                                                                                     |
| Consent          | `POST /sessions {usubjid, consent_camera}` with `usubjid = "{study_id}-{label}"` (CONTRACTS.md §5). If that is a 404 the kiosk retries once with the bare label, so an API that resolves display labels works too (`lib/participant.ts`). Yes → `{type:"start", sessionId}` to the bridge. A final 404/422 sends the participant back to Welcome with a plain message.                                                                                                                                                          |
| Items            | One item per screen; the heading is the table's `label`, each attribute's question is `prompts.<attribute>`. Every tap `POST /sessions/{id}/answers {item_id, attribute, value, ts_client}` immediately (idempotent on the API). Failures are tracked **per (item, attribute)**; "Try again" resends every failed one, and Next is disabled until every attribute is acknowledged. Back allowed. `fever_or_chills` = Yes reveals the temperature box described by the table's `optional_fields` (label, unit, 34–43 °C bounds). |
| Gates            | Hospitalization (yes/no) → medication (yes/no, name **verbatim, whitespace included**, started/stopped/both) → anything else (textarea, verbatim). One `POST /sessions/{id}/gates` after the third screen. `temp_c` is sent only when fever = Yes **and** the value is inside the table's bounds; switching fever back to No clears it.                                                                                                                                                                                         |
| Submitting       | Any answer the API never acknowledged is resent first. Then `{type:"stop"}` to the bridge and wait for its **post-flush** `status: idle` (`sessionId: null`) or 2.5 s, then `POST /sessions/{id}/complete {ts_client}`. The source's own halt also broadcasts idle but still carries the session id; that one is ignored so the last vitals batch is on the server before the rules run.                                                                                                                                        |
| Thank-you / Stop | `stop_screen: false` → next-steps text. `stop_screen: true` → the API's `stop_screen_text` verbatim and nothing else. Both return to Welcome on Done (or after 45 s / 90 s).                                                                                                                                                                                                                                                                                                                                                    |

### Vitals card

- A metric shows its number only when the bridge's `published` flag is true **and** the confidence
  is ≥ the threshold (bridge `hello.minConf`, default 0.6) **and** no `low_conf_<metric>` flag is set.
  Otherwise the slot says "collecting…", or "not available" once that metric's timing gate has elapsed
  and the source has no value for it (a source without HRV, the `low_quality` mock scenario).
- The header dot is judged only from **published** metrics: during the timing gate the bridge strips
  confidences, so the first 12 s read "Collecting", never "Signal is weak". A degraded-capture flag
  (`face_not_found`, `low_light`, `motion`, `talking`) reads "Signal is weak" at any time.
- It always carries the MEASURED / SIMULATED word and the source name.
- "Vitals unavailable, continuing without them" when the socket is down, the source reports `error`,
  the bridge is idle with no session to capture, or the bridge is up but has not been capturing this
  kiosk's session for more than `START_GRACE_MS` (4 s). The bridge client re-sends `start` for the
  active session on every socket `open`, so a bridge restart mid-check-in re-attaches the session.
- The card is hidden from the Submitting screen onward (capture has been stopped by then).

### Decisions recorded here (for `docs/DECISIONS.md`)

These were made while fixing the web review findings; the web component owns only `apps/web/**`,
so they are logged here for the integrator to copy into the ADR log.

- **W-1 USUBJID composition on the kiosk.** The participant types the card label; the kiosk sends
  `"{study_id}-{label}"` first and retries with the bare label on 404. CONTRACTS §2.1 should say that
  `POST /sessions` accepts a full `usubjid`; accepting a `display_label` as well is optional.
- **W-2 Flush handshake.** "Give the bridge ≤ 2.5 s to flush" (CONTRACTS §4) is implemented as
  "wait for `status.state == "idle" && sessionId == null`", which is the bridge's post-flush broadcast.
  The bridge must keep broadcasting that final status after `api.stopBatching()` resolves.
- **W-3 GET /items shape.** The web reads the rules tables' own field names (`prompts.<attr>`,
  `optional_fields[]`, gate `text_prompt` / `direction_prompt` / `note`) and keeps the earlier
  `attribute_prompts` / `optional_numeric` / `prompts.{conmed_text,…}` names as optional aliases.
  The API should pass the table rows through unchanged. The gate table's `text_note` is documentation,
  not participant copy, and is not rendered on the kiosk.
- **W-4 Verbatim text.** `conmed_text` and `other_text` are sent byte-for-byte as typed; `trim()` is
  used only to decide emptiness. Normalisation is the rules matcher's job (CONTRACTS §1.7).
- **W-5 Temperature bounds.** Client-side plausibility bounds for the typed temperature come from
  `optional_fields[].min/max` in `proctcae_items.json` (34–43 °C). Out-of-range input blocks Next
  with a message rather than being silently dropped; the value is never sent when fever = No.

## Auth model (demo)

`POST /auth/login {username: <role>, password}` → token kept in `sessionStorage` under `interim.auth`.
`RequireRole` gates routes client-side; the API enforces roles server-side on every mutating endpoint.
Production would need SSO and per-user audit identity.

## Tests

`npm test` runs: kiosk end-to-end (mocked fetch + fake bridge socket: composed USUBJID and 404
fallback, answer bodies, per-attribute failure retry, verbatim gates body, temperature clearing and
bounds, table wording, pre-flush vs post-flush idle before `/complete`, start re-sent on reconnect,
stop screen, unknown ID), VitalsPanel gating / quality / unavailable states, bridge message parsing /
reconnect / flush predicate / capture-lost hook, pure kiosk helpers (`kioskLib.test.ts`), API
problem+json parsing and pagination, and TierChip / MeasuredBadge / Time rendering.

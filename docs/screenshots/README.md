# Interim screenshots (2026-10-10, work in progress)

Captured from the real API (seeded synthetic data) and the current web app, for a UI redesign pass. Dashboard shots are 1440px wide, kiosk shots 1280px, all full-page. Every participant is synthetic.

## How to read these

The web app is React + Vite + Tailwind under `apps/web`. Each dashboard page lives in its own folder under `apps/web/src/pages/dashboard/<page>/`, with shared pieces in `apps/web/src/components` and the typed API client in `apps/web/src/lib`. A redesign can restyle freely, but a few things are judging requirements and must survive:

- **The not-a-medical-device footer** appears on every page, word for word.
- **MEASURED or SIMULATED** appears next to every vitals value, always as a visible word, not only a color.
- **Every derived value is clickable to its evidence.** On the check-in detail page, clicking a draft field highlights the answers, vitals samples, and rules behind it.
- **The kiosk never shows grades, tiers, or clinical language** to the participant.
- **Tier names stay explicit:** Log, Review within 1 business day, Nurse call today, Urgent.

## Kiosk (participant)

| File | Screen |
|---|---|
| `20-kiosk-welcome.png` | Welcome and study ID entry |
| `21-kiosk-consent.png` | Camera consent, Yes or No |
| `22-kiosk-question-with-vitals.png` | One symptom question with the vitals card collecting pulse and breathing (SIMULATED mock source) |
| `23-kiosk-after-items.png` | State after the 10 symptom items |

The Tier 3 stop screen and the thank-you screen were not captured.

## Dashboard (coordinator / investigator)

| File | Page |
|---|---|
| `01-login.png` | Role login |
| `02-dashboard-queue.png` | Queue: check-ins and chart notes sorted by tier, SAE countdown chips, draft counts |
| `03-checkin-detail.png` | Check-in detail: answers (left), SDTM drafts AE/VS/CM (middle), Why panel with every rule fired (right), investigator attribution |
| `04-checkin-detail-evidence-click.png` | Same page after clicking a draft field: its evidence is highlighted |
| `06-participant-timeline.png` | Participant timeline: symptom sparklines, vitals over time, open AEs, con-med changes, notes |
| `07-escalations.png` | Escalations, SAE clocks, mock pager log |
| `08-audit.png` | Hash-chained audit log |
| `09-audit-verified.png` | Audit after "Verify chain" |
| `10-eval.png` | Eval page with the build-your-own-persona form |
| `11-eval-results.png` | Eval after running the shipped personas |
| `12-notes.png` | Chart-note ingest and dry-run scan |
| `13-note-detail.png` | One ingested note with highlighted findings and drafts |
| `14-admin.png` | Admin: vitals source, mock scenario, simulated-as-measured toggle, demo reset |

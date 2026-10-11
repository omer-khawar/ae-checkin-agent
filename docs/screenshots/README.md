# Interim screenshots

## Current: `v2/` (2026-10-11, from the running stack)

Captured from the live API and web app during the browser walkthrough, 1440 px wide, full page. Every participant is synthetic; a few P-007 check-ins in the queue were added by the walkthrough itself. The kiosk no longer has a per-session consent screen (D-026).

| File | Screen (demo step) |
|---|---|
| `hero-queue.png` | Top of the queue, used as the README hero (crop of `intake-03-dashboard-queue.png`) |
| `intake-01-kiosk-welcome.png`, `intake-01-kiosk-diarrhea.png`, `intake-01-kiosk-conmed.png`, `intake-02-kiosk-thankyou.png` | Kiosk: welcome, one symptom question, the medication question, thank-you (step 1) |
| `intake-02-notes-log-call.png` | Notes page with "Log a call" (step 2) |
| `intake-03-dashboard-queue.png` | Queue: "Since you were last here", tiers, SAE/AESI clocks, time-saved strip (step 3) |
| `intake-04-detail-evidence.png`, `intake-04-detail-confirmed.png` | Check-in detail: a field's evidence highlighted; records confirmed (step 4) |
| `reporting-01..03-packet-sae-*.png` | SAE report packet: review, signed, follow-up (steps 5–6) |
| `reporting-04..06-packet-aesi-*.png` | AESI report packet: review, signed, follow-up (steps 5–6) |
| `reporting-07-attribution.png`, `reporting-08-escalations-decision.png` | Investigator attribution; "Record seriousness decision" (step 6) |
| `followthrough-01..04-queries-*.png` | Sponsor queries: open, answered, raised, closed (step 7) |
| `followthrough-05-brief.png`, `followthrough-06-brief-print.png` | Visit brief and its printable page (step 8) |
| `followthrough-07-audit-verified.png`, `followthrough-08-eval.png`, `followthrough-09-admin.png`, `followthrough-10-timeline.png` | Audit verified, Eval, Admin, participant timeline |

To recapture after the final seed: `docker compose down -v && docker compose up --build`, then follow `docs/DEMO.md` and save over these names (ISSUES #7).

## Superseded: top-level files (2026-10-10, before stage 2)

Kept for the redesign history only. They predate the packet, brief, query, call and time-saved screens, and `21-kiosk-consent.png` shows a screen that has since been removed.

Captured from the real API (seeded synthetic data) and the current web app, for a UI redesign pass. Dashboard shots are 1440px wide, kiosk shots 1280px, all full-page. Every participant is synthetic.

### How to read these

The web app is React + Vite + Tailwind under `apps/web`. Each dashboard page lives in its own folder under `apps/web/src/pages/dashboard/<page>/`, with shared pieces in `apps/web/src/components` and the typed API client in `apps/web/src/lib`. A redesign can restyle freely, but a few things are judging requirements and must survive:

- **The not-a-medical-device footer** appears on every page, word for word.
- **MEASURED or SIMULATED** appears next to every vitals value, always as a visible word, not only a color.
- **Every derived value is clickable to its evidence.** On the check-in detail page, clicking a draft field highlights the answers, vitals samples, and rules behind it.
- **The kiosk never shows grades, tiers, or clinical language** to the participant.
- **Tier names stay explicit:** Log, Review within 1 business day, Nurse call today, Urgent.

### Kiosk (participant)

| File | Screen |
|---|---|
| `20-kiosk-welcome.png` | Welcome and study ID entry |
| `21-kiosk-consent.png` | Camera consent, Yes or No |
| `22-kiosk-question-with-vitals.png` | One symptom question with the vitals card collecting pulse and breathing (SIMULATED mock source) |
| `23-kiosk-after-items.png` | State after the 10 symptom items |

The Tier 3 stop screen and the thank-you screen were not captured.

### Dashboard (coordinator / investigator)

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

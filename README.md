# PSV Dashboard

Dynamic dashboard for GoComet's Product Solutions team, sourced live from the Jira **PSV** ("Projects Status Visibility") board. No mock or external data — everything is pulled directly from Jira via the REST API.

## Features

- **Overview** — total deal count, clickable KPI segments (Active/Won/Cold/Churn/Stuck) and status blocks, PSE workload and module-interest charts, day-over-day trend charts (total deals, total MRR) once 2+ days of history exist.
- **Status / segment drill-down** — full card list for any status or KPI segment, respecting active filters, with CSV export.
- **Card detail modal** — every relevant Jira field (KAM, modules, shipment volume, expected closure dates, priority, MRR, etc.) plus that card's full activity timeline.
- **MRR tab** — total MRR summed from Jira's `MRR (USD)` field (values of blank/0/1 are treated as "not filled in" and excluded), a per-PSE MRR chart, and a per-PSE breakdown of every deal still missing a real MRR value.
- **Closing Soon tab** — every deal whose Expected Sales Closure date falls in the next 30 days, sorted soonest-first, with MRR at stake.
- **Team Performance tab** — per-PSE win rate / churn rate, a stacked portfolio-by-stage chart, and a full status × PSE matrix.
- **Board Activity Log** — every field-level change across all PSV cards, most recent first, searchable.
- **Filters** (landing page, persist across views): PSE (assignee), Status, List of Modules, and TAT bucket.
- **TAT tracking** — computed from Jira's changelog: starts when a card transitions `Upcoming → Req. Gathering`, ends at `Solutions Draft Shared`.
- **Live updates** — the server polls Jira every 5 minutes and the page auto-refreshes every 60 seconds, so Jira edits show up here automatically without a manual reload.
- **Daily history snapshots** — every refresh (the 5-min poller and the daily scheduled task) appends/overwrites today's totals to `public/data/history.json`, powering the Overview trend charts. No extra setup needed — it rides on the same automation as everything else.

## Setup

1. `npm install`
2. `.env` already contains your Jira credentials (not committed to git).
3. `npm start` — launches the API/dashboard server at http://localhost:3000. On startup it does a full refresh, then polls Jira every 5 minutes in the background for as long as it's running.

`npm run fetch-data` still works as a one-shot CLI refresh (used by the scheduled task below), independent of the running server.

## Auto-refresh when the server isn't running (daily, 7:00 AM IST)

A Windows Scheduled Task **"PSV Dashboard Refresh"** is already registered — it runs `node scripts/fetch-jira-data.js` daily at 7:00 AM IST as a baseline refresh in case `npm start` isn't currently running. If you keep the server running continuously, this task is redundant but harmless (it just does one extra refresh).

- Check: `Get-ScheduledTask -TaskName "PSV Dashboard Refresh"`
- Remove: `Unregister-ScheduledTask -TaskName "PSV Dashboard Refresh" -Confirm:$false`

## Data model

`lib/jira.js` is the single source of truth for talking to Jira: it fetches all PSV issues, reuses cached changelogs when an issue's `updated` timestamp hasn't changed (so refreshes stay cheap), and computes each card's TAT. Both `server.js` (live polling) and `scripts/fetch-jira-data.js` (one-shot) use it.

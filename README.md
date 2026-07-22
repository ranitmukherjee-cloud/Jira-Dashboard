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

## Deploying to Vercel

Vercel runs serverless functions, not a long-lived process — so the 5-minute background poller and local JSON file storage from the self-hosted setup above don't carry over as-is. The `/api` folder and `vercel.json` in this repo adapt the same `lib/jira.js` logic to that model:

- **`api/data.js`, `api/history.js`** — read the current cached data (GET), used by the frontend exactly like the self-hosted server's `/api/data` and `/api/history`.
- **`api/refresh.js`** — on-demand full refresh (POST), wired to the dashboard's "Refresh now" button.
- **`api/cron/refresh.js`** — the same refresh, triggered automatically once a day by Vercel Cron (`vercel.json` schedules it for `30 1 * * *` UTC = 7:00 AM IST).
- **`lib/store.js`** — swaps the storage backend: local JSON files here (unchanged), Upstash Redis on Vercel (required there, since the serverless filesystem doesn't persist between requests).

**Important trade-off:** Vercel Cron on the Hobby plan only runs jobs once a day. That gives you the daily 7 AM refresh, but not the 5-minute "live" feel from the self-hosted setup — data updates whenever someone clicks "Refresh now," or once a day automatically. Vercel Pro allows more frequent cron schedules if closer-to-live matters enough to upgrade.

### One-time setup in the Vercel dashboard

1. **Storage → Create Database → Redis** (Upstash, via Vercel Marketplace) and connect it to this project. This injects `KV_REST_API_URL` / `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`, both are handled) as environment variables automatically.
2. **Settings → Environment Variables** — add for Production (and Preview, if you want preview deploys to work too):
   - `JIRA_DOMAIN` = `gocomet.atlassian.net`
   - `JIRA_EMAIL` = your Jira email
   - `JIRA_API_TOKEN` = your Jira API token
   - `JIRA_PROJECT_KEY` = `PSV`
   - `CRON_SECRET` = any random string (protects `/api/cron/refresh` from being called by anyone who finds the URL)
3. **Push this repo to GitHub** (`git push -u origin main`) and connect it in the Vercel project if not already linked — that resolves the "No Production Deployment" state, since Vercel builds from `main` on push.
4. After the first deploy, trigger one manual refresh (call `POST /api/refresh`, or use the dashboard's "Refresh now" button) so real data is in Redis before the next scheduled cron run.

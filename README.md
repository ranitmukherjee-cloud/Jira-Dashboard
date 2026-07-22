# PSV Dashboard

Dynamic dashboard for GoComet's Product Solutions team, sourced live from the Jira **PSV** ("Projects Status Visibility") board. No mock or external data, no database, no cron — every request pulls straight from the Jira REST API.

## Features

- **Overview** — total deal count, clickable KPI segments (Active/Won/Cold/Churn/Stuck) and status blocks, PSE workload and module-interest charts.
- **Status / segment drill-down** — full card list for any status or KPI segment, respecting active filters, with CSV export.
- **Card detail modal** — every relevant Jira field (KAM, modules, shipment volume, expected closure dates, priority, MRR, etc.) plus that card's activity timeline.
- **MRR tab** — total MRR summed from Jira's `MRR (USD)` field (values of blank/0/1 are treated as "not filled in" and excluded), a per-PSE MRR chart, and a per-PSE breakdown of every deal still missing a real MRR value.
- **Closing Soon tab** — every deal whose Expected Sales Closure date falls in the next 30 days, sorted soonest-first, with MRR at stake.
- **TAT tab** — per-PSE deal-wise turnaround time and averages, with severity flags (Great ≤15d · Mid ≤30d · Watch ≤60d · Flagged >60d).
- **Team Performance tab** — per-PSE win rate / churn rate, a stacked portfolio-by-stage chart, and a full status × PSE matrix.
- **Board Activity Log** — field-level changes across PSV cards, most recent first, searchable.
- **Filters** (landing page, persist across views): PSE (assignee), Status, List of Modules, and TAT bucket.
- **TAT tracking** — computed from Jira's changelog: starts when a card transitions `Upcoming → Req. Gathering`, ends at `Solutions Draft Shared`.
- **Live** — data is pulled fresh from Jira on load (short in-memory cache only), the page auto-refreshes every 60 seconds, and "Refresh now" forces an immediate pull.

## How the live fetch works

`lib/jira.js` `fetchLive()` pulls the whole board in one paginated bulk search with the changelog expanded inline (~5 API calls). The inline changelog is capped at the 40 most-recent entries per issue, which drops the oldest transitions — exactly the ones TAT needs — so for the few dozen cards whose changelog was truncated it fetches the full changelog individually (concurrency-limited). A complete live pull is well under 10 seconds.

`lib/live.js` wraps that in a short in-memory cache (`LIVE_TTL_MS`, default 30s) so bursts of requests, the 60s frontend poll, and multiple viewers don't each trigger a separate Jira pull. "Refresh now" bypasses the cache.

There is **no database and no scheduled job** — nothing to provision, nothing to keep in sync. The trade-off is that day-over-day trend charts (which would need persisted daily snapshots) are not available.

## Run locally

1. `npm install`
2. Create `.env` (see `.env.example`) with your Jira credentials.
3. `npm start` — serves the dashboard and live API at http://localhost:3000.

## Deploy to Vercel

The `/api` folder and `vercel.json` expose the same live API as serverless functions — no storage or cron needed.

- **`api/data.js`** (GET) — live board data.
- **`api/refresh.js`** (POST) — forced fresh pull, wired to "Refresh now".
- **`api/history.js`** (GET) — returns `[]` (trends need persistence this design doesn't have; the frontend hides them).

### One-time setup in the Vercel dashboard

**Settings → Environment Variables**, add for Production (and Preview if you want preview deploys to work):

- `JIRA_DOMAIN` = `gocomet.atlassian.net`
- `JIRA_EMAIL` = your Jira email
- `JIRA_API_TOKEN` = your Jira API token
- `JIRA_PROJECT_KEY` = `PSV`

Then push to `main` (Vercel builds on push). No database, no cron, no `CRON_SECRET` — just the four Jira variables above.

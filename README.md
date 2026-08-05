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

## Fireflies meeting sync

`api/fireflies-webhook.js` (and the matching `/api/fireflies-webhook` route in `server.js`) auto-posts a meeting's Fireflies summary onto the PSV card the meeting was for, whenever Fireflies finishes transcribing a call. The full transcript is uploaded as a file attachment on the issue (named e.g. `PSV-1234 - Sync with Acme on 05-08-2026.txt`) rather than pasted into a comment, and the summary comment links to it — so a card with many calls gets one short comment per call instead of a wall of transcript text.

**How a meeting is matched to a card:** by the PSV issue key appearing in the meeting title — e.g. a calendar event / Fireflies meeting named `PSV-1234 — Sync with Acme` gets its summary comment (and transcript attachment) posted to `PSV-1234`. Meetings whose title has no PSV key are queued for retry (see below), not dropped. This means whoever schedules the call needs to put the card key in the meeting title.

**One-time setup:**

1. **Fireflies API key** — in the Fireflies web app, go to Integrations → Fireflies API and generate a key (requires API access on your Fireflies plan). Set it as `FIREFLIES_API_KEY`.
2. **Webhook secret** — pick any random 16–32 character string yourself. Set it as `FIREFLIES_WEBHOOK_SECRET` in this app's env vars, *and* in Fireflies' webhook settings (step 3) — both sides must have the same value, it's used to verify the webhook really came from Fireflies.
3. **Register the webhook** — in Fireflies, go to Settings → Developer Settings, and set the webhook URL to `https://<your-deployed-domain>/api/fireflies-webhook`, with the secret from step 2.
4. Add both env vars (`FIREFLIES_API_KEY`, `FIREFLIES_WEBHOOK_SECRET`) to `.env` for local dev, and to the Vercel project's environment variables for production.

**Notes:**
- The webhook is intentionally excluded from the dashboard's session-cookie login gate (see `middleware.js` / `server.js`) since it's a server-to-server call from Fireflies, authenticated by the HMAC signature instead.
- Retried/duplicate webhook deliveries are handled by checking for an existing comment tagged with the same Fireflies meeting id before posting again. If the attachment upload succeeds but the comment post then fails, a retry re-uploads the transcript rather than reusing the first upload — a harmless duplicate attachment in that rare case, not a duplicate comment.
- If the transcript attachment upload fails for any reason, the summary comment still posts (without a transcript link) rather than losing the summary too.
- **No PSV key in the title yet?** It's queued (`lib/firefliesStore.js`, Redis/local-file backed like the Task Tracker) instead of dropped. `api/cron/fireflies-retry.js` rechecks every queued meeting's *current* title — Fireflies has no "title changed" webhook, so this is what catches someone adding the key to the title after the fact. Anything still unmatched after 48h is dropped from the queue; from there it's manual copy-paste into the Jira comment box, same as any meeting that never gets a key at all.
- **Vercel Cron note:** the Hobby plan only allows cron jobs to run once a day (`vercel.json` defaults to `0 3 * * *`, 3am UTC), so a late title-rename might take up to a day to get picked up. If you're on a Pro plan, tighten that schedule (e.g. hourly, `0 * * * *`) for faster pickup — the 48h queue window comfortably supports it either way. Running `server.js` locally isn't subject to this limit at all; it re-checks the queue hourly on its own via `setInterval`.
- Set `CRON_SECRET` (any random string) so `api/cron/fireflies-retry` only responds to Vercel's own scheduler, not a public GET request.

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

const { getConfig } = require('../../lib/jira');
const { retryPendingMeetings } = require('../../lib/fireflies');

// Vercel Cron target (see vercel.json "crons"). Fireflies has no "title
// changed" webhook event, so this is how a meeting whose title got the PSV
// key added *after* transcription completed still gets picked up — see
// lib/fireflies.js retryPendingMeetings and the README "Fireflies meeting
// sync" section.
module.exports = async (req, res) => {
  // Vercel sends this bearer token automatically when it invokes a cron job,
  // if CRON_SECRET is set — without it, this would be a public GET endpoint
  // anyone could hit to trigger extra Jira writes.
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const apiKey = process.env.FIREFLIES_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'FIREFLIES_API_KEY not configured' });
    return;
  }

  try {
    const jiraCfg = getConfig();
    const result = await retryPendingMeetings({ jiraCfg, projectKey: jiraCfg.projectKey, apiKey });
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('Fireflies retry cron failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
};

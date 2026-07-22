const { runRefresh } = require('../../lib/refresh');

// Called automatically by Vercel Cron once a day (see vercel.json). Vercel sends
// `Authorization: Bearer <CRON_SECRET>` on cron-triggered requests when the
// CRON_SECRET env var is set on the project — verify it so this endpoint can't
// be triggered by anyone who finds the URL.
module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }
  try {
    const result = await runRefresh();
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('Cron refresh failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
};

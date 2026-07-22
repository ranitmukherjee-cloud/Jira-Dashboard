const { runRefresh } = require('../lib/refresh');

// Manual on-demand refresh, triggered by the dashboard's "Refresh now" button.
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Use POST' });
    return;
  }
  try {
    const result = await runRefresh();
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('Manual refresh failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
};

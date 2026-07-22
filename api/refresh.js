const { getLiveData } = require('../lib/live');

// Forced fresh pull, triggered by the dashboard's "Refresh now" button.
// Returns the full dataset so the caller can use it directly.
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Use POST' });
    return;
  }
  try {
    const data = await getLiveData({ force: true });
    res.status(200).json({ ok: true, generatedAt: data.generatedAt, count: data.count });
  } catch (err) {
    console.error('Manual refresh failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
};

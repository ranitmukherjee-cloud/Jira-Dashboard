const { getLiveData } = require('../lib/live');

// Live board data, pulled straight from Jira (short in-memory cache only).
module.exports = async (req, res) => {
  try {
    const { allCards, ...data } = await getLiveData(); // strip allCards (Update Check tab only)
    res.status(200).json(data);
  } catch (err) {
    console.error('Live data fetch failed:', err);
    res.status(500).json({ generatedAt: null, count: 0, issues: [], error: err.message });
  }
};

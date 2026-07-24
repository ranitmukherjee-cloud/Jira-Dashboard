const { getLiveData } = require('../lib/live');
const { UPDATE_CHECK_STATUSES } = require('../lib/jira');

// Field-completeness view: the full assigned card set filtered to the 10
// lifecycle statuses the sanity check covers (incl. won/churn/check-in, which
// the main dashboard hides). Read-only — edits happen natively in Jira.
module.exports = async (req, res) => {
  try {
    const { allCards, generatedAt } = await getLiveData();
    const cards = (allCards || []).filter((c) => UPDATE_CHECK_STATUSES.includes(c.status));
    res.status(200).json({ generatedAt, count: cards.length, cards });
  } catch (err) {
    console.error('Update Check fetch failed:', err);
    res.status(500).json({ generatedAt: null, count: 0, cards: [], error: err.message });
  }
};

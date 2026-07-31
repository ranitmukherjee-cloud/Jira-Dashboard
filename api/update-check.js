const { getLiveData } = require('../lib/live');
const { UPDATE_CHECK_STATUSES, WON_STATUSES } = require('../lib/jira');

// Serves status-filtered slices of the full assigned card set (which includes
// won/churn/check-in cards the main dashboard hides):
//   default    -> the 10 lifecycle statuses the field-completeness check covers
//   ?set=won   -> the won/closed statuses for the wins tab
// Both live in one function because the Vercel Hobby plan caps us at 12.
// Read-only — edits happen natively in Jira.
module.exports = async (req, res) => {
  try {
    const { allCards, generatedAt } = await getLiveData();
    const statuses = req.query.set === 'won' ? WON_STATUSES : UPDATE_CHECK_STATUSES;
    const cards = (allCards || []).filter((c) => statuses.includes(c.status));
    res.status(200).json({ generatedAt, count: cards.length, cards });
  } catch (err) {
    console.error('Update Check fetch failed:', err);
    res.status(500).json({ generatedAt: null, count: 0, cards: [], error: err.message });
  }
};

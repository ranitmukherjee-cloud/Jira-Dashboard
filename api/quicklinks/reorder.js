const { reorderLinks } = require('../../lib/quickLinks');

// Persists a drag-and-drop reorder within one group. Body: { group, ids: [...] }
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }
  try {
    const { group, ids } = req.body || {};
    if (!group || !Array.isArray(ids)) throw new Error('group and ids[] are required');
    const links = await reorderLinks(group, ids);
    res.status(200).json(links);
  } catch (err) {
    console.error('Quick Links reorder error:', err);
    res.status(400).json({ error: err.message });
  }
};

const { renameGroup, deleteGroup } = require('../../../lib/quickLinks');

module.exports = async (req, res) => {
  const name = decodeURIComponent(req.query.name);
  try {
    if (req.method === 'PATCH' || req.method === 'PUT') {
      const groups = await renameGroup(name, (req.body || {}).name);
      res.status(200).json(groups);
      return;
    }
    if (req.method === 'DELETE') {
      res.status(200).json(await deleteGroup(name));
      return;
    }
    res.status(405).json({ error: 'Use PATCH or DELETE' });
  } catch (err) {
    console.error('Quick Links group API error:', err);
    res.status(400).json({ error: err.message });
  }
};

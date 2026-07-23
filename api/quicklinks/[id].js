const { updateLink, deleteLink } = require('../../lib/quickLinks');

module.exports = async (req, res) => {
  const { id } = req.query;
  try {
    if (req.method === 'PATCH' || req.method === 'PUT') {
      res.status(200).json(await updateLink(id, req.body || {}));
      return;
    }
    if (req.method === 'DELETE') {
      res.status(200).json(await deleteLink(id));
      return;
    }
    res.status(405).json({ error: 'Use PATCH or DELETE' });
  } catch (err) {
    console.error('Quick Links API error:', err);
    res.status(400).json({ error: err.message });
  }
};

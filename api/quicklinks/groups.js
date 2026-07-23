const { listGroups, createGroup } = require('../../lib/quickLinks');

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      res.status(200).json(await listGroups());
      return;
    }
    if (req.method === 'POST') {
      const groups = await createGroup((req.body || {}).name);
      res.status(201).json(groups);
      return;
    }
    res.status(405).json({ error: 'Use GET or POST' });
  } catch (err) {
    console.error('Quick Links groups API error:', err);
    res.status(400).json({ error: err.message });
  }
};

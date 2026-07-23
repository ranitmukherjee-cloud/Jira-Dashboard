const { listLinks, addLink } = require('../../lib/quickLinks');

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      res.status(200).json(await listLinks());
      return;
    }
    if (req.method === 'POST') {
      const link = await addLink(req.body || {});
      res.status(201).json(link);
      return;
    }
    res.status(405).json({ error: 'Use GET or POST' });
  } catch (err) {
    console.error('Quick Links API error:', err);
    res.status(400).json({ error: err.message });
  }
};

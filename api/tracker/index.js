const { listTasks, createTask } = require('../../lib/tracker');

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      res.status(200).json(await listTasks());
      return;
    }
    if (req.method === 'POST') {
      const task = await createTask(req.body || {});
      res.status(201).json(task);
      return;
    }
    res.status(405).json({ error: 'Use GET or POST' });
  } catch (err) {
    console.error('Tracker API error:', err);
    res.status(400).json({ error: err.message });
  }
};

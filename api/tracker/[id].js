const { updateTask, deleteTask } = require('../../lib/tracker');

module.exports = async (req, res) => {
  const { id } = req.query;
  try {
    if (req.method === 'PUT' || req.method === 'PATCH') {
      const task = await updateTask(id, req.body || {});
      res.status(200).json(task);
      return;
    }
    if (req.method === 'DELETE') {
      const result = await deleteTask(id);
      res.status(200).json(result);
      return;
    }
    res.status(405).json({ error: 'Use PUT/PATCH or DELETE' });
  } catch (err) {
    console.error('Tracker API error:', err);
    res.status(400).json({ error: err.message });
  }
};

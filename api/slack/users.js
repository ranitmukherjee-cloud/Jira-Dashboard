const { listUsers } = require('../../lib/slack');

module.exports = async (req, res) => {
  try {
    res.status(200).json(await listUsers());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const { postToChannel } = require('../../lib/slack');

module.exports = async (req, res) => {
  try {
    await postToChannel((req.body || {}).message);
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

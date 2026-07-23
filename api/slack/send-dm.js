const { sendDm } = require('../../lib/slack');

module.exports = async (req, res) => {
  try {
    const { userId, message } = req.body || {};
    await sendDm(userId, message);
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

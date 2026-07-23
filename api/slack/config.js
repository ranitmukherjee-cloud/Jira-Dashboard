const { isConfigured } = require('../../lib/slack');

module.exports = async (req, res) => {
  res.status(200).json({ configured: isConfigured() });
};

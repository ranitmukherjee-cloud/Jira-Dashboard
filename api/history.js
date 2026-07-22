const { getHistory } = require('../lib/store');

module.exports = async (req, res) => {
  const history = await getHistory();
  res.status(200).json(history);
};

const { getData } = require('../lib/store');

module.exports = async (req, res) => {
  const data = await getData();
  res.status(200).json(data);
};

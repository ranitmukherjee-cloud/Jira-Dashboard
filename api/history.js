// Day-over-day trend history needs persistent storage across days, which this
// database-free, live-only deployment doesn't have. Returns an empty list; the
// frontend hides the trend charts when there's no history to show.
module.exports = async (req, res) => {
  res.status(200).json([]);
};

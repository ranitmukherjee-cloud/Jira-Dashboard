// Diagnostic endpoint — reports whether Redis env vars are present and
// whether the client initialized, without ever exposing the actual secret
// values. Safe to leave in place; it's just booleans and an error message.
const { USE_REDIS, initError } = require('../../lib/trackerStore');

module.exports = async (req, res) => {
  const err = initError();
  res.status(200).json({
    hasKvUrl: !!process.env.KV_REST_API_URL,
    hasKvToken: !!process.env.KV_REST_API_TOKEN,
    hasUpstashUrl: !!process.env.UPSTASH_REDIS_REST_URL,
    hasUpstashToken: !!process.env.UPSTASH_REDIS_REST_TOKEN,
    useRedis: USE_REDIS,
    initError: err ? err.message : null,
  });
};

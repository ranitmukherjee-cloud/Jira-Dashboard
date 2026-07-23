const { listTasks, createTask, listLeave, setLeaveStatus } = require('../../lib/tracker');
const { USE_REDIS, initError } = require('../../lib/trackerStore');

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      // Folded in from the old dedicated api/tracker/debug.js -- kept as a
      // query param instead of its own file to stay under Vercel Hobby's
      // 12-serverless-function cap. Never exposes actual secret values.
      if (req.query.debug) {
        const err = initError();
        res.status(200).json({
          hasKvUrl: !!process.env.KV_REST_API_URL,
          hasKvToken: !!process.env.KV_REST_API_TOKEN,
          hasUpstashUrl: !!process.env.UPSTASH_REDIS_REST_URL,
          hasUpstashToken: !!process.env.UPSTASH_REDIS_REST_TOKEN,
          useRedis: USE_REDIS,
          initError: err ? err.message : null,
        });
        return;
      }
      // Leave map folded into this route too (same function-cap reason).
      if (req.query.resource === 'leave') {
        res.status(200).json(await listLeave());
        return;
      }
      res.status(200).json(await listTasks());
      return;
    }
    if (req.method === 'POST') {
      const body = req.body || {};
      if (body.resource === 'leave') {
        const map = await setLeaveStatus(body.pse, body.date, !!body.onLeave);
        res.status(200).json(map);
        return;
      }
      const task = await createTask(body);
      res.status(201).json(task);
      return;
    }
    res.status(405).json({ error: 'Use GET or POST' });
  } catch (err) {
    console.error('Tracker API error:', err);
    res.status(400).json({ error: err.message });
  }
};

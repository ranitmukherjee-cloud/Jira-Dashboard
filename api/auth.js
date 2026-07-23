const {
  createSession,
  destroySession,
  checkCredentials,
  recordFailedAttempt,
  isRateLimited,
  clearFailedAttempts,
} = require('../lib/authStore');

function cookieOptions(maxAgeSeconds) {
  const secure = !!process.env.VERCEL; // Vercel is always https; local dev (server.js) isn't
  return `Path=/; HttpOnly; SameSite=Lax; ${secure ? 'Secure; ' : ''}Max-Age=${maxAgeSeconds}`;
}

function getIdentifier(req) {
  const fwd = req.headers['x-forwarded-for'];
  const ip = (Array.isArray(fwd) ? fwd[0] : fwd || '').split(',')[0].trim();
  return ip || req.socket?.remoteAddress || 'unknown';
}

function getCookie(req, name) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}

module.exports = async (req, res) => {
  if (req.method === 'POST') {
    const id = getIdentifier(req);
    if (await isRateLimited(id)) {
      res.status(429).json({ error: 'Too many failed attempts. Try again in a few minutes.' });
      return;
    }
    const { username, password } = req.body || {};
    if (!checkCredentials(username, password)) {
      await recordFailedAttempt(id);
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }
    await clearFailedAttempts(id);
    const token = await createSession();
    res.setHeader('Set-Cookie', `session=${token}; ${cookieOptions(14 * 24 * 60 * 60)}`);
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method === 'DELETE') {
    const token = getCookie(req, 'session');
    if (token) await destroySession(token);
    res.setHeader('Set-Cookie', `session=; Path=/; HttpOnly; Max-Age=0`);
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: 'Use POST or DELETE' });
};

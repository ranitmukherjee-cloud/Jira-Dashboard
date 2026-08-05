// Vercel Edge Middleware — runs in front of every request (static assets AND
// serverless functions) before the login gate was added anyone with the URL
// could see live GoComet deal/revenue data with zero authentication. This is
// the only layer that can also gate the static HTML/JS/CSS files, since
// those are served directly from the CDN rather than through a function.
export const config = {
  // api/fireflies-webhook authenticates via HMAC signature and
  // api/cron/fireflies-retry via Vercel's CRON_SECRET bearer token —
  // both server-to-server, not a session cookie, so both are excluded from
  // this gate just like api/auth.
  matcher: ['/((?!login.html|api/auth|api/fireflies-webhook|api/cron/fireflies-retry|favicon.ico).*)'],
};

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

function getCookie(req, name) {
  const cookie = req.headers.get('cookie') || '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}

export default async function middleware(req) {
  const token = getCookie(req, 'session');
  let valid = false;

  if (token && REDIS_URL && REDIS_TOKEN) {
    try {
      const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent('session:' + token)}`, {
        headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      });
      const data = await r.json();
      valid = data.result != null;
    } catch {
      valid = false;
    }
  }

  if (valid) return; // let the request through as normal

  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const from = url.pathname + url.search;
  url.pathname = '/login.html';
  url.search = from === '/' ? '' : `?from=${encodeURIComponent(from)}`;
  return Response.redirect(url, 302);
}

const { getConfig } = require('../lib/jira');
const { verifySignature, handleTranscriptionCompleted, queuePendingMeeting } = require('../lib/fireflies');

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Fireflies webhook receiver: fires once a meeting's transcript finishes
// processing. We verify the HMAC signature (bodyParser disabled below so we
// see the exact bytes Fireflies signed), then pull the summary + transcript
// and drop them onto the PSV card named in the meeting title.
async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }

  const secret = process.env.FIREFLIES_WEBHOOK_SECRET;
  if (!secret) {
    res.status(500).json({ error: 'FIREFLIES_WEBHOOK_SECRET not configured' });
    return;
  }

  const rawBody = await readRawBody(req);
  if (!verifySignature(rawBody, req.headers['x-hub-signature'], secret)) {
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }

  if (payload.eventType !== 'Transcription completed') {
    res.status(200).json({ ok: true, skipped: true, reason: 'ignored event type' });
    return;
  }

  const apiKey = process.env.FIREFLIES_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'FIREFLIES_API_KEY not configured' });
    return;
  }

  try {
    const jiraCfg = getConfig();
    const result = await handleTranscriptionCompleted({
      meetingId: payload.meetingId,
      jiraCfg,
      projectKey: jiraCfg.projectKey,
      apiKey,
    });
    if (result.skipped && result.reason === 'no Jira key found in meeting title') {
      await queuePendingMeeting(payload.meetingId, result.title);
    }
    res.status(200).json(result);
  } catch (err) {
    console.error('Fireflies webhook failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };

// Fireflies -> Jira bridge. When a meeting's transcript finishes processing,
// Fireflies webhooks us with just { meetingId, eventType }; the actual title,
// summary and transcript have to be pulled separately via Fireflies' GraphQL
// API. We find the PSV card from the meeting title (organizers are expected
// to put the card key in it, e.g. "PSV-1234 - Sync with Acme"), upload the
// full transcript as a file attachment (keeps the comment feed uncluttered),
// and post a single summary comment on that issue linking to it.
const crypto = require('crypto');
const { addComment, addAttachment, hasCommentContaining } = require('./jira');
const { getPending, setPending } = require('./firefliesStore');

const FIREFLIES_GRAPHQL_URL = 'https://api.fireflies.ai/graphql';

// Fireflies has no "title changed" webhook event — only "Transcription
// completed", fired once. So a meeting whose title had no PSV key yet at
// that point goes into this queue instead of being dropped, and a retry
// (see retryPendingMeetings) rechecks its *current* title later, in case
// someone added the key after the fact. Anything still unmatched after this
// window falls back to manual copy-paste into the Jira comment box.
const RETRY_WINDOW_MS = 48 * 60 * 60 * 1000;

// Fireflies signs the raw request body with HMAC-SHA256 and sends it in the
// x-hub-signature header (see docs.fireflies.ai/graphql-api/webhooks).
function verifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const provided = String(signatureHeader).replace(/^sha256=/, '');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function extractIssueKey(title, projectKey) {
  if (!title) return null;
  const re = new RegExp(`\\b(${projectKey})-(\\d+)\\b`, 'i');
  const m = title.match(re);
  return m ? `${projectKey.toUpperCase()}-${m[2]}` : null;
}

async function fetchTranscript(apiKey, transcriptId) {
  const query = `
    query Transcript($id: String!) {
      transcript(id: $id) {
        title
        date
        dateString
        transcript_url
        summary {
          overview
          action_items
          keywords
        }
        sentences {
          speaker_name
          text
        }
      }
    }
  `;
  const res = await fetch(FIREFLIES_GRAPHQL_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { id: transcriptId } }),
  });
  if (!res.ok) throw new Error(`Fireflies API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.errors) throw new Error(`Fireflies API error: ${JSON.stringify(data.errors)}`);
  return data.data.transcript;
}

function bulletList(text) {
  const items = String(text)
    .split('\n')
    .map((s) => s.replace(/^[-•*]\s*/, '').trim())
    .filter(Boolean);
  if (!items.length) return null;
  return {
    type: 'bulletList',
    content: items.map((item) => ({
      type: 'listItem',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: item }] }],
    })),
  };
}

function markerParagraph(meetingId) {
  return {
    type: 'paragraph',
    content: [{ type: 'text', text: `Synced automatically from Fireflies · meeting ${meetingId}`, marks: [{ type: 'em' }] }],
  };
}

// attachment is { filename, url } for the transcript file already uploaded
// to the issue (or null, if that upload failed — the summary still posts).
function buildSummaryAdf({ title, dateString, transcript_url: transcriptUrl, summary }, meetingId, attachment) {
  const content = [
    { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: `Fireflies meeting summary — ${title || 'Untitled meeting'}` }] },
  ];
  if (dateString) content.push({ type: 'paragraph', content: [{ type: 'text', text: dateString, marks: [{ type: 'em' }] }] });
  if (summary?.overview) content.push({ type: 'paragraph', content: [{ type: 'text', text: summary.overview }] });

  const actionItems = summary?.action_items ? bulletList(summary.action_items) : null;
  if (actionItems) {
    content.push({ type: 'paragraph', content: [{ type: 'text', text: 'Action items:', marks: [{ type: 'strong' }] }] });
    content.push(actionItems);
  }
  if (summary?.keywords?.length) {
    content.push({ type: 'paragraph', content: [{ type: 'text', text: `Keywords: ${[].concat(summary.keywords).join(', ')}`, marks: [{ type: 'em' }] }] });
  }
  if (attachment?.url) {
    content.push({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Full transcript: ', marks: [{ type: 'strong' }] },
        { type: 'text', text: attachment.filename || 'transcript.txt', marks: [{ type: 'link', attrs: { href: attachment.url } }] },
      ],
    });
  }
  if (transcriptUrl) {
    content.push({ type: 'paragraph', content: [{ type: 'text', text: 'View in Fireflies', marks: [{ type: 'link', attrs: { href: transcriptUrl } }] }] });
  }
  content.push(markerParagraph(meetingId));
  return { type: 'doc', version: 1, content };
}

// Groups consecutive sentences from the same speaker into one turn instead
// of one entry per sentence, so the transcript file reads naturally.
function groupBySpeaker(sentences) {
  const turns = [];
  for (const s of sentences || []) {
    const speaker = s.speaker_name || 'Unknown speaker';
    const text = (s.text || '').trim();
    if (!text) continue;
    const last = turns[turns.length - 1];
    if (last && last.speaker === speaker) last.text += ' ' + text;
    else turns.push({ speaker, text });
  }
  return turns;
}

function buildTranscriptText({ title, dateString, sentences }) {
  const turns = groupBySpeaker(sentences);
  const header = `Fireflies full transcript — ${title || 'Untitled meeting'}${dateString ? `\n${dateString}` : ''}\n\n`;
  if (!turns.length) return header + '(No transcript text was returned by Fireflies for this meeting.)';
  return header + turns.map((t) => `${t.speaker}: ${t.text}`).join('\n\n');
}

// Windows/most filesystems reject \ / : * ? " < > | in filenames, so DD/MM/YYYY
// becomes DD-MM-YYYY here even though the date reads the same either way.
function buildTranscriptFilename(issueKey, { title, date }) {
  const descriptor = (title || 'Meeting')
    .replace(new RegExp(`\\b${issueKey}\\b`, 'i'), '')
    .replace(/^[\s\-–—:]+/, '')
    .trim() || 'Meeting';
  const d = date ? new Date(date) : new Date();
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dateStr = `${dd}-${mm}-${d.getUTCFullYear()}`;
  const safe = (s) => s.replace(/[\\/:*?"<>|]/g, '-');
  return `${safe(`${issueKey} - ${descriptor} on ${dateStr}`)}.txt`;
}

// Pure: fetches the transcript, tries to match it, posts if matched. No
// pending-queue side effects — callers (the webhook route, and the retry
// loop below) decide what to do with an unmatched result themselves, so the
// retry loop can read-modify-write the queue exactly once per run instead of
// racing with this function's own writes.
async function handleTranscriptionCompleted({ meetingId, jiraCfg, projectKey, apiKey }) {
  const transcript = await fetchTranscript(apiKey, meetingId);
  const issueKey = extractIssueKey(transcript?.title, projectKey);
  if (!issueKey) {
    return { ok: false, skipped: true, reason: 'no Jira key found in meeting title', title: transcript?.title || null };
  }

  const marker = `meeting ${meetingId}`;
  if (await hasCommentContaining(jiraCfg, issueKey, marker)) {
    return { ok: true, skipped: true, reason: 'already posted', issueKey };
  }

  let attachment = null;
  try {
    const filename = buildTranscriptFilename(issueKey, transcript);
    const text = buildTranscriptText(transcript);
    attachment = await addAttachment(jiraCfg, issueKey, filename, Buffer.from(text, 'utf8'), 'text/plain');
  } catch (err) {
    // Don't let a failed attachment upload block the summary from posting —
    // log it and fall back to a summary comment with no transcript link.
    console.error(`Fireflies transcript attachment failed for ${issueKey}:`, err.message);
  }

  await addComment(jiraCfg, issueKey, buildSummaryAdf(transcript, meetingId, attachment));
  return { ok: true, issueKey, title: transcript.title };
}

// Called by the webhook route after a fresh "no key found" result, so the
// retry loop below has something to check later.
async function queuePendingMeeting(meetingId, title) {
  const pending = await getPending();
  if (pending.some((p) => p.meetingId === meetingId)) return;
  pending.push({ meetingId, title, firstSeenAt: Date.now() });
  await setPending(pending);
}

// Rechecks every queued meeting's *current* title. A match means someone
// added the PSV key after transcription had already completed; anything
// past RETRY_WINDOW_MS is dropped (falls back to manual copy-paste from
// there). Reads the queue once and writes it back once, after processing
// every entry, to avoid racing with itself.
async function retryPendingMeetings({ jiraCfg, projectKey, apiKey }) {
  const pending = await getPending();
  const now = Date.now();
  const next = [];
  const matched = [];
  const expired = [];

  for (const entry of pending) {
    if (now - entry.firstSeenAt > RETRY_WINDOW_MS) {
      expired.push(entry.meetingId);
      continue;
    }
    try {
      const outcome = await handleTranscriptionCompleted({ meetingId: entry.meetingId, jiraCfg, projectKey, apiKey });
      if (outcome.ok && !outcome.skipped) {
        matched.push({ meetingId: entry.meetingId, issueKey: outcome.issueKey });
        continue;
      }
    } catch (err) {
      console.error(`Fireflies retry failed for meeting ${entry.meetingId}:`, err.message);
    }
    next.push(entry); // still unmatched (or errored this round) — stays queued
  }

  await setPending(next);
  return { matched, expired, stillPending: next.length };
}

module.exports = {
  verifySignature,
  extractIssueKey,
  fetchTranscript,
  buildSummaryAdf,
  buildTranscriptText,
  buildTranscriptFilename,
  handleTranscriptionCompleted,
  queuePendingMeeting,
  retryPendingMeetings,
  RETRY_WINDOW_MS,
};

import assert from 'node:assert/strict';
import {
  openDatabase,
  findProcessedGmailIds,
  getCachedEmailPreview,
  getSyncCursor,
  listCleanupCandidates,
  recordTrashed,
  saveClassification,
  saveEmailBodyCache,
  saveMessage,
  setSyncCursor,
  shouldSendAlert,
  createDigestRun
} from './db.js';
import { ttlCutoffs } from './cleanup.js';
import type { AppConfig, Classification, EmailMessage } from './types.js';

const config: AppConfig = {
  google: {
    clientId: '',
    clientSecret: '',
    redirectUri: '',
    accounts: []
  },
  discord: {
    botToken: '',
    digestChannelId: '',
    realtimeChannelId: '',
    debugChannelId: '',
    debugCooldownMs: 60 * 60 * 1000
  },
  digest: {
    timezone: 'UTC',
    cron: '0 19 * * *',
    processCron: '*/10 * * * *',
    lookbackHours: 24,
    maxMessages: 20,
    unreadOnly: true
  },
  classifier: {
    provider: 'rule',
    rulesPath: '',
    llm: {
      apiKey: '',
      baseUrl: '',
      model: '',
      providerName: ''
    },
    maxRetries: 4,
    requestTimeoutMs: 60000
  },
  cleanup: {
    ttlDays: { junk: 0, fyi: 14, admin: 30 },
    maxPerAccount: 200
  },
  database: {
    path: ':memory:'
  }
};

const db = openDatabase(config);
const bodyText = [
  'View in browser https://newsletter.example.com/view-in-browser?id=1',
  'Pixel https://cdn.example.com/open/pixel.gif',
  'Unsubscribe https://marketing.example.com/unsubscribe?id=1',
  '课程报名请打开 https://links.school.edu/click?url=https%3A%2F%2Fforms.gle%2Fabc123&utm_source=email',
  'Join the meeting on Zoom: https://zoom.us/j/123456789?pwd=secret',
  'The full homework document is https://docs.google.com/document/d/abc/edit?usp=sharing&utm_medium=email'
].join('\n');

const email: EmailMessage = {
  accountId: 'primary',
  accountEmail: 'me@example.com',
  id: 'gmail-1',
  threadId: 'thread-1',
  labelIds: [],
  headers: [],
  subject: 'Useful links',
  from: 'Teacher <teacher@example.com>',
  date: null,
  snippet: '',
  text: bodyText,
  gmailUrl: 'https://mail.google.com/mail/u/me/#all/thread-1'
};

saveMessage(db, email.accountEmail, email);
saveEmailBodyCache(db, email);

const preview = getCachedEmailPreview(db, 'primary:gmail-1');
assert.ok(preview);
assert.deepEqual(new Set(preview.links.map((link) => link.url)), new Set([
  'https://forms.gle/abc123',
  'https://docs.google.com/document/d/abc/edit?usp=sharing&utm_medium=email',
  'https://zoom.us/j/123456789?pwd=secret'
]));
assert.deepEqual(new Set(preview.links.map((link) => link.label)), new Set([
  '打开 forms.gle/abc123',
  '打开 docs.google.com/document/d',
  '打开 zoom.us/j/123456789'
]));

db.prepare(`
  update email_body_cache
  set links_json = ?
  where account_id = ? and gmail_id = ?
`).run(
  JSON.stringify(['https://example.com/a', { url: 'https://example.com/b', label: '打开 example.com/b' }]),
  'primary',
  'gmail-1'
);

const legacyPreview = getCachedEmailPreview(db, 'primary:gmail-1');
assert.ok(legacyPreview);
assert.deepEqual(legacyPreview.links, [
  { url: 'https://example.com/a' },
  { url: 'https://example.com/b', label: '打开 example.com/b' }
]);

// Cleanup candidate selection: per-category TTL + latest-classification + log exclusion.
const cleanupDb = openDatabase(config);
const runId = createDigestRun(cleanupDb, 'primary', 'me@example.com', new Date());
const DAY = 24 * 60 * 60 * 1000;

function seedClassified(
  gmailId: string,
  category: Classification['category'],
  processedDaysAgo: number
): void {
  const message: EmailMessage = {
    accountId: 'primary',
    accountEmail: 'me@example.com',
    id: gmailId,
    threadId: `thread-${gmailId}`,
    labelIds: [],
    headers: [],
    subject: `Subject ${gmailId}`,
    from: `Sender <${gmailId}@example.com>`,
    date: null,
    snippet: '',
    text: '',
    gmailUrl: `https://mail.google.com/mail/u/me/#all/thread-${gmailId}`
  };
  saveMessage(cleanupDb, message.accountEmail, message);
  const classification: Classification = {
    category,
    importance: 10,
    summary: `summary ${gmailId}`,
    confidence: 0.5,
    provider: 'rule'
  };
  saveClassification(cleanupDb, runId, message, classification, 'digest_only');
  cleanupDb.prepare(`
    update message_classifications
    set processed_at = ?
    where account_id = ? and gmail_id = ?
  `).run(new Date(Date.now() - processedDaysAgo * DAY).toISOString(), 'primary', gmailId);
}

seedClassified('junk-old', 'junk', 1);       // eligible: junk TTL = 0
seedClassified('fyi-fresh', 'fyi', 3);       // not eligible yet: fyi TTL = 14
seedClassified('fyi-stale', 'fyi', 20);      // eligible: older than 14 days
seedClassified('admin-stale', 'admin', 20);  // not eligible: admin TTL = 30
seedClassified('course-old', 'course', 90);  // never eligible (no TTL)

// Dedup signal: only already-classified ids come back; unknown ids do not.
assert.deepEqual(
  findProcessedGmailIds(cleanupDb, 'primary', ['junk-old', 'fyi-stale', 'never-seen']),
  new Set(['junk-old', 'fyi-stale'])
);
assert.deepEqual(findProcessedGmailIds(cleanupDb, 'primary', []), new Set());
// Dedup is scoped per account.
assert.deepEqual(findProcessedGmailIds(cleanupDb, 'other', ['junk-old']), new Set());

// Per-account incremental-sync cursor: absent, then upserted per account.
assert.equal(getSyncCursor(cleanupDb, 'primary'), null);
setSyncCursor(cleanupDb, 'primary', '12345');
assert.equal(getSyncCursor(cleanupDb, 'primary'), '12345');
setSyncCursor(cleanupDb, 'primary', '23456');
assert.equal(getSyncCursor(cleanupDb, 'primary'), '23456');
assert.equal(getSyncCursor(cleanupDb, 'other'), null);

// Alert dedup gate: first fire sends, repeats within cooldown are suppressed,
// a different signature still fires, and the cooldown counts from the last sent.
const hour = 60 * 60 * 1000;
const t0 = new Date('2026-01-01T00:00:00Z');
assert.equal(shouldSendAlert(cleanupDb, 'sig-a', hour, t0), true);
assert.equal(shouldSendAlert(cleanupDb, 'sig-a', hour, new Date(t0.getTime() + 30 * 60 * 1000)), false);
assert.equal(shouldSendAlert(cleanupDb, 'sig-b', hour, new Date(t0.getTime() + 30 * 60 * 1000)), true);
assert.equal(shouldSendAlert(cleanupDb, 'sig-a', hour, new Date(t0.getTime() + 61 * 60 * 1000)), true);

const cutoffs = ttlCutoffs(config.cleanup.ttlDays, new Date());
const candidates = listCleanupCandidates(cleanupDb, 'primary', cutoffs, 200);
assert.deepEqual(
  new Set(candidates.map((candidate) => candidate.gmailId)),
  new Set(['junk-old', 'fyi-stale'])
);

// A logged (already trashed) message drops out of the candidate list.
recordTrashed(cleanupDb, {
  accountId: 'primary',
  gmailId: 'junk-old',
  category: 'junk',
  importance: 10,
  processedAt: new Date().toISOString()
}, 'cleanup');

const afterLog = listCleanupCandidates(cleanupDb, 'primary', cutoffs, 200);
assert.deepEqual(new Set(afterLog.map((candidate) => candidate.gmailId)), new Set(['fyi-stale']));

console.log('db.test.ts: all assertions passed');

import assert from 'node:assert/strict';
import {
  completeFollowupClose,
  getFollowup,
  listFollowupMessages,
  recordFollowupMessage,
  reserveFollowup,
  beginFollowupClose
} from './followup-store.js';
import { openFollowup } from './followup-service.js';
import {
  createDigestRun,
  openDatabase,
  saveClassification,
  saveEmailBodyCache,
  saveMessage
} from './db.js';
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
  followup: { enabled: true, forumChannelId: 'forum-1' },
  digest: {
    timezone: 'UTC',
    cron: '0 19 * * *',
    processCron: '*/5 * * * *',
    lookbackHours: 24,
    maxMessages: 20
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
  database: {
    path: ':memory:'
  }
};

const db = openDatabase(config);
const runId = createDigestRun(db, 'primary', 'me@example.com', new Date());

function seedEmail(input: {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  text: string;
  summary: string;
  category?: Classification['category'];
  date?: string;
}): EmailMessage {
  const email: EmailMessage = {
    accountId: 'primary',
    accountEmail: 'me@example.com',
    id: input.id,
    threadId: input.threadId,
    labelIds: ['INBOX'],
    headers: [],
    subject: input.subject,
    from: input.from,
    date: new Date(input.date || '2026-07-25T01:00:00Z'),
    snippet: input.text.slice(0, 120),
    text: input.text,
    gmailUrl: `https://mail.google.com/mail/u/me/#all/${input.threadId}`
  };
  saveMessage(db, email.accountEmail, email);
  saveEmailBodyCache(db, email);
  saveClassification(db, runId, email, {
    category: input.category || 'action',
    importance: 80,
    summary: input.summary,
    attentionPoints: ['A concrete detail to notice.'],
    suggestedActions: ['Take the next step.'],
    confidence: 0.95,
    provider: 'fixture'
  }, 'digest_only');
  return email;
}

seedEmail({
  id: 'conversation-1',
  threadId: 'business-thread',
  subject: 'Contract discussion',
  from: 'Client <client@example.com>',
  text: 'Could you review the attached terms before Tuesday? https://docs.google.com/document/d/terms/edit',
  summary: 'The client asked for a contract review before Tuesday.',
  date: '2026-07-25T01:00:00Z'
});
seedEmail({
  id: 'conversation-2',
  threadId: 'business-thread',
  subject: 'Re: Contract discussion',
  from: 'Me <me@example.com>',
  text: 'I reviewed the terms and asked one question about payment.',
  summary: 'A payment question is awaiting the client response.',
  date: '2026-07-25T02:00:00Z'
});
seedEmail({
  id: 'todo-1',
  threadId: 'bill-thread',
  subject: 'Electricity bill due',
  from: 'Utility <billing@example.com>',
  text: 'Your bill is due Friday.',
  summary: 'The electricity bill is due Friday.',
  category: 'admin'
});
seedEmail({
  id: 'read-1',
  threadId: 'newsletter-thread',
  subject: 'A practical guide to SQLite WAL',
  from: 'Database Weekly <newsletter@example.com>',
  text: 'Read the full article at https://example.com/sqlite-wal',
  summary: 'This issue explains practical SQLite WAL trade-offs.',
  category: 'fyi'
});

const firstConversation = reserveFollowup(
  db,
  'primary',
  'conversation-1',
  'conversation',
  new Date('2026-07-25T03:00:00Z')
);
assert.ok(firstConversation);
assert.equal(firstConversation.created, true);
assert.equal(firstConversation.followup.kind, 'conversation');
assert.equal(firstConversation.followup.gmailThreadId, 'business-thread');
assert.equal(firstConversation.followup.state, 'opening');
assert.deepEqual(
  listFollowupMessages(db, firstConversation.followup.id).map((message) => message.gmailId),
  ['conversation-1', 'conversation-2']
);

// A second message in the same Gmail thread reuses the original follow-up,
// preserves its kind and records the additional message snapshot.
const repeatedConversation = reserveFollowup(
  db,
  'primary',
  'conversation-2',
  'todo',
  new Date('2026-07-25T03:05:00Z')
);
assert.ok(repeatedConversation);
assert.equal(repeatedConversation.created, false);
assert.equal(repeatedConversation.followup.id, firstConversation.followup.id);
assert.equal(repeatedConversation.followup.kind, 'conversation');
assert.deepEqual(
  listFollowupMessages(db, firstConversation.followup.id).map((message) => message.gmailId),
  ['conversation-1', 'conversation-2']
);

const firstMessage = listFollowupMessages(db, firstConversation.followup.id)[0];
assert.ok(firstMessage);
assert.equal(firstMessage.summary, 'The client asked for a contract review before Tuesday.');
assert.deepEqual(firstMessage.attentionPoints, ['A concrete detail to notice.']);
assert.deepEqual(firstMessage.suggestedActions, ['Take the next step.']);
assert.equal(firstMessage.links[0]?.url, 'https://docs.google.com/document/d/terms/edit');

assert.equal(recordFollowupMessage(db, firstConversation.followup.id, {
  gmailThreadId: 'business-thread',
  gmailId: 'conversation-2',
  sender: 'Me <me@example.com>',
  subject: 'Re: Contract discussion',
  messageDate: '2026-07-25T02:00:00Z',
  gmailUrl: 'https://mail.google.com/mail/u/me/#all/business-thread',
  bodyText: 'Duplicate hydration attempt.',
  summary: 'Duplicate.',
  attentionPoints: [],
  suggestedActions: [],
  links: []
}), false);
assert.throws(() => recordFollowupMessage(db, firstConversation.followup.id, {
  gmailThreadId: 'another-thread',
  gmailId: 'wrong-thread-message',
  sender: 'Someone',
  subject: 'Wrong thread',
  messageDate: null,
  gmailUrl: 'https://mail.google.com/mail/u/me/#all/another-thread',
  bodyText: '',
  summary: '',
  attentionPoints: [],
  suggestedActions: [],
  links: []
}), /does not match follow-up thread/);

const todo = reserveFollowup(db, 'primary', 'todo-1', 'todo');
const readLater = reserveFollowup(db, 'primary', 'read-1', 'read_later');
assert.equal(todo?.followup.kind, 'todo');
assert.equal(readLater?.followup.kind, 'read_later');
assert.notEqual(todo?.followup.id, readLater?.followup.id);
assert.equal(reserveFollowup(db, 'primary', 'missing', 'todo'), null);

seedEmail({
  id: 'service-1',
  threadId: 'service-thread',
  subject: 'Follow-up service test',
  from: 'Partner <partner@example.com>',
  text: 'Please confirm the launch date.',
  summary: 'The partner needs launch-date confirmation.'
});

let publishCount = 0;
const opened = await openFollowup(
  db,
  { accountId: 'primary', gmailId: 'service-1' },
  'conversation',
  async (draft) => {
    publishCount += 1;
    assert.equal(draft.source.gmailId, 'service-1');
    assert.equal(draft.followup.kind, 'conversation');
    return {
      forumChannelId: 'forum-1',
      threadId: 'discord-thread-1',
      messageId: 'discord-message-1'
    };
  }
);
assert.equal(opened.outcome, 'created');
assert.equal(opened.followup.state, 'open');
assert.equal(opened.followup.discordThreadId, 'discord-thread-1');
assert.equal(publishCount, 1);

const duplicateOpen = await openFollowup(
  db,
  { accountId: 'primary', gmailId: 'service-1' },
  'todo',
  async () => {
    publishCount += 1;
    throw new Error('duplicate should not publish');
  }
);
assert.equal(duplicateOpen.outcome, 'existing');
assert.equal(duplicateOpen.followup.kind, 'conversation');
assert.equal(publishCount, 1);

seedEmail({
  id: 'retry-1',
  threadId: 'retry-thread',
  subject: 'Retry test',
  from: 'Vendor <vendor@example.com>',
  text: 'The first Forum request will fail.',
  summary: 'This follow-up exercises retry recovery.'
});

await assert.rejects(
  openFollowup(
    db,
    { accountId: 'primary', gmailId: 'retry-1' },
    'todo',
    async () => {
      throw new Error('Discord unavailable');
    }
  ),
  /Discord unavailable/
);
const failed = db.prepare(`
  select id, state, retry_count as retryCount, last_error as lastError
  from followups where account_id = ? and gmail_thread_id = ?
`).get('primary', 'retry-thread') as {
  id: number;
  state: string;
  retryCount: number;
  lastError: string;
};
assert.equal(failed.state, 'failed');
assert.equal(failed.retryCount, 1);
assert.match(failed.lastError, /Discord unavailable/);

const retried = await openFollowup(
  db,
  { accountId: 'primary', gmailId: 'retry-1' },
  'todo',
  async () => ({
    forumChannelId: 'forum-1',
    threadId: 'discord-thread-retry',
    messageId: 'discord-message-retry'
  })
);
assert.equal(retried.outcome, 'created');
assert.equal(retried.followup.state, 'open');
assert.equal(retried.followup.retryCount, 1);

const closing = beginFollowupClose(db, opened.followup.id, new Date('2026-07-25T04:00:00Z'));
assert.equal(closing.state, 'closing');
assert.equal(beginFollowupClose(db, opened.followup.id).state, 'closing');
const closed = completeFollowupClose(
  db,
  opened.followup.id,
  'Launch date confirmed.',
  new Date('2026-07-25T04:05:00Z')
);
assert.equal(closed.state, 'closed');
assert.equal(closed.closeNote, 'Launch date confirmed.');
assert.equal(completeFollowupClose(db, opened.followup.id, 'Ignored retry note').closeNote, 'Launch date confirmed.');
assert.equal(getFollowup(db, opened.followup.id)?.state, 'closed');

db.close();
console.log('followup-store.test.ts: all assertions passed');

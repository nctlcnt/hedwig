import assert from 'node:assert/strict';
import { listProcessedDigestItems, openDatabase } from './db.js';
import { processUnreadMail } from './digest.js';
import type { MailGateway } from './gateway/mail-gateway.js';
import type { AppConfig, EmailMessage } from './types.js';

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
  followup: { enabled: false, forumChannelId: '' },
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

const messages = new Map<string, EmailMessage>([
  ['fyi-1', email('fyi-1', 'Project update', 'Here is the weekly project update.')],
  ['junk-1', email('junk-1', '581167 is your code', 'Your verification code is 581167.')]
]);
const cursors: Array<string | null> = [];
let messageFetches = 0;
const forbidden = new Set([
  'markMessagesRead',
  'removeFromInbox',
  'trashMessages',
  'getFollowupLabelId',
  'getMessageLabels'
]);
const gateway = new Proxy({
  listAccounts: () => [{ id: 'primary', displayName: 'Primary' }],
  getCurrentUser: async () => 'me@example.com',
  syncInboxMessages: async (_account: unknown, options: { cursor: string | null }) => {
    cursors.push(options.cursor);
    return {
      refs: [{ id: 'fyi-1' }, { id: 'vanished-1' }, { id: 'junk-1' }],
      cursor: 'cursor-200',
      reset: options.cursor === null
    };
  },
  getMessage: async (_account: unknown, _accountEmail: string, id: string) => {
    messageFetches += 1;
    if (id === 'vanished-1') return null;
    const message = messages.get(id);
    if (!message) throw new Error(`Missing test message ${id}`);
    return message;
  }
}, {
  get(target, property, receiver) {
    if (typeof property === 'string' && forbidden.has(property)) {
      throw new Error(`Gmail mutation path accessed: ${property}`);
    }
    return Reflect.get(target, property, receiver);
  }
}) as MailGateway;

const db = openDatabase(config);
const first = await processUnreadMail(config, db, gateway);
assert.equal(first[0]?.total, 2);
assert.deepEqual(cursors, [null]);
assert.equal(messageFetches, 3);

const outcomes = db.prepare(`
  select gmail_id as gmailId, processing_outcome as processingOutcome
  from message_classifications
  order by gmail_id
`).all() as Array<{ gmailId: string; processingOutcome: string }>;
assert.deepEqual(outcomes, [
  { gmailId: 'fyi-1', processingOutcome: 'digest_only' },
  { gmailId: 'junk-1', processingOutcome: 'suppress' }
]);

const visible = listProcessedDigestItems(
  db,
  new Date(Date.now() - 60_000),
  new Date(Date.now() + 60_000)
);
assert.deepEqual(visible.map((item) => item.id), ['fyi-1']);

// Cursor replay returns the same ids, but SQLite dedup prevents refetch,
// reclassification and duplicate notifications.
const replay = await processUnreadMail(config, db, gateway);
assert.equal(replay[0]?.total, 0);
assert.deepEqual(cursors, [null, 'cursor-200']);
assert.equal(messageFetches, 4);
const classificationCount = db.prepare('select count(*) as count from message_classifications').get() as { count: number };
assert.equal(classificationCount.count, 2);

console.log('digest.test.ts: all assertions passed');

function email(id: string, subject: string, text: string): EmailMessage {
  return {
    accountId: 'primary',
    accountEmail: 'me@example.com',
    id,
    threadId: `thread-${id}`,
    labelIds: ['INBOX', 'UNREAD'],
    headers: [],
    subject,
    from: 'Sender <sender@example.com>',
    date: new Date(),
    snippet: text,
    text,
    gmailUrl: `https://mail.google.com/mail/?authuser=me%40example.com#all/thread-${id}`
  };
}

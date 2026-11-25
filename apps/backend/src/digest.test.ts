import assert from 'node:assert/strict';
import { getSyncCursor, listProcessedDigestItems, openDatabase } from './db.js';
import { processUnreadMail, queueTodayDigest, runDailyDigest } from './digest.js';
import type { MailGateway } from './gateway/mail-gateway.js';
import { DeliveryError, type Notifier, type OperationalAlert } from './notifications/notifier.js';
import { createOutboxDrain } from './notifications/outbox-worker.js';
import type { AppConfig, DigestReport, EmailMessage } from './types.js';

const config: AppConfig = {
  messagingProvider: 'discord',
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
  ['action-1', email('action-1', 'Action required', 'Please respond by tomorrow.')],
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
      refs: [{ id: 'action-1' }, { id: 'fyi-1' }, { id: 'vanished-1' }, { id: 'junk-1' }],
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

const digests: DigestReport[] = [];
const delivered: string[] = [];
const alerts: OperationalAlert[] = [];
let realtimeAttempts = 0;
const notifier: Notifier = {
  platform: 'fake',
  digestDestination: 'digest-chat',
  realtimeDestination: 'realtime-chat',
  alertCooldownMs: 60 * 60 * 1000,
  planDigest(digest) {
    digests.push(digest);
    return [{ key: 'summary', payload: { name: digest.date } }];
  },
  planRealtime(item) { return { key: 'message', payload: { name: item.mailId } }; },
  async deliver({ destination, payload }) {
    if (destination === 'realtime-chat' && ++realtimeAttempts === 1) throw new DeliveryError('network');
    const { name } = payload as { name: string };
    delivered.push(name);
    return `sent-${name}`;
  },
  async sendOperationalAlert(alert) { alerts.push(alert); }
};

const db = openDatabase(config);
const first = await runDailyDigest(config, db, gateway, notifier);
assert.equal(first.accounts[0]?.total, 3);
assert.deepEqual(digests, [first]);
assert.equal(first.total, 2);
assert.equal(first.counts.action, 1);
assert.equal(first.counts.fyi, 1);
assert.deepEqual(delivered, []);
assert.deepEqual(cursors, [null]);
assert.equal(messageFetches, 4);

const outcomes = db.prepare(`
  select gmail_id as gmailId, processing_outcome as processingOutcome
  from message_classifications
  order by gmail_id
`).all() as Array<{ gmailId: string; processingOutcome: string }>;
assert.deepEqual(outcomes, [
  { gmailId: 'action-1', processingOutcome: 'push_now' },
  { gmailId: 'fyi-1', processingOutcome: 'digest_only' },
  { gmailId: 'junk-1', processingOutcome: 'suppress' }
]);

const visible = listProcessedDigestItems(
  db,
  new Date(Date.now() - 60_000),
  new Date(Date.now() + 60_000)
);
assert.deepEqual(visible.map((item) => item.id).sort(), ['action-1', 'fyi-1']);

let now = Date.now();
const drain = createOutboxDrain(db, notifier, () => now);
await drain();
assert.deepEqual(delivered, [first.date]);
assert.equal(realtimeAttempts, 1);
assert.equal(getSyncCursor(db, 'primary'), 'cursor-200');

// Repeated digest generation and cursor replay should not replace queued work.
assert.equal((await queueTodayDigest(config, db, notifier)).date, first.date);

// Cursor replay returns the same ids, but SQLite dedup prevents refetch,
// reclassification and duplicate notifications.
const replay = await processUnreadMail(config, db, gateway, notifier);
assert.equal(replay[0]?.total, 0);
assert.deepEqual(cursors, [null, 'cursor-200']);
assert.equal(messageFetches, 5);
await drain();
assert.equal(realtimeAttempts, 1);
now += 15_000;
await drain();
assert.deepEqual(delivered, [first.date, 'primary:action-1']);
assert.equal(realtimeAttempts, 2);
assert.equal(messageFetches, 5);
const classificationCount = db.prepare('select count(*) as count from message_classifications').get() as { count: number };
assert.equal(classificationCount.count, 3);
assert.deepEqual(alerts, []);

const failingGateway: MailGateway = {
  ...gateway,
  async syncInboxMessages() { throw new Error('Gmail unavailable'); }
};
const failedAlertNotifier: Notifier = {
  ...notifier,
  async sendOperationalAlert() { throw new Error('Alert delivery unavailable'); }
};

const failure = await processUnreadMail(config, db, failingGateway, failedAlertNotifier);
assert.equal(failure[0]?.error, 'Gmail unavailable');
await processUnreadMail(config, db, failingGateway, notifier);
await processUnreadMail(config, db, failingGateway, notifier);
assert.deepEqual(alerts, [{
  kind: 'account-failure',
  signature: 'account-failed:primary|Gmail unavailable',
  accountName: 'Primary',
  accountEmail: 'me@example.com',
  detail: 'Gmail unavailable'
}]);
db.close();

const rollbackDb = openDatabase(config);
rollbackDb.exec(`
  create trigger reject_notification before insert on notification_outbox
  begin
    select raise(abort, 'Injected outbox write failure');
  end;
`);
const rollback = await processUnreadMail(config, rollbackDb, gateway, { ...notifier, alertCooldownMs: null });
assert.equal(rollback[0]?.error, 'Injected outbox write failure');
assert.equal(getSyncCursor(rollbackDb, 'primary'), null);
assert.deepEqual(rollbackDb.prepare('select gmail_id from messages').all(), []);
assert.deepEqual(rollbackDb.prepare('select gmail_id from email_body_cache').all(), []);
assert.deepEqual(rollbackDb.prepare('select gmail_id from message_classifications').all(), []);
rollbackDb.close();

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

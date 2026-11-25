import { loadConfig } from '../src/config.js';
import {
  createDigestRun,
  failDigestRun,
  finishDigestRun,
  openDatabase,
  saveClassification,
  saveEmailBodyCache,
  saveMessage
} from '../src/db.js';
import { sendDiscordRealtime } from '../src/discord.js';
import type { Classification, DigestItem, DiscordAppConfig, EmailMessage } from '../src/types.js';

const config = loadConfig();
if (config.messagingProvider !== 'discord') throw new Error('The follow-up dry run requires Discord');
const db = openDatabase(config);
const cleanupAccountId = cleanupTarget(process.argv.slice(2));

try {
  if (cleanupAccountId) {
    await cleanupDryRun(cleanupAccountId, config.discord.botToken);
  } else {
    await createDryRun(config);
  }
} finally {
  db.close();
}

async function createDryRun(config: DiscordAppConfig): Promise<void> {
  if (!config.followup.enabled) {
    throw new Error('FOLLOWUP_ENABLED must be true for the follow-up dry run');
  }
  if (!config.discord.realtimeChannelId) {
    throw new Error('DISCORD_REALTIME_CHANNEL_ID is required for the follow-up dry run');
  }

  const accountId = `followup-dryrun-${Date.now()}`;
  const accountEmail = 'followup-dryrun@example.com';
  const runId = createDigestRun(db, accountId, accountEmail, new Date());
  const fixtures = dryRunFixtures(accountId, accountEmail);

  try {
    for (const fixture of fixtures.allMessages) {
      saveMessage(db, accountEmail, fixture.email);
      saveEmailBodyCache(db, fixture.email);
      saveClassification(db, runId, fixture.email, fixture.classification, 'digest_only');
    }
    for (const fixture of fixtures.visibleMessages) {
      await sendDiscordRealtime(config, digestItem(fixture.email, fixture.classification));
    }
    finishDigestRun(db, runId, fixtures.allMessages.length);
  } catch (error) {
    failDigestRun(db, runId, error);
    throw error;
  }

  console.log(`Sent three follow-up dry-run scenarios for account ${accountId}`);
  console.log(`Cleanup after testing: npm run dry-run:followup -- --cleanup ${accountId}`);
}

async function cleanupDryRun(accountId: string, botToken: string): Promise<void> {
  const threadRows = db.prepare(`
    select discord_thread_id as threadId
    from followups
    where account_id = ? and discord_thread_id is not null
  `).all(accountId) as Array<{ threadId: string }>;

  for (const row of threadRows) {
    await deleteDiscordThread(row.threadId, botToken);
  }

  const counts = db.transaction(() => {
    const followups = db.prepare('delete from followups where account_id = ?').run(accountId).changes;
    const runs = db.prepare('delete from digest_runs where account_id = ?').run(accountId).changes;
    const messages = db.prepare('delete from messages where account_id = ?').run(accountId).changes;
    return { followups, runs, messages };
  })();
  console.log(
    `Cleaned follow-up dry run ${accountId}: `
    + `${counts.followups} follow-up(s), ${counts.runs} run(s), ${counts.messages} message(s)`
  );
}

async function deleteDiscordThread(threadId: string, botToken: string): Promise<void> {
  const response = await fetch(`https://discord.com/api/v10/channels/${threadId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bot ${botToken}`
    }
  });
  if (response.ok || response.status === 404) return;
  throw new Error(
    `Failed to delete Discord dry-run thread ${threadId}: ${response.status} ${await response.text()}`
  );
}

function cleanupTarget(args: string[]): string | null {
  const index = args.indexOf('--cleanup');
  if (index < 0) return null;
  const accountId = args[index + 1];
  if (!accountId || !/^followup-dryrun-\d+$/.test(accountId)) {
    throw new Error('--cleanup requires an exact followup-dryrun-<timestamp> account id');
  }
  return accountId;
}

function dryRunFixtures(
  accountId: string,
  accountEmail: string
): {
  allMessages: Array<{ email: EmailMessage; classification: Classification }>;
  visibleMessages: Array<{ email: EmailMessage; classification: Classification }>;
} {
  const conversationStart = fixture(
    accountId,
    accountEmail,
    'conversation-start',
    'conversation-thread',
    'Contract renewal discussion',
    'Client <client@example.com>',
    'Could you review the renewal terms before Tuesday? https://docs.google.com/document/d/renewal/edit',
    'The client asked for a contract renewal review before Tuesday.',
    ['The proposed term is twelve months.', 'The client expects a response before Tuesday.'],
    ['Review the renewal document.', 'Reply with requested changes.'],
    'action',
    new Date(Date.now() - 60 * 60 * 1000)
  );
  const conversationReply = fixture(
    accountId,
    accountEmail,
    'conversation-reply',
    'conversation-thread',
    'Re: Contract renewal discussion',
    'Me <followup-dryrun@example.com>',
    'I reviewed the terms and asked whether the payment window can be extended.',
    'A payment-window question is waiting for the client response.',
    ['The requested payment window is not yet confirmed.'],
    ['Wait for the client response.'],
    'action',
    new Date(Date.now() - 30 * 60 * 1000)
  );
  const todo = fixture(
    accountId,
    accountEmail,
    'todo-bill',
    'todo-thread',
    'Electricity bill due Friday',
    'Utility <billing@example.com>',
    'Your electricity bill is due this Friday. Pay at https://example.com/pay/bill',
    'The electricity bill is due Friday.',
    ['The payment deadline is Friday.'],
    ['Pay the electricity bill.'],
    'admin',
    new Date()
  );
  const readLater = fixture(
    accountId,
    accountEmail,
    'read-later-blog',
    'read-later-thread',
    'A practical guide to SQLite WAL',
    'Database Weekly <newsletter@example.com>',
    'This issue explains WAL checkpoints and trade-offs. Read at https://example.com/blog/sqlite-wal',
    'A practical article explains SQLite WAL checkpoints and trade-offs.',
    ['The article includes operational checkpoint guidance.'],
    ['Read the article when convenient.'],
    'fyi',
    new Date()
  );
  return {
    allMessages: [conversationStart, conversationReply, todo, readLater],
    visibleMessages: [conversationStart, todo, readLater]
  };
}

function fixture(
  accountId: string,
  accountEmail: string,
  id: string,
  threadId: string,
  subject: string,
  from: string,
  text: string,
  summary: string,
  attentionPoints: string[],
  suggestedActions: string[],
  category: Classification['category'],
  date: Date
): { email: EmailMessage; classification: Classification } {
  return {
    email: {
      accountId,
      accountEmail,
      id,
      threadId,
      labelIds: ['INBOX'],
      headers: [],
      subject,
      from,
      date,
      snippet: text.slice(0, 180),
      text,
      gmailUrl: 'https://mail.google.com/'
    },
    classification: {
      category,
      importance: category === 'action' ? 90 : 70,
      summary,
      attentionPoints,
      suggestedActions,
      confidence: 1,
      provider: 'followup-dry-run',
      reason: 'Synthetic follow-up scenario'
    }
  };
}

function digestItem(email: EmailMessage, classification: Classification): DigestItem {
  return {
    accountId: email.accountId,
    accountName: 'Follow-up Dry Run',
    mailId: `${email.accountId}:${email.id}`,
    id: email.id,
    category: classification.category,
    from: email.from,
    subject: email.subject,
    summary: classification.summary,
    attentionPoints: classification.attentionPoints,
    suggestedActions: classification.suggestedActions,
    importance: classification.importance,
    confidence: classification.confidence,
    provider: classification.provider,
    processingOutcome: 'digest_only',
    gmailUrl: email.gmailUrl
  };
}

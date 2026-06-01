import { loadConfig } from '../src/config.js';
import { createDigestRun, openDatabase, saveClassification, saveEmailBodyCache, saveMessage } from '../src/db.js';
import { sendDiscordRealtime } from '../src/discord.js';
import type { DigestItem, EmailMessage } from '../src/types.js';

const config = loadConfig();
const db = openDatabase(config);
const now = new Date();
const id = `dryrun-${Date.now()}`;
const accountId = 'dryrun';
const accountEmail = 'dryrun@example.com';
const gmailUrl = 'https://mail.google.com/';

const email: EmailMessage = {
  accountId,
  accountEmail,
  id,
  threadId: id,
  labelIds: [],
  headers: [],
  subject: 'Hedwig preview dry run',
  from: 'Hedwig Dry Run <dryrun@example.com>',
  date: now,
  snippet: 'This is a dry-run email used to verify Discord preview buttons.',
  text: [
    'This is a dry-run email body cached in SQLite.',
    'It verifies that clicking 查看内容 returns an ephemeral preview without touching Gmail.',
    'Important link: https://example.com/hedwig-preview-test'
  ].join('\n'),
  gmailUrl
};

const runId = createDigestRun(db, accountId, accountEmail, now);
const classification = {
  category: 'action' as const,
  importance: 90,
  summary: 'Dry-run preview test with one important link.',
  confidence: 1,
  provider: 'dry-run',
  reason: 'Manual preview button test'
};

saveMessage(db, accountEmail, email);
saveEmailBodyCache(db, email);
saveClassification(db, runId, email, classification, 'push_now');

const item: DigestItem = {
  accountId,
  accountName: 'Dry Run',
  mailId: `${accountId}:${id}`,
  id,
  category: 'action',
  from: email.from,
  subject: email.subject,
  summary: classification.summary,
  importance: classification.importance,
  confidence: classification.confidence,
  provider: classification.provider,
  processedAs: 'push_now',
  gmailUrl
};

await sendDiscordRealtime(config, item);
console.log(`Sent Discord preview dry run for mail_id ${item.mailId}`);

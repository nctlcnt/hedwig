import { DateTime } from 'luxon';
import { categories, categoryOrder } from './classifier.js';
import { createClassifier } from './classifiers.js';
import {
  createDigestRun,
  failDigestRun,
  findProcessedGmailIds,
  finishDigestRun,
  listProcessedDigestItems,
  saveEmailBodyCache,
  saveClassification,
  saveMessage,
  updateDigestRunAccount
} from './db.js';
import { sendDiscordClassifierAlert, sendDiscordDigest, sendDiscordRealtime } from './discord.js';
import { summarizeSections } from './llm/section-narrator.js';
import type {
  AppConfig,
  Category,
  Classification,
  ClassifierFailure,
  DigestAccountSummary,
  DigestItem,
  DigestReport,
  EmailMessage,
  ProcessingAction
} from './types.js';
import type { HedwigDb } from './db.js';
import type { MailAccount, MailGateway } from './gateway/mail-gateway.js';

type AccountProcessResult = {
  runId: number;
  accountId: string;
  accountName: string;
  accountEmail: string;
  counts: Record<Category, number>;
  total: number;
  error?: string;
};

// What Hedwig does to a message in Gmail after processing it. Dedup is tracked
// in the database (see findProcessedGmailIds), so the default leaves the message
// untouched: still unread, still in the inbox, for the user to triage by hand.
type SideEffects = {
  markRead: boolean;
  archiveUnstarred: boolean;
};

const PASSIVE_SIDE_EFFECTS: SideEffects = { markRead: false, archiveUnstarred: false };
// Backfill drains a large unread backlog; it still marks read so successive runs
// can page past what it already handled. It leaves mail in the inbox.
const BACKFILL_SIDE_EFFECTS: SideEffects = { markRead: true, archiveUnstarred: false };

export async function runDailyDigest(config: AppConfig, db: HedwigDb, mailGateway: MailGateway): Promise<DigestReport> {
  const results = await processUnreadMail(config, db, mailGateway);
  return sendTodayDigest(config, db, results);
}

export async function processUnreadMail(
  config: AppConfig,
  db: HedwigDb,
  mailGateway: MailGateway
): Promise<AccountProcessResult[]> {
  const results: AccountProcessResult[] = [];

  for (const account of mailGateway.listAccounts()) {
    results.push(await processAccountUnreadMail(config, account, mailGateway, db));
  }

  return results;
}

export async function backfillUnreadMail(
  config: AppConfig,
  db: HedwigDb,
  mailGateway: MailGateway,
  limitPerAccount: number
): Promise<AccountProcessResult[]> {
  const results: AccountProcessResult[] = [];

  for (const account of mailGateway.listAccounts()) {
    results.push(await backfillAccountUnreadMail(config, account, mailGateway, db, limitPerAccount));
  }

  return results;
}

export async function sendTodayDigest(
  config: AppConfig,
  db: HedwigDb,
  results: AccountProcessResult[] = []
): Promise<DigestReport> {
  const window = todayWindow(config);
  const items = listProcessedDigestItems(db, window.start, window.end);
  const digest = await buildDigest(config, items, results);
  await sendDiscordDigest(config, digest);
  return digest;
}

async function processAccountUnreadMail(
  config: AppConfig,
  accountConfig: MailAccount,
  mailGateway: MailGateway,
  db: HedwigDb
): Promise<AccountProcessResult> {
  return runAccountClassificationPass(config, accountConfig, mailGateway, db, PASSIVE_SIDE_EFFECTS, async () => (
    mailGateway.listRecentInboxMessages(accountConfig, {
      ...config.digest,
      unreadOnly: true
    })
  ));
}

async function backfillAccountUnreadMail(
  config: AppConfig,
  accountConfig: MailAccount,
  mailGateway: MailGateway,
  db: HedwigDb,
  limit: number
): Promise<AccountProcessResult> {
  return runAccountClassificationPass(config, accountConfig, mailGateway, db, BACKFILL_SIDE_EFFECTS, async () => (
    mailGateway.listUnreadInboxMessages(accountConfig, { limit })
  ));
}

async function runAccountClassificationPass(
  config: AppConfig,
  accountConfig: MailAccount,
  mailGateway: MailGateway,
  db: HedwigDb,
  sideEffects: SideEffects,
  fetchRefs: () => Promise<{ id?: string | null }[]>
): Promise<AccountProcessResult> {
  let account = accountConfig.displayName;
  const runId = createDigestRun(db, accountConfig.id, account, new Date());
  const counts = zeroCounts();
  const classifier = createClassifier(config);
  const classifierFailures: ClassifierFailure[] = [];

  try {
    account = await mailGateway.getCurrentUser(accountConfig);
    updateDigestRunAccount(db, runId, account);
    const refs = await fetchRefs();
    const candidateIds = refs.map((ref) => ref.id).filter((id): id is string => Boolean(id));
    const alreadyProcessed = findProcessedGmailIds(db, accountConfig.id, candidateIds);

    for (const ref of refs) {
      if (!ref.id) continue;
      if (alreadyProcessed.has(ref.id)) continue;
      const email = await mailGateway.getMessage(accountConfig, account, ref.id);
      if (email.labelIds.includes('SPAM') || email.labelIds.includes('TRASH')) {
        continue;
      }

      const classification = await classifier.classify(email);
      const processedAs = processingAction(classification.category);

      if (classification.provider === 'rule-fallback') {
        classifierFailures.push({
          from: email.from,
          subject: email.subject,
          gmailUrl: email.gmailUrl,
          reason: classification.reason || 'classifier unavailable'
        });
      }

      // Junk (incl. one-time codes) always leaves the inbox; other categories
      // only when archive-everything is on. Starred mail always stays.
      const archive = !shouldKeepInInbox(email)
        && (processedAs === 'archive' || sideEffects.archiveUnstarred);
      if (archive) {
        await mailGateway.removeFromInbox(accountConfig, [email.id]);
      }
      if (processedAs === 'push_now') {
        await sendDiscordRealtime(config, digestItem(accountConfig, account, email, classification, processedAs));
      }

      saveMessage(db, account, email);
      saveEmailBodyCache(db, email);
      saveClassification(db, runId, email, classification, processedAs);
      if (sideEffects.markRead) {
        await mailGateway.markMessagesRead(accountConfig, [email.id]);
      }
      counts[classification.category] += 1;
    }

    await notifyClassifierFailures(config, account, classifierFailures);

    const total = totalCount(counts);
    finishDigestRun(db, runId, total);
    return {
      runId,
      accountId: accountConfig.id,
      accountName: accountConfig.displayName,
      accountEmail: account,
      counts,
      total
    };
  } catch (error) {
    failDigestRun(db, runId, error);
    return {
      runId,
      accountId: accountConfig.id,
      accountName: accountConfig.displayName,
      accountEmail: account,
      counts,
      total: totalCount(counts),
      error: errorMessage(error)
    };
  }
}

async function notifyClassifierFailures(
  config: AppConfig,
  account: string,
  failures: ClassifierFailure[]
): Promise<void> {
  if (failures.length === 0) return;
  try {
    await sendDiscordClassifierAlert(config, account, failures);
  } catch (error) {
    // An alert failure must not fail the whole run; the mail is already saved.
    console.error('Failed to post classifier failure alert', error);
  }
}

function digestItem(
  accountConfig: MailAccount,
  account: string,
  email: EmailMessage,
  classification: Classification,
  processedAs: ProcessingAction
): DigestItem {
  return {
    accountId: accountConfig.id,
    accountName: accountConfig.displayName || account,
    mailId: `${accountConfig.id}:${email.id}`,
    id: email.id,
    category: classification.category,
    from: email.from,
    subject: email.subject,
    summary: classification.summary,
    importance: classification.importance,
    confidence: classification.confidence,
    provider: classification.provider,
    processedAs,
    gmailUrl: email.gmailUrl
  };
}

function processingAction(category: Category): ProcessingAction {
  if (category === 'junk') return 'archive';
  if (category === 'action') return 'push_now';
  return 'digest_only';
}

function shouldKeepInInbox(email: EmailMessage): boolean {
  return email.labelIds.includes('STARRED');
}

function emptyGroups(): Record<Category, DigestItem[]> {
  return Object.fromEntries(categoryOrder().map((category) => [category, []])) as unknown as Record<Category, DigestItem[]>;
}

async function buildDigest(config: AppConfig, items: DigestItem[], results: AccountProcessResult[]): Promise<DigestReport> {
  const grouped = groupItems(items);
  for (const category of categoryOrder()) {
    grouped[category].sort((a, b) => b.importance - a.importance);
  }
  const counts = groupCounts(grouped);
  const total = totalCount(counts);
  const leads = total > 0 ? await summarizeSections(config, grouped) : blankLeads();
  const metadata = categories();
  const sections = categoryOrder().map((category) => ({
    category,
    title: metadata[category].title,
    items: grouped[category],
    lead: leads[category] || ''
  }));

  const accounts = results.map(toAccountSummary);

  return {
    runIds: results.map((result) => result.runId),
    account: accounts.length > 0 ? accounts.map((item) => `${item.accountName} <${item.accountEmail}>`).join(', ') : 'processed mail',
    date: todayWindow(config).date,
    total,
    counts,
    accounts,
    sections
  };
}

function blankLeads(): Record<Category, string> {
  return Object.fromEntries(categoryOrder().map((category) => [category, ''])) as Record<Category, string>;
}

function groupItems(items: DigestItem[]): Record<Category, DigestItem[]> {
  const grouped = emptyGroups();
  for (const item of items) {
    grouped[item.category].push(item);
  }
  return grouped;
}

function groupCounts(grouped: Record<Category, DigestItem[]>): Record<Category, number> {
  return Object.fromEntries(
    categoryOrder().map((category) => [category, grouped[category].length])
  ) as Record<Category, number>;
}

function zeroCounts(): Record<Category, number> {
  return Object.fromEntries(categoryOrder().map((category) => [category, 0])) as Record<Category, number>;
}

function totalCount(counts: Record<Category, number>): number {
  return categoryOrder().reduce((sum, category) => sum + counts[category], 0);
}

function toAccountSummary(result: AccountProcessResult): DigestAccountSummary {
  return {
    accountId: result.accountId,
    accountName: result.accountName,
    accountEmail: result.accountEmail,
    runId: result.runId,
    total: result.total,
    counts: result.counts,
    error: result.error
  };
}

function todayWindow(config: AppConfig): { date: string; start: Date; end: Date } {
  const now = DateTime.now().setZone(config.digest.timezone);
  const start = now.startOf('day');
  return {
    date: now.toISODate() || new Date().toISOString().slice(0, 10),
    start: start.toUTC().toJSDate(),
    end: start.plus({ days: 1 }).toUTC().toJSDate()
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

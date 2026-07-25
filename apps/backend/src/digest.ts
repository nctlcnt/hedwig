import { DateTime } from 'luxon';
import { categories, categoryOrder } from './classifier.js';
import { createClassifier } from './classifiers.js';
import {
  createDigestRun,
  failDigestRun,
  findProcessedGmailIds,
  finishDigestRun,
  getSummaryLanguage,
  getSyncCursor,
  listProcessedDigestItems,
  saveEmailBodyCache,
  saveClassification,
  saveMessage,
  setSyncCursor,
  updateDigestRunAccount
} from './db.js';
import { reportProblem } from './alerts.js';
import { buildClassifierFailureAlert, sendDiscordDigest, sendDiscordRealtime } from './discord.js';
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
  ProcessingOutcome
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

export async function sendTodayDigest(
  config: AppConfig,
  db: HedwigDb,
  results: AccountProcessResult[] = []
): Promise<DigestReport> {
  const window = todayWindow(config);
  const items = listProcessedDigestItems(db, window.start, window.end);
  const digest = await buildDigest(config, items, results, getSummaryLanguage(db));
  await sendDiscordDigest(config, digest);
  return digest;
}

async function processAccountUnreadMail(
  config: AppConfig,
  accountConfig: MailAccount,
  mailGateway: MailGateway,
  db: HedwigDb
): Promise<AccountProcessResult> {
  const startCursor = getSyncCursor(db, accountConfig.id);
  let nextCursor: string | null = null;

  const result = await runAccountClassificationPass(config, accountConfig, mailGateway, db, async () => {
    const sync = await mailGateway.syncInboxMessages(accountConfig, {
      cursor: startCursor,
      lookbackHours: config.digest.lookbackHours,
      maxMessages: config.digest.maxMessages
    });
    nextCursor = sync.cursor;
    if (sync.reset) {
      console.info(`[${accountConfig.id}] history cursor ${startCursor ? 'expired' : 'absent'}; bootstrapped from recent inbox window`);
    }
    return sync.refs;
  });

  // Only advance the cursor once the batch processed cleanly. On failure we keep
  // the old cursor so the next run re-syncs the same range; the DB dedup keeps
  // already-handled messages from being processed twice.
  if (!result.error && nextCursor) {
    setSyncCursor(db, accountConfig.id, nextCursor);
  }
  return result;
}

async function runAccountClassificationPass(
  config: AppConfig,
  accountConfig: MailAccount,
  mailGateway: MailGateway,
  db: HedwigDb,
  fetchRefs: () => Promise<{ id?: string | null }[]>
): Promise<AccountProcessResult> {
  let account = accountConfig.displayName;
  const runId = createDigestRun(db, accountConfig.id, account, new Date());
  const counts = zeroCounts();
  const classifier = createClassifier(config, getSummaryLanguage(db));
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
      const processingOutcome = processingOutcomeFor(classification.category);

      if (classification.provider === 'rule-fallback') {
        classifierFailures.push({
          from: email.from,
          subject: email.subject,
          gmailUrl: email.gmailUrl,
          reason: classification.reason || 'classifier unavailable'
        });
      }

      saveMessage(db, account, email);
      saveEmailBodyCache(db, email);
      saveClassification(db, runId, email, classification, processingOutcome);

      if (processingOutcome === 'push_now') {
        await sendDiscordRealtime(config, digestItem(accountConfig, account, email, classification, processingOutcome));
      }
      counts[classification.category] += 1;
    }

    await notifyClassifierFailures(config, db, account, classifierFailures);

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
    await reportProblem(config, db, {
      signature: `account-failed:${accountConfig.id}|${errorMessage(error).slice(0, 120)}`,
      title: `账号处理失败：${accountConfig.displayName}`,
      detail: `账号 **${accountConfig.displayName}** (${account}) 本轮处理失败：\n${errorMessage(error)}`
    });
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
  db: HedwigDb,
  account: string,
  failures: ClassifierFailure[]
): Promise<void> {
  if (failures.length === 0) return;
  // reportProblem is itself best-effort and never throws, so a failed alert
  // cannot fail the run; the mail is already saved.
  await reportProblem(config, db, buildClassifierFailureAlert(account, failures));
}

function digestItem(
  accountConfig: MailAccount,
  account: string,
  email: EmailMessage,
  classification: Classification,
  processingOutcome: ProcessingOutcome
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
    attentionPoints: classification.attentionPoints,
    suggestedActions: classification.suggestedActions,
    importance: classification.importance,
    confidence: classification.confidence,
    provider: classification.provider,
    processingOutcome,
    gmailUrl: email.gmailUrl
  };
}

function processingOutcomeFor(category: Category): ProcessingOutcome {
  if (category === 'junk') return 'suppress';
  if (category === 'action') return 'push_now';
  return 'digest_only';
}

function emptyGroups(): Record<Category, DigestItem[]> {
  return Object.fromEntries(categoryOrder().map((category) => [category, []])) as unknown as Record<Category, DigestItem[]>;
}

async function buildDigest(
  config: AppConfig,
  items: DigestItem[],
  results: AccountProcessResult[],
  summaryLanguage: string | null
): Promise<DigestReport> {
  const grouped = groupItems(items);
  for (const category of categoryOrder()) {
    grouped[category].sort((a, b) => b.importance - a.importance);
  }
  const counts = groupCounts(grouped);
  const total = totalCount(counts);
  const leads = total > 0 ? await summarizeSections(config, grouped, summaryLanguage) : blankLeads();
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

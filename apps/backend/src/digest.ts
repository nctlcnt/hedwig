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
import { problemMessage, reportProblem } from './alerts.js';
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
import type { Notifier } from './notifications/notifier.js';
import { enqueueNotification } from './notifications/outbox-store.js';

type AccountProcessResult = {
  runId: number;
  accountId: string;
  accountName: string;
  accountEmail: string;
  counts: Record<Category, number>;
  total: number;
  error?: string;
};

export async function runDailyDigest(
  config: AppConfig,
  db: HedwigDb,
  mailGateway: MailGateway,
  notifier: Notifier
): Promise<DigestReport> {
  const results = await processUnreadMail(config, db, mailGateway, notifier);
  return queueTodayDigest(config, db, notifier, results);
}

export async function processUnreadMail(
  config: AppConfig,
  db: HedwigDb,
  mailGateway: MailGateway,
  notifier: Notifier
): Promise<AccountProcessResult[]> {
  const results: AccountProcessResult[] = [];

  for (const account of mailGateway.listAccounts()) {
    results.push(await processAccountUnreadMail(config, account, mailGateway, db, notifier));
  }

  return results;
}

export async function queueTodayDigest(
  config: AppConfig,
  db: HedwigDb,
  notifier: Notifier,
  results: AccountProcessResult[] = []
): Promise<DigestReport> {
  const digest = readTodayDigest(db, config.digest.timezone, results);
  if (notifier.platform !== 'telegram' && digest.total > 0) {
    const leads = await summarizeSections(config, groupItems(digest.sections.flatMap((section) => section.items)), getSummaryLanguage(db));
    for (const section of digest.sections) section.lead = leads[section.category] || '';
  }
  db.transaction(() => {
    enqueueNotification(db, notifier, 'digest', digest.date, notifier.planDigest(digest));
  }).immediate();
  return digest;
}

export function readTodayDigest(
  db: HedwigDb,
  timezone: string,
  results: AccountProcessResult[] = []
): DigestReport {
  const window = todayWindow(timezone);
  const items = listProcessedDigestItems(db, window.start, window.end);
  return buildDigest(window.date, items, results);
}

async function processAccountUnreadMail(
  config: AppConfig,
  accountConfig: MailAccount,
  mailGateway: MailGateway,
  db: HedwigDb,
  notifier: Notifier
): Promise<AccountProcessResult> {
  const startCursor = getSyncCursor(db, accountConfig.id);
  let nextCursor: string | null = null;

  const result = await runAccountClassificationPass(config, accountConfig, mailGateway, db, notifier, async () => {
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
  notifier: Notifier,
  fetchRefs: () => Promise<{ id?: string | null }[]>
): Promise<AccountProcessResult> {
  let account = accountConfig.displayName;
  const runId = createDigestRun(db, accountConfig.id, account, new Date());
  const counts = zeroCounts();
  const classifier = createClassifier(config, getSummaryLanguage(db));
  const classifierFailures: ClassifierFailure[] = [];
  const saveProcessedEmail = db.transaction((
    email: EmailMessage,
    classification: Classification,
    processingOutcome: ProcessingOutcome
  ): boolean => {
    // Another pass may have stored this mail while this pass was classifying it.
    if (findProcessedGmailIds(db, accountConfig.id, [email.id]).has(email.id)) return false;
    saveMessage(db, account, email);
    saveEmailBodyCache(db, email);
    saveClassification(db, runId, email, classification, processingOutcome);
    if (processingOutcome === 'push_now' && notifier.realtimeDestination) {
      const item = digestItem(accountConfig, account, email, classification, processingOutcome);
      enqueueNotification(db, notifier, 'realtime', item.mailId, [notifier.planRealtime(item)]);
    }
    return true;
  });

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
      if (!email) continue;
      if (email.labelIds.includes('SPAM') || email.labelIds.includes('TRASH')) {
        continue;
      }

      const classification = await classifier.classify(email);
      const processingOutcome = processingOutcomeFor(classification.category);
      const stored = saveProcessedEmail.immediate(email, classification, processingOutcome);
      alreadyProcessed.add(ref.id);
      if (!stored) continue;

      if (classification.provider === 'rule-fallback') {
        classifierFailures.push({
          from: email.from,
          subject: email.subject,
          gmailUrl: email.gmailUrl,
          reason: classification.reason || 'classifier unavailable'
        });
      }

      counts[classification.category] += 1;
    }

    await notifyClassifierFailures(notifier, db, account, classifierFailures);

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
    const detail = problemMessage(error);
    await reportProblem(notifier, db, {
      kind: 'account-failure',
      signature: `account-failed:${accountConfig.id}|${detail.slice(0, 120)}`,
      accountName: accountConfig.displayName,
      accountEmail: account,
      detail
    });
    return {
      runId,
      accountId: accountConfig.id,
      accountName: accountConfig.displayName,
      accountEmail: account,
      counts,
      total: totalCount(counts),
      error: detail
    };
  }
}

async function notifyClassifierFailures(
  notifier: Notifier,
  db: HedwigDb,
  account: string,
  failures: ClassifierFailure[]
): Promise<void> {
  if (failures.length === 0) return;
  const reasons = [...new Set(failures.map((failure) => failure.reason).filter(Boolean))].slice(0, 3);
  await reportProblem(notifier, db, {
    kind: 'classifier-fallback',
    signature: `classifier-fallback|${reasons.join(' / ')}`,
    account,
    failures,
    reasons
  });
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

function buildDigest(
  date: string,
  items: DigestItem[],
  results: AccountProcessResult[]
): DigestReport {
  const grouped = groupItems(items);
  for (const category of categoryOrder()) {
    grouped[category].sort((a, b) => b.importance - a.importance);
  }
  const counts = groupCounts(grouped);
  const total = totalCount(counts);
  const metadata = categories();
  const sections = categoryOrder().map((category) => ({
    category,
    title: metadata[category].title,
    items: grouped[category],
    lead: ''
  }));

  const accounts = results.map(toAccountSummary);

  return {
    runIds: results.map((result) => result.runId),
    account: accounts.length > 0 ? accounts.map((item) => `${item.accountName} <${item.accountEmail}>`).join(', ') : 'processed mail',
    date,
    total,
    counts,
    accounts,
    sections
  };
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

function todayWindow(timezone: string): { date: string; start: Date; end: Date } {
  const now = DateTime.now().setZone(timezone);
  const start = now.startOf('day');
  return {
    date: now.toISODate() || new Date().toISOString().slice(0, 10),
    start: start.toUTC().toJSDate(),
    end: start.plus({ days: 1 }).toUTC().toJSDate()
  };
}

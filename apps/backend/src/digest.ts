import { DateTime } from 'luxon';
import { categories, categoryOrder } from './classifier.js';
import { createClassifier } from './classifiers.js';
import {
  createDigestRun,
  failDigestRun,
  finishDigestRun,
  saveClassification,
  saveMessage,
  updateDigestRunAccount
} from './db.js';
import { sendDiscordDigest } from './discord.js';
import type {
  AppConfig,
  Category,
  DigestAccountSummary,
  DigestItem,
  DigestReport
} from './types.js';
import type { HedwigDb } from './db.js';
import type { MailAccount, MailGateway } from './mail-gateway.js';

type AccountDigestResult = {
  runId: number;
  accountId: string;
  accountName: string;
  accountEmail: string;
  grouped: Record<Category, DigestItem[]>;
  counts: Record<Category, number>;
  total: number;
  error?: string;
};

export async function runDailyDigest(config: AppConfig, mailGateway: MailGateway, db: HedwigDb): Promise<DigestReport> {
  const results: AccountDigestResult[] = [];

  for (const account of await mailGateway.listAccounts()) {
    results.push(await runAccountDigest(config, account, mailGateway, db));
  }

  const digest = buildDigest(config, results);
  await sendDiscordDigest(config, digest);
  return digest;
}

async function runAccountDigest(
  config: AppConfig,
  accountConfig: MailAccount,
  mailGateway: MailGateway,
  db: HedwigDb
): Promise<AccountDigestResult> {
  let account = accountConfig.displayName;
  const runId = createDigestRun(db, accountConfig.id, account, new Date());
  const grouped = emptyGroups();
  const classifier = createClassifier(config);
  const digestedMessageIds: string[] = [];

  try {
    account = (await mailGateway.getCurrentUserProfile(accountConfig)).emailAddress;
    updateDigestRunAccount(db, runId, account);
    const labelIds = await mailGateway.ensureAutoLabels(accountConfig);
    const refs = await mailGateway.listRecentInboxMessages(accountConfig, config.digest);
    const categoryLabelIds = Object.values(categories())
      .map((category) => labelIds.get(category.label))
      .filter((id): id is string => Boolean(id));

    for (const ref of refs) {
      if (!ref.id) continue;
      const email = await mailGateway.getMessage(accountConfig, account, ref.id);
      if (email.labelIds.includes('SPAM') || email.labelIds.includes('TRASH')) {
        continue;
      }

      const classification = await classifier.classify(email);
      const selectedLabelId = labelIds.get(classification.gmailLabel);
      if (!selectedLabelId) {
        throw new Error(`Missing Gmail label id for ${classification.gmailLabel}`);
      }
      await mailGateway.applyLabel(
        accountConfig,
        email.id,
        selectedLabelId,
        categoryLabelIds.filter((id) => id !== selectedLabelId)
      );
      saveMessage(db, account, email);
      saveClassification(db, runId, email, classification);
      digestedMessageIds.push(email.id);

      grouped[classification.category].push({
        accountId: accountConfig.id,
        accountName: accountConfig.displayName,
        id: email.id,
        from: email.from,
        subject: email.subject,
        summary: classification.summary,
        importance: classification.importance,
        confidence: classification.confidence,
        provider: classification.provider,
        gmailUrl: email.gmailUrl
      });
    }

    await mailGateway.markMessagesRead(accountConfig, digestedMessageIds);
    const counts = groupCounts(grouped);
    const total = totalCount(counts);
    finishDigestRun(db, runId, total);
    return {
      runId,
      accountId: accountConfig.id,
      accountName: accountConfig.displayName,
      accountEmail: account,
      grouped,
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
      grouped,
      counts: groupCounts(grouped),
      total: totalCount(groupCounts(grouped)),
      error: errorMessage(error)
    };
  }
}

function emptyGroups(): Record<Category, DigestItem[]> {
  return Object.fromEntries(categoryOrder().map((category) => [category, []])) as unknown as Record<Category, DigestItem[]>;
}

function buildDigest(config: AppConfig, results: AccountDigestResult[]): DigestReport {
  const grouped = mergeGroups(results);
  const metadata = categories();
  const sections = categoryOrder().map((category) => ({
    category,
    title: metadata[category].title,
    items: grouped[category].sort((a, b) => b.importance - a.importance)
  }));

  const counts = groupCounts(grouped);
  const accounts = results.map(toAccountSummary);

  return {
    runIds: results.map((result) => result.runId),
    account: accounts.map((item) => `${item.accountName} <${item.accountEmail}>`).join(', '),
    date: DateTime.now().setZone(config.digest.timezone).toISODate() || new Date().toISOString().slice(0, 10),
    total: totalCount(counts),
    counts,
    accounts,
    sections
  };
}

function mergeGroups(results: AccountDigestResult[]): Record<Category, DigestItem[]> {
  const grouped = emptyGroups();
  for (const result of results) {
    for (const category of categoryOrder()) {
      grouped[category].push(...result.grouped[category]);
    }
  }
  return grouped;
}

function groupCounts(grouped: Record<Category, DigestItem[]>): Record<Category, number> {
  return Object.fromEntries(
    categoryOrder().map((category) => [category, grouped[category].length])
  ) as Record<Category, number>;
}

function totalCount(counts: Record<Category, number>): number {
  return categoryOrder().reduce((sum, category) => sum + counts[category], 0);
}

function toAccountSummary(result: AccountDigestResult): DigestAccountSummary {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

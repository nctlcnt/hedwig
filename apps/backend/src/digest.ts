import { DateTime } from 'luxon';
import { categories, categoryOrder } from './classifier.js';
import { createClassifier } from './classifiers.js';
import { createDigestRun, failDigestRun, finishDigestRun, saveClassification, saveMessage } from './db.js';
import {
  applyLabel,
  ensureAutoLabels,
  getCurrentUser,
  getMessage,
  listRecentInboxMessages
} from './gmail.js';
import { sendDiscordDigest } from './discord.js';
import type { AppConfig, Category, DigestItem, DigestReport, GmailClient } from './types.js';
import type { HedwigDb } from './db.js';

export async function runDailyDigest(config: AppConfig, gmail: GmailClient, db: HedwigDb): Promise<DigestReport> {
  const account = await getCurrentUser(gmail);
  const runId = createDigestRun(db, account, new Date());
  const labelIds = await ensureAutoLabels(gmail);
  const refs = await listRecentInboxMessages(gmail, config.digest);
  const grouped = emptyGroups();
  const categoryLabelIds = Object.values(categories())
    .map((category) => labelIds.get(category.label))
    .filter((id): id is string => Boolean(id));
  const classifier = createClassifier(config);

  try {
    for (const ref of refs) {
      if (!ref.id) continue;
      const email = await getMessage(gmail, ref.id);
      if (email.labelIds.includes('SPAM') || email.labelIds.includes('TRASH')) {
        continue;
      }

      const classification = await classifier.classify(email);
      const selectedLabelId = labelIds.get(classification.gmailLabel);
      if (!selectedLabelId) {
        throw new Error(`Missing Gmail label id for ${classification.gmailLabel}`);
      }
      await applyLabel(
        gmail,
        email.id,
        selectedLabelId,
        categoryLabelIds.filter((id) => id !== selectedLabelId)
      );
      saveMessage(db, account, email);
      saveClassification(db, runId, email, classification);

      grouped[classification.category].push({
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

    const digest = buildDigest(config, runId, account, grouped);
    await sendDiscordDigest(config, digest);
    finishDigestRun(db, runId, digest.total);
    return digest;
  } catch (error) {
    failDigestRun(db, runId, error);
    throw error;
  }
}

function emptyGroups(): Record<Category, DigestItem[]> {
  return Object.fromEntries(categoryOrder().map((category) => [category, []])) as unknown as Record<Category, DigestItem[]>;
}

function buildDigest(
  config: AppConfig,
  runId: number,
  account: string,
  grouped: Record<Category, DigestItem[]>
): DigestReport {
  const metadata = categories();
  const sections = categoryOrder().map((category) => ({
    category,
    title: metadata[category].title,
    items: grouped[category].sort((a, b) => b.importance - a.importance)
  }));

  const counts = Object.fromEntries(
    categoryOrder().map((category) => [category, grouped[category].length])
  ) as Record<Category, number>;

  return {
    runId,
    account,
    date: DateTime.now().setZone(config.digest.timezone).toISODate() || new Date().toISOString().slice(0, 10),
    total: categoryOrder().reduce((sum, category) => sum + counts[category], 0),
    counts,
    sections
  };
}

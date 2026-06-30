import { listCleanupCandidates, recordTrashed } from './db.js';
import type { AppConfig, Category, CleanupCandidate, CleanupConfig } from './types.js';
import type { HedwigDb } from './db.js';
import type { MailAccount, MailGateway } from './gateway/mail-gateway.js';

export type CleanupSkips = {
  starred: number;
  followup: number;
  alreadyTrashed: number;
  missing: number;
};

export type CleanupAccountResult = {
  accountId: string;
  accountName: string;
  accountEmail: string;
  applied: boolean;
  candidates: number;
  // In dry-run these are the messages that would be trashed; in apply mode the
  // ones that were actually trashed.
  trashed: CleanupCandidate[];
  skipped: CleanupSkips;
  error?: string;
};

export async function runCleanup(
  config: AppConfig,
  db: HedwigDb,
  mailGateway: MailGateway,
  options: { apply: boolean }
): Promise<CleanupAccountResult[]> {
  const results: CleanupAccountResult[] = [];
  for (const account of mailGateway.listAccounts()) {
    results.push(await cleanupAccount(config, account, mailGateway, db, options));
  }
  return results;
}

async function cleanupAccount(
  config: AppConfig,
  account: MailAccount,
  mailGateway: MailGateway,
  db: HedwigDb,
  { apply }: { apply: boolean }
): Promise<CleanupAccountResult> {
  const skipped: CleanupSkips = { starred: 0, followup: 0, alreadyTrashed: 0, missing: 0 };
  let accountEmail = account.displayName;

  try {
    accountEmail = await mailGateway.getCurrentUser(account);
    const followupLabelId = await mailGateway.ensureFollowupLabel(account);
    const cutoffs = ttlCutoffs(config.cleanup.ttlDays, new Date());
    const candidates = listCleanupCandidates(db, account.id, cutoffs, config.cleanup.maxPerAccount);

    const toTrash: CleanupCandidate[] = [];
    for (const candidate of candidates) {
      const labels = await mailGateway.getMessageLabels(account, candidate.gmailId);

      if (labels === null) {
        // Gmail no longer has the message (deleted out of band). Log it in apply
        // mode so the cleanup pass stops re-checking it.
        skipped.missing += 1;
        if (apply) recordTrashed(db, candidate, 'missing');
        continue;
      }
      if (labels.includes('TRASH')) {
        skipped.alreadyTrashed += 1;
        if (apply) recordTrashed(db, candidate, 'already-trashed');
        continue;
      }
      if (labels.includes('STARRED')) {
        // Starred means the user wants to keep it in view; never auto-trash.
        skipped.starred += 1;
        continue;
      }
      if (followupLabelId && labels.includes(followupLabelId)) {
        skipped.followup += 1;
        continue;
      }

      toTrash.push(candidate);
    }

    if (apply && toTrash.length > 0) {
      await mailGateway.trashMessages(account, toTrash.map((item) => item.gmailId));
      for (const candidate of toTrash) {
        recordTrashed(db, candidate, 'cleanup');
      }
    }

    return {
      accountId: account.id,
      accountName: account.displayName,
      accountEmail,
      applied: apply,
      candidates: candidates.length,
      trashed: toTrash,
      skipped
    };
  } catch (error) {
    return {
      accountId: account.id,
      accountName: account.displayName,
      accountEmail,
      applied: apply,
      candidates: 0,
      trashed: [],
      skipped,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

// Translates per-category TTLs into the ISO timestamp on or before which a
// message of that category is considered expired and eligible for cleanup.
export function ttlCutoffs(ttlDays: CleanupConfig['ttlDays'], now: Date): Partial<Record<Category, string>> {
  const cutoffs: Partial<Record<Category, string>> = {};
  for (const [category, days] of Object.entries(ttlDays) as Array<[Category, number]>) {
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    cutoffs[category] = cutoff.toISOString();
  }
  return cutoffs;
}

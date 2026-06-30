import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { runCleanup } from '../src/cleanup.js';
import { openDatabase } from '../src/db.js';
import { createGmailMailGateway } from '../src/gateway/gmail-mail-gateway.js';
import type { CleanupConfig } from '../src/types.js';

async function main() {
  const apply = process.argv.includes('--apply');

  const config = loadConfig();
  const db = openDatabase(config);
  const mailGateway = createGmailMailGateway(config);

  const ttlSummary = describeTtl(config.cleanup.ttlDays);
  console.log(apply
    ? `Cleanup APPLY: moving eligible processed mail to Gmail Trash (${ttlSummary}).`
    : `Cleanup DRY-RUN: previewing eligible processed mail (${ttlSummary}). Nothing is deleted.`);

  const results = await runCleanup(config, db, mailGateway, { apply });

  let totalTrashed = 0;
  for (const result of results) {
    if (result.error) {
      console.log(`\n[${result.accountId}] ${result.accountEmail}: ERROR ${result.error}`);
      continue;
    }

    totalTrashed += result.trashed.length;
    const verb = result.applied ? 'trashed' : 'would trash';
    console.log(
      `\n[${result.accountId}] ${result.accountEmail}: ${verb} ${result.trashed.length}` +
      ` of ${result.candidates} candidate(s)` +
      ` (kept starred=${result.skipped.starred}, followup=${result.skipped.followup},` +
      ` already-trashed=${result.skipped.alreadyTrashed}, missing=${result.skipped.missing})`
    );
    for (const item of result.trashed) {
      console.log(`   - [${item.category}] ${oneLine(item.from)} — ${oneLine(item.subject)} (processed ${item.processedAt})`);
    }
  }

  const action = apply ? 'Trashed' : 'Would trash';
  console.log(`\n${action} ${totalTrashed} message(s) across ${results.length} account(s).`);
  if (!apply && totalTrashed > 0) {
    console.log('Run "npm run cleanup -- --apply" to move these to Gmail Trash (recoverable for 30 days).');
  }
}

function describeTtl(ttlDays: CleanupConfig['ttlDays']): string {
  const parts = Object.entries(ttlDays).map(([category, days]) => `${category}≥${days}d`);
  return parts.length > 0 ? parts.join(', ') : 'no categories eligible';
}

function oneLine(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 80 ? `${normalized.slice(0, 79)}…` : normalized;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

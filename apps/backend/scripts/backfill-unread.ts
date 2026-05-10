import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { backfillUnreadMail } from '../src/digest.js';
import { createGmailMailGateway } from '../src/gateway/gmail-mail-gateway.js';

const DEFAULT_LIMIT = 30;

async function main() {
  const argLimit = Number.parseInt(process.argv[2] || '', 10);
  const limit = Number.isFinite(argLimit) && argLimit > 0 ? argLimit : DEFAULT_LIMIT;

  const config = loadConfig();
  const db = openDatabase(config);
  const mailGateway = createGmailMailGateway(config);

  console.log(`Backfilling up to ${limit} most-recent unread message(s) per account.`);
  const results = await backfillUnreadMail(config, db, mailGateway, limit);

  let grandTotal = 0;
  for (const result of results) {
    grandTotal += result.total;
    const tail = result.error ? ` ERROR: ${result.error}` : '';
    console.log(
      `[${result.accountId}] ${result.accountEmail}: total=${result.total}` +
      ` (action=${result.counts.action}, fyi=${result.counts.fyi}, course=${result.counts.course}, admin=${result.counts.admin}, junk=${result.counts.junk})${tail}`
    );
  }
  console.log(`Done. Processed ${grandTotal} message(s) across ${results.length} account(s).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

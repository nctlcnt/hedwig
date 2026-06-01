import cron from 'node-cron';
import { loadConfig } from './config.js';
import { processUnreadMail, runDailyDigest, sendTodayDigest } from './digest.js';
import { openDatabase } from './db.js';
import { startDiscordInteractionServer } from './discord-interactions.js';
import { createGmailMailGateway } from './gateway/gmail-mail-gateway.js';

const mode = process.argv[2] || 'once';
const config = loadConfig();
const db = openDatabase(config);
const mailGateway = createGmailMailGateway(config);

async function run(): Promise<void> {
  const digest = await runDailyDigest(config, db, mailGateway);
  console.log(
    `Sent digest #${digest.runIds.join(',')} for ${digest.account}: total=${digest.total}, action=${digest.counts.action}, fyi=${digest.counts.fyi}, course=${digest.counts.course}, admin=${digest.counts.admin}, junk=${digest.counts.junk}`
  );
}

if (mode === 'once') {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else if (mode === 'daemon') {
  startDiscordInteractionServer(config, db);

  console.log(`Scheduling unread mail processing with "${config.digest.processCron}" in ${config.digest.timezone}`);
  cron.schedule(
    config.digest.processCron,
    () => {
      processUnreadMail(config, db, mailGateway).catch((error) => {
        console.error(error);
      });
    },
    { timezone: config.digest.timezone }
  );

  console.log(`Scheduling digest with "${config.digest.cron}" in ${config.digest.timezone}`);
  cron.schedule(
    config.digest.cron,
    () => {
      sendTodayDigest(config, db).catch((error) => {
        console.error(error);
      });
    },
    { timezone: config.digest.timezone }
  );
} else {
  console.error(`Unknown mode: ${mode}. Use "once" or "daemon".`);
  process.exitCode = 1;
}

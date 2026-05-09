import cron from 'node-cron';
import { loadConfig } from './config.js';
import { runDailyDigest } from './digest.js';
import { openDatabase } from './db.js';

const mode = process.argv[2] || 'once';
const config = loadConfig();
const db = openDatabase(config);

async function run(): Promise<void> {
  const digest = await runDailyDigest(config, db);
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
  console.log(`Scheduling digest with "${config.digest.cron}" in ${config.digest.timezone}`);
  cron.schedule(
    config.digest.cron,
    () => {
      run().catch((error) => {
        console.error(error);
      });
    },
    { timezone: config.digest.timezone }
  );
} else {
  console.error(`Unknown mode: ${mode}. Use "once" or "daemon".`);
  process.exitCode = 1;
}

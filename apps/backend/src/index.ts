import cron from 'node-cron';
import { reportProblem, problemMessage } from './alerts.js';
import { loadConfig } from './config.js';
import { processUnreadMail, queueTodayDigest, runDailyDigest } from './digest.js';
import { openDatabase, type HedwigDb } from './db.js';
import { createGmailMailGateway } from './gateway/gmail-mail-gateway.js';
import type { MailGateway } from './gateway/mail-gateway.js';
import type { Notifier } from './notifications/notifier.js';
import { createOutboxDrain } from './notifications/outbox-worker.js';
import { createTelegramNotifier } from './notifications/telegram-notifier.js';
import { createTelegramApi, telegramRequest, validateTelegramDebugChat } from './telegram/api.js';
import { startTelegramPolling } from './telegram/poller.js';
import type { AppConfig } from './types.js';

const OUTBOX_POLL_MS = 5_000;

main().catch((error) => {
  console.error('Hedwig startup or one-shot run failed', problemMessage(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const mode = process.argv[2] || 'once';
  if (mode !== 'once' && mode !== 'daemon') throw new Error(`Unknown mode: ${mode}. Use "once" or "daemon".`);
  const config = loadConfig();
  if (mode === 'daemon' && (!cron.validate(config.digest.processCron) || !cron.validate(config.digest.cron))) {
    throw new Error('DIGEST_PROCESS_CRON and DIGEST_CRON must be valid cron expressions');
  }
  if (mode === 'daemon') new Intl.DateTimeFormat('en', { timeZone: config.digest.timezone });
  const db = openDatabase(config);
  const mailGateway = createGmailMailGateway(config);
  let daemonStarted = false;

  try {
    const api = createTelegramApi(config.telegram.botToken);
    const bot = await telegramRequest('getMe', () => api.getMe());
    await validateTelegramDebugChat(api, config.telegram.debugChatId);
    const notifier = createTelegramNotifier(db, config, bot.id, api);
    if (mode === 'once') {
      try {
        await runOnce(config, db, mailGateway, notifier);
      } catch {
        throw new Error('Telegram one-shot run failed while processing mail or draining the outbox');
      }
      return;
    }

    const wakeOutbox = createOutboxWake(db, notifier);
    const poller = await startTelegramPolling(db, api, notifier, {
      botUsername: bot.username,
      botId: bot.id,
      ownerUserId: config.telegram.ownerUserId,
      chatId: config.telegram.chatId,
      timezone: config.digest.timezone,
      accounts: config.google.accounts,
      wakeOutbox
    });
    let stopDaemon: (() => void) | undefined;
    function shutdown(): void {
      stopDaemon?.();
      poller.stop();
    }
    try {
      stopDaemon = scheduleDaemon(config, db, mailGateway, notifier, wakeOutbox);
      daemonStarted = true;
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
      await poller.done;
    } finally {
      shutdown();
      await poller.done.catch(() => {});
      process.removeListener('SIGINT', shutdown);
      process.removeListener('SIGTERM', shutdown);
    }
  } finally {
    // A stopped daemon may still have in-flight cron or outbox work.
    if (!daemonStarted) db.close();
  }
}

async function runOnce(config: AppConfig, db: HedwigDb, mailGateway: MailGateway, notifier: Notifier): Promise<void> {
  const digest = await runDailyDigest(config, db, mailGateway, notifier);
  await createOutboxDrain(db, notifier)();
  console.log(
    `Digest queued for ${digest.date} (${digest.account}): total=${digest.total}, action=${digest.counts.action}, fyi=${digest.counts.fyi}, course=${digest.counts.course}, admin=${digest.counts.admin}, junk=${digest.counts.junk}`
  );
}

function createOutboxWake(db: HedwigDb, notifier: Notifier): () => void {
  const drainOutbox = createOutboxDrain(db, notifier);
  return () => {
    void drainOutbox().catch((error) => console.error('Notification outbox worker failed', problemMessage(error)));
  };
}

function scheduleDaemon(
  config: AppConfig,
  db: HedwigDb,
  mailGateway: MailGateway,
  notifier: Notifier,
  wakeOutbox = createOutboxWake(db, notifier)
): () => void {
  // The raw error can carry tokens or mail content, so neither the log nor the
  // alert includes it; only the job title is reported.
  function reportCronFailure(job: string, title: string): Promise<void> {
    console.error(title);
    return reportProblem(notifier, db, {
      kind: 'job-failure',
      signature: `cron:${job}|${title.slice(0, 120)}`,
      title,
      detail: title
    });
  }

  console.log(`Scheduling Gmail History processing with "${config.digest.processCron}" in ${config.digest.timezone}`);
  const processJob = cron.schedule(
    config.digest.processCron,
    () => processUnreadMail(config, db, mailGateway, notifier)
      .catch(() => reportCronFailure('process', '定时处理任务异常')),
    { timezone: config.digest.timezone }
  );

  console.log(`Scheduling digest with "${config.digest.cron}" in ${config.digest.timezone}`);
  const digestJob = cron.schedule(
    config.digest.cron,
    () => queueTodayDigest(config, db, notifier)
      .catch(() => reportCronFailure('digest', '定时摘要任务异常')),
    { timezone: config.digest.timezone }
  );

  wakeOutbox();
  const worker = setInterval(wakeOutbox, OUTBOX_POLL_MS);

  return () => {
    clearInterval(worker);
    processJob.stop();
    digestJob.stop();
  };
}

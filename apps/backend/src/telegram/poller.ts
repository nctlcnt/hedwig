import { setTimeout as delay } from 'node:timers/promises';
import type { CallbackQuery, Update } from 'grammy/types';
import { DateTime } from 'luxon';
import { getLastSyncAt, setSummaryLanguage, type HedwigDb } from '../db.js';
import { readTodayDigest } from '../digest.js';
import { DeliveryError, type Notifier } from '../notifications/notifier.js';
import { enqueueNotification, getNotificationStatus } from '../notifications/outbox-store.js';
import { normalizeSummaryLanguage } from '../summary-language.js';
import type { GmailAccountConfig } from '../types.js';
import { editTelegramMessage, grammySignal, telegramRequest, validateTelegramPollingMode, type TelegramApi } from './api.js';
import { renderTelegramView, telegramDigestOverview, telegramMessagePart, type TelegramMessage } from './views.js';
import {
  acquireTelegramLease,
  findTelegramView,
  isTelegramChatReady,
  markTelegramChatReady,
  pruneTelegramViews,
  releaseTelegramLease,
  renewTelegramLease,
  saveTelegramOffset,
  telegramOffset,
  type TelegramPrivateChat
} from './store.js';

type TelegramPoller = { done: Promise<void>; stop(): void };
type TelegramPollingOptions = TelegramPrivateChat & {
  botUsername: string;
  timezone: string;
  accounts: ReadonlyArray<Pick<GmailAccountConfig, 'id' | 'displayName'>>;
  wakeOutbox(): void;
};

const CALLBACK_ANSWER_TIMEOUT_MS = 2500;

export async function startTelegramPolling(
  db: HedwigDb,
  api: TelegramApi,
  notifier: Notifier,
  options: TelegramPollingOptions
): Promise<TelegramPoller> {
  const lease = acquireTelegramLease(db, options.botId);
  try {
    await validateTelegramPollingMode(api);
    pruneTelegramViews(db);
  } catch (error) {
    releaseTelegramLease(db, options.botId, lease);
    throw error;
  }

  const controller = new AbortController();
  const done = poll(db, api, notifier, options, lease, controller.signal)
    .finally(() => releaseTelegramLease(db, options.botId, lease));
  return { done, stop: () => controller.abort() };
}

async function poll(
  db: HedwigDb,
  api: TelegramApi,
  notifier: Notifier,
  options: TelegramPollingOptions,
  lease: string,
  signal: AbortSignal
): Promise<void> {
  let backoff = 1000;
  while (!signal.aborted) {
    try {
      renewTelegramLease(db, options.botId, lease);
      const offset = telegramOffset(db, options.botId);
      const updates = await telegramRequest('getUpdates', () => api.getUpdates({
        offset,
        timeout: 20,
        allowed_updates: ['message', 'callback_query']
      }, grammySignal(signal)), signal);
      for (const update of updates.sort((a, b) => a.update_id - b.update_id)) {
        if (signal.aborted) return;
        renewTelegramLease(db, options.botId, lease);
        await handleUpdate(db, api, notifier, options, lease, update, signal);
      }
      backoff = 1000;
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof DeliveryError && error.status === 409) {
        throw new Error('Telegram getUpdates conflict: another receiver is active for this bot');
      }
      if (!(error instanceof DeliveryError) || !error.retryable) throw error;
      console.warn(`Telegram polling will retry after ${error.message}`);
      let wait = Math.max(backoff, error.retryAfterMs);
      backoff = Math.min(30_000, backoff * 2);
      while (wait > 0 && !signal.aborted) {
        renewTelegramLease(db, options.botId, lease);
        const interval = Math.min(wait, 20_000);
        await delay(interval, undefined, { signal }).catch((error: unknown) => {
          if (!signal.aborted) throw error;
        });
        wait -= interval;
      }
    }
  }
}

async function handleUpdate(
  db: HedwigDb,
  api: TelegramApi,
  notifier: Notifier,
  options: TelegramPollingOptions,
  lease: string,
  update: Update,
  signal: AbortSignal
): Promise<void> {
  if (update.update_id < (telegramOffset(db, options.botId) ?? 0)) return;

  if (update.callback_query) await handleCallback(db, api, options, update.callback_query, signal);
  if (signal.aborted) return;

  const enqueued = db.transaction(() => {
    const message = update.message;
    const reply = message?.text && isOwnerChat(options, message.from?.id, message.chat)
      ? commandReply(db, notifier, options, message.text) : undefined;
    if (reply && message) {
      const key = JSON.stringify(['telegram-reply', options.botId, update.update_id, message.message_id]);
      enqueueNotification(db, notifier, 'realtime', key, [telegramMessagePart(reply)]);
    }
    // Command side effects and their offset commit together. Button edits
    // finish first and can be replayed if the offset was not committed.
    saveTelegramOffset(db, options.botId, lease, update.update_id + 1);
    return reply !== undefined;
  }).immediate();
  if (enqueued) options.wakeOutbox();
}

async function handleCallback(
  db: HedwigDb,
  api: TelegramApi,
  options: TelegramPollingOptions,
  callback: CallbackQuery,
  signal: AbortSignal
): Promise<void> {
  const source = callback.message;
  const ownMessage = source && source.date !== 0 && 'from' in source && source.from?.id === options.botId;
  const authorized = ownMessage && isOwnerChat(options, callback.from.id, source.chat) && isTelegramChatReady(db, options);
  const view = authorized && findTelegramView(db, options, callback.data ?? '');
  const message = view ? renderTelegramView(db, options, view) : undefined;
  const text = !authorized ? '此操作不可用。' : !message ? '按钮已过期或无效。' : undefined;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(CALLBACK_ANSWER_TIMEOUT_MS)]);
  // Acknowledgement and editing are independent. Only a failed edit can require replay.
  const acknowledgment = telegramRequest('answerCallbackQuery',
    () => api.answerCallbackQuery(callback.id, text ? { text } : undefined, grammySignal(deadline)), signal
  ).catch(() => {});
  if (!source || !message || signal.aborted) {
    await acknowledgment;
    return;
  }
  try {
    await editTelegramMessage(api, options.chatId, source.message_id, message, signal);
  } catch (error) {
    if (!(error instanceof DeliveryError) || (error.status !== 400 && error.status !== 403)) throw error;
  }
}

function commandReply(db: HedwigDb, notifier: Notifier, options: TelegramPollingOptions, text: string): TelegramMessage | undefined {
  const match = /^\/([a-z_]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match || (match[2] && match[2].toLowerCase() !== options.botUsername.toLowerCase())) return undefined;
  const command = match[1]?.toLowerCase();
  if (command === 'start') {
    markTelegramChatReady(db, options);
    return { text: 'Hedwig 已连接。使用 /today 查看今日摘要，或用 /status 查看同步和投递状态。' };
  }
  if (!isTelegramChatReady(db, options)) return undefined;
  switch (command) {
    case 'today':
      return telegramDigestOverview(db, options, readTodayDigest(db, options.timezone), options.accounts, false);
    case 'status': {
      const lastSync = getLastSyncAt(db);
      const { lastSentAt, pending } = getNotificationStatus(db, notifier);
      return { text: [
        `最近同步：${formatStatusTime(lastSync ? DateTime.fromISO(lastSync) : null, options.timezone)}`,
        `最近成功投递：${formatStatusTime(lastSentAt === null ? null : DateTime.fromMillis(lastSentAt), options.timezone)}`,
        `待投递或重试：${pending} 条`
      ].join('\n') };
    }
    case 'summary_language': {
      let language: string;
      try {
        language = normalizeSummaryLanguage(match[3] ?? '');
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return { text: `${error.message}。例如 /summary_language English` };
      }
      setSummaryLanguage(db, language);
      return { text: `之后生成的摘要将使用 ${language}。` };
    }
  }
  return undefined;
}

function formatStatusTime(time: DateTime | null, timezone: string): string {
  return time?.isValid ? time.setZone(timezone).toFormat('yyyy-MM-dd HH:mm ZZZZ') : '暂无记录';
}

function isOwnerChat(options: TelegramPrivateChat, userId: number | undefined, chat: { type: string; id: number }): boolean {
  return userId === options.ownerUserId && chat.type === 'private' && chat.id === options.chatId;
}

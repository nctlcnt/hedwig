import type { InlineKeyboardMarkup } from 'grammy/types';
import type { HedwigDb } from '../db.js';
import type { TelegramAppConfig } from '../types.js';
import { telegramRequest, type TelegramApi } from '../telegram/api.js';
import { isTelegramChatReady, telegramDestination, type TelegramPrivateChat } from '../telegram/store.js';
import { gmailButton, limitTelegramText, telegramDigestOverview, telegramMessagePart, viewButton, type TelegramMessage } from '../telegram/views.js';
import type { Notifier, OperationalAlert } from './notifier.js';

export function createTelegramNotifier(
  db: HedwigDb,
  config: TelegramAppConfig,
  botId: number,
  api: TelegramApi
): Notifier {
  const { telegram } = config;
  const chat: TelegramPrivateChat = { botId, ownerUserId: telegram.ownerUserId, chatId: telegram.chatId };
  // Bind pending work to the bot and owner as well as the physical chat.
  const destination = telegramDestination(chat);
  return {
    platform: 'telegram',
    digestDestination: destination,
    realtimeDestination: destination,
    alertCooldownMs: telegram.debugChatId === null ? null : telegram.debugCooldownMs,
    canDeliver: () => isTelegramChatReady(db, chat),
    planDigest(digest) {
      return [telegramMessagePart(telegramDigestOverview(db, chat, digest, config.google.accounts, true))];
    },
    planRealtime(item) {
      const buttons: InlineKeyboardMarkup['inline_keyboard'][number] = [
        viewButton(db, chat, '查看详情', { kind: 'mail', mail: { mailId: item.mailId } })
      ];
      const link = gmailButton(item.gmailUrl);
      if (link) buttons.push(link);
      return telegramMessagePart({
        text: [
          '需要及时查看的邮件',
          `${limitTelegramText(item.accountName, 150)} · ${limitTelegramText(item.subject, 250)}`,
          limitTelegramText(item.summary, 400)
        ].filter(Boolean).join('\n'),
        keyboard: { inline_keyboard: [buttons] }
      });
    },
    async deliver(request) {
      if (request.destination !== destination || request.parentMessageId !== null) {
        throw new Error('Invalid Telegram delivery destination');
      }
      const { text, keyboard } = request.payload as TelegramMessage;
      const message = await telegramRequest('sendMessage', () => api.sendMessage(chat.chatId, text, {
        reply_markup: keyboard,
        link_preview_options: { is_disabled: true }
      }));
      return String(message.message_id);
    },
    async sendOperationalAlert(alert) {
      const chatId = telegram.debugChatId;
      if (chatId === null) return;
      await telegramRequest('sendMessage', () => api.sendMessage(chatId, telegramAlertText(alert), {
        link_preview_options: { is_disabled: true }
      }));
    }
  };
}

function telegramAlertText(alert: OperationalAlert): string {
  switch (alert.kind) {
    case 'job-failure':
      return alert.title;
    case 'account-failure':
      return '有一个 Gmail 账号同步失败，请查看服务日志。';
    case 'classifier-fallback':
      return `${alert.failures.length} 封邮件的 AI 分类失败，已使用规则分类。`;
  }
}

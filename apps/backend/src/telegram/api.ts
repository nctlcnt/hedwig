import { Agent } from 'node:https';
import { Api, GrammyError, HttpError } from 'grammy';
import { DeliveryError } from '../notifications/notifier.js';
import type { TelegramMessage } from './views.js';

export type TelegramApi = Pick<Api, 'getMe' | 'getChat' | 'getWebhookInfo' | 'getUpdates' | 'sendMessage' | 'editMessageText' | 'answerCallbackQuery'>;

const SLOW_REQUEST_MS = 1000;
const EDIT_TIMEOUT_MS = 8000;
// The VPS can reach Telegram over IPv4, while IPv6 connections time out.
const telegramAgent = new Agent({ keepAlive: true, family: 4 });

export function createTelegramApi(botToken: string): Api {
  return new Api(botToken, {
    timeoutSeconds: 25,
    sensitiveLogs: false,
    baseFetchConfig: { agent: telegramAgent }
  });
}

export function grammySignal(signal: AbortSignal): NonNullable<Parameters<Api['getUpdates']>[1]> {
  // grammY's Node declarations use an AbortSignal polyfill. Its client
  // consumes the event methods also supported by Node's native signal.
  return signal as unknown as NonNullable<Parameters<Api['getUpdates']>[1]>;
}

export async function validateTelegramDebugChat(api: TelegramApi, chatId: number | null): Promise<void> {
  if (chatId === null) return;
  const chat = await telegramRequest('getChat', () => api.getChat(chatId));
  if (chat.type === 'group') return;
  if (chat.type === 'supergroup' && !chat.username && !chat.active_usernames?.length) return;
  throw new Error('TELEGRAM_DEBUG_CHAT_ID must refer to a private Telegram group');
}

export async function validateTelegramPollingMode(api: TelegramApi): Promise<void> {
  const webhook = await telegramRequest('getWebhookInfo', () => api.getWebhookInfo());
  if (webhook.url) throw new Error('Telegram bot has an active webhook. Remove it before enabling long polling.');
}

export async function editTelegramMessage(
  api: TelegramApi,
  chatId: number,
  messageId: number,
  message: TelegramMessage,
  signal: AbortSignal
): Promise<void> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(EDIT_TIMEOUT_MS)]);
  await telegramRequest('editMessageText', async () => {
    try {
      await api.editMessageText(chatId, messageId, message.text, {
        reply_markup: message.keyboard ?? { inline_keyboard: [] },
        link_preview_options: { is_disabled: true }
      }, grammySignal(deadline));
    } catch (error) {
      // An edit can succeed before its update offset is saved.
      if (error instanceof GrammyError && error.error_code === 400 && /message is not modified/i.test(error.description)) return;
      throw error;
    }
  }, signal);
}

// grammY errors can hold the full request payload or URL. Keep only the
// status and rate-limit hint as they cross the transport boundary.
export async function telegramRequest<T>(
  method: keyof TelegramApi,
  request: () => Promise<T>,
  shutdownSignal?: AbortSignal
): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await request();
    const elapsedMs = Math.round(performance.now() - startedAt);
    // Successful getUpdates normally waits on Telegram when the bot is idle.
    if (method !== 'getUpdates' && elapsedMs >= SLOW_REQUEST_MS) {
      console.info(`Telegram ${method} completed in ${elapsedMs} ms`);
    }
    return result;
  } catch (error) {
    const failure = toDeliveryError(error);
    if (!shutdownSignal?.aborted && !(method === 'answerCallbackQuery' && failure.status === 400)) {
      const elapsedMs = Math.round(performance.now() - startedAt);
      const networkCause = failure.status === 'network' ? sanitizedNetworkCause(error) : undefined;
      const reason = networkCause ? `${failure.message}: ${networkCause}` : failure.message;
      console.warn(`Telegram ${method} failed after ${elapsedMs} ms (${reason})`);
    }
    throw failure;
  }
}

function toDeliveryError(error: unknown): DeliveryError {
  if (error instanceof GrammyError) {
    const delay = Math.ceil((error.parameters.retry_after ?? 0) * 1000);
    return new DeliveryError(error.error_code, Number.isSafeInteger(delay) && delay > 0 ? delay : 0);
  }
  return error instanceof DeliveryError ? error : new DeliveryError('network');
}

function sanitizedNetworkCause(error: unknown): string | undefined {
  const wrapped = error instanceof HttpError ? error.error : error;
  if (!(wrapped instanceof Error)) return undefined;
  if (wrapped.name === 'AbortError' || wrapped.name === 'TimeoutError') return 'timeout';
  if (/^Request to '[A-Za-z]+' timed out after \d+ seconds$/.test(wrapped.message)) return 'timeout';
  const source = wrapped.cause instanceof Error ? wrapped.cause : wrapped;
  const code = 'code' in source ? source.code : undefined;
  if (typeof code === 'string' && /^(?:EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_SOCKET)$/.test(code)) {
    return code;
  }
  return undefined;
}

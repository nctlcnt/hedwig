import { loadConfig } from '../src/config.js';
import { createTelegramApi, telegramRequest, validateTelegramDebugChat, validateTelegramPollingMode } from '../src/telegram/api.js';

try {
  const config = loadConfig();
  const api = createTelegramApi(config.telegram.botToken);
  await telegramRequest('getMe', () => api.getMe());
  await validateTelegramPollingMode(api);
  await validateTelegramDebugChat(api, config.telegram.debugChatId);
  console.log('Telegram bot credentials, polling mode, and configured debug group verified.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Messaging configuration check failed');
  process.exitCode = 1;
}

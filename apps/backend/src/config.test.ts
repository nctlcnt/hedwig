import assert from 'node:assert/strict';
import { loadConfig } from './config.js';

const originalEnv = process.env;
try {
  process.env = {
    GOOGLE_CLIENT_ID: 'test-client',
    GOOGLE_CLIENT_SECRET: 'test-secret',
    GOOGLE_REFRESH_TOKEN: 'test-refresh-token',
    GMAIL_ACCOUNTS_JSON: `${import.meta.filename}/unused.json`
  };
  assert.throws(() => loadConfig(), /Missing required environment variable: TELEGRAM_BOT_TOKEN/);
  process.env.TELEGRAM_BOT_TOKEN = '123:test_token';
  process.env.TELEGRAM_OWNER_USER_ID = '123456789012345';
  process.env.TELEGRAM_CHAT_ID = '123456789012345';
  process.env.TELEGRAM_DEBUG_CHAT_ID = '-1001234567890';
  // Leftover Discord and follow-up settings are ignored rather than validated.
  process.env.FOLLOWUP_ENABLED = 'true';
  process.env.DISCORD_BOT_TOKEN = 'leftover-token';
  const telegramConfig = loadConfig();
  assert.equal(telegramConfig.telegram.ownerUserId, 123456789012345);
  assert.equal(telegramConfig.telegram.debugChatId, -1001234567890);
  assert.equal('discord' in telegramConfig, false);
  assert.equal('followup' in telegramConfig, false);

  process.env.MESSAGING_PROVIDER = 'telegram';
  assert.equal(loadConfig().telegram.chatId, 123456789012345);
  process.env.MESSAGING_PROVIDER = 'discord';
  assert.throws(() => loadConfig(), /Discord delivery was removed/);
  delete process.env.MESSAGING_PROVIDER;

  process.env.TELEGRAM_CHAT_ID = '-1001234567890';
  assert.throws(() => loadConfig(), /TELEGRAM_CHAT_ID must be a positive private Telegram ID/);
  process.env.TELEGRAM_CHAT_ID = '123456789012345';
  process.env.TELEGRAM_DEBUG_CHAT_ID = '123456789012345';
  assert.throws(() => loadConfig(), /TELEGRAM_DEBUG_CHAT_ID must be a negative group Telegram ID/);
  process.env.TELEGRAM_BOT_TOKEN = 'invalid-sensitive-token';
  assert.throws(() => loadConfig(), { message: 'TELEGRAM_BOT_TOKEN has an invalid format' });
} finally {
  process.env = originalEnv;
}

console.log('config.test.ts: all assertions passed');

import assert from 'node:assert/strict';
import { loadConfig } from './config.js';

const originalEnv = process.env;
try {
  process.env = {
    GOOGLE_CLIENT_ID: 'test-client',
    GOOGLE_CLIENT_SECRET: 'test-secret',
    GOOGLE_REFRESH_TOKEN: 'test-refresh-token',
    GMAIL_ACCOUNTS_JSON: `${import.meta.filename}/unused.json`,
    DISCORD_BOT_TOKEN: 'test-bot-token',
    DISCORD_DIGEST_CHANNEL_ID: 'test-digest-channel'
  };
  const defaultConfig = loadConfig();
  assert.equal(defaultConfig.messagingProvider, 'discord');
  assert.equal(defaultConfig.discord.digestChannelId, 'test-digest-channel');
  process.env.MESSAGING_PROVIDER = 'discord';
  const discordConfig = loadConfig();
  assert.equal(discordConfig.messagingProvider, 'discord');
  assert.equal(discordConfig.discord.botToken, 'test-bot-token');

  delete process.env.DISCORD_BOT_TOKEN;
  assert.throws(() => loadConfig(), /Missing required environment variable: DISCORD_BOT_TOKEN/);
  process.env.MESSAGING_PROVIDER = 'telegram';
  assert.throws(() => loadConfig(), /Missing required environment variable: TELEGRAM_BOT_TOKEN/);
  process.env.TELEGRAM_BOT_TOKEN = '123:test_token';
  process.env.TELEGRAM_OWNER_USER_ID = '123456789012345';
  process.env.TELEGRAM_CHAT_ID = '123456789012345';
  process.env.TELEGRAM_DEBUG_CHAT_ID = '-1001234567890';
  process.env.FOLLOWUP_ENABLED = 'true';
  delete process.env.DISCORD_DIGEST_CHANNEL_ID;
  const telegramConfig = loadConfig();
  assert.equal(telegramConfig.messagingProvider, 'telegram');
  assert.equal(telegramConfig.telegram.ownerUserId, 123456789012345);
  assert.equal(telegramConfig.telegram.debugChatId, -1001234567890);
  assert.equal('discord' in telegramConfig, false);
  process.env.TELEGRAM_CHAT_ID = '-1001234567890';
  assert.throws(() => loadConfig(), /TELEGRAM_CHAT_ID must be a positive private Telegram ID/);
  process.env.TELEGRAM_CHAT_ID = '123456789012345';
  process.env.TELEGRAM_DEBUG_CHAT_ID = '123456789012345';
  assert.throws(() => loadConfig(), /TELEGRAM_DEBUG_CHAT_ID must be a negative group Telegram ID/);
  process.env.TELEGRAM_BOT_TOKEN = 'invalid-sensitive-token';
  assert.throws(() => loadConfig(), { message: 'TELEGRAM_BOT_TOKEN has an invalid format' });
  process.env.MESSAGING_PROVIDER = 'invalid';
  assert.throws(() => loadConfig(), /MESSAGING_PROVIDER must be "discord" or "telegram"/);
} finally {
  process.env = originalEnv;
}

console.log('config.test.ts: all assertions passed');

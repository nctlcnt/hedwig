import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import type { AppConfig, GmailAccountConfig, LlmClassifierConfig, TelegramConfig } from './types.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function loadConfig(): AppConfig {
  // Discord delivery was removed; reject a stale setting instead of silently ignoring it.
  const messagingProvider = process.env.MESSAGING_PROVIDER?.trim();
  if (messagingProvider && messagingProvider !== 'telegram') {
    throw new Error('MESSAGING_PROVIDER is no longer supported except "telegram"; Discord delivery was removed');
  }

  const rawProvider = process.env.CLASSIFIER_PROVIDER
    || (process.env.CLASSIFIER_API_KEY || process.env.DEEPSEEK_API_KEY ? 'openai-compatible' : 'rule');
  const provider = rawProvider === 'deepseek' ? 'openai-compatible' : rawProvider;
  if (provider !== 'rule' && provider !== 'openai-compatible') {
    throw new Error(`CLASSIFIER_PROVIDER must be "rule", "openai-compatible", or legacy "deepseek", got: ${rawProvider}`);
  }

  return {
    google: {
      clientId: required('GOOGLE_CLIENT_ID'),
      clientSecret: required('GOOGLE_CLIENT_SECRET'),
      redirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost',
      accounts: gmailAccounts()
    },
    digest: {
      timezone: process.env.DIGEST_TIMEZONE || 'Australia/Sydney',
      cron: process.env.DIGEST_CRON || '0 19 * * *',
      processCron: process.env.DIGEST_PROCESS_CRON || '*/5 * * * *',
      lookbackHours: integer('GMAIL_LOOKBACK_HOURS', 24),
      maxMessages: integer('GMAIL_MAX_MESSAGES', 100)
    },
    classifier: {
      provider,
      rulesPath: process.env.CLASSIFIER_RULES_FILE || 'config/classifier-rules.md',
      llm: {
        apiKey: process.env.CLASSIFIER_API_KEY || process.env.DEEPSEEK_API_KEY || '',
        baseUrl: process.env.CLASSIFIER_API_BASE_URL || 'https://api.deepseek.com',
        model: process.env.CLASSIFIER_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro',
        providerName: process.env.CLASSIFIER_PROVIDER_NAME || (rawProvider === 'deepseek' ? 'deepseek' : 'openai-compatible')
      },
      fallbackLlm: fallbackLlmConfig(),
      maxRetries: integer('CLASSIFIER_MAX_RETRIES', 4),
      requestTimeoutMs: integer('CLASSIFIER_TIMEOUT_MS', 60000)
    },
    database: {
      path: process.env.SQLITE_PATH || 'data/hedwig.db'
    },
    telegram: loadTelegramConfig()
  };
}

function loadTelegramConfig(): TelegramConfig {
  const botToken = required('TELEGRAM_BOT_TOKEN').trim();
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) throw new Error('TELEGRAM_BOT_TOKEN has an invalid format');
  const debugChatId = process.env.TELEGRAM_DEBUG_CHAT_ID?.trim();
  return {
    botToken,
    ownerUserId: telegramId('TELEGRAM_OWNER_USER_ID', required('TELEGRAM_OWNER_USER_ID')),
    chatId: telegramId('TELEGRAM_CHAT_ID', required('TELEGRAM_CHAT_ID')),
    debugChatId: debugChatId ? telegramId('TELEGRAM_DEBUG_CHAT_ID', debugChatId, true) : null,
    debugCooldownMs: integer('TELEGRAM_DEBUG_COOLDOWN_MINUTES', 60) * 60 * 1000
  };
}

function telegramId(name: string, raw: string, group = false): number {
  const value = raw.trim();
  const id = Number(value);
  const pattern = group ? /^-[1-9]\d*$/ : /^[1-9]\d*$/;
  if (!pattern.test(value) || !Number.isSafeInteger(id)) {
    throw new Error(`${name} must be a ${group ? 'negative group' : 'positive private'} Telegram ID`);
  }
  return id;
}

function fallbackLlmConfig(): LlmClassifierConfig | undefined {
  // Secondary LLM used only when the primary classifier call fails. Activated by
  // setting CLASSIFIER_FALLBACK_API_KEY; otherwise we go straight to the rule
  // classifier on failure. Each field independently falls back to the primary
  // value so a backup that shares the same key/base only needs to override what
  // differs (usually just the model).
  const apiKey = process.env.CLASSIFIER_FALLBACK_API_KEY;
  if (!apiKey) return undefined;
  return {
    apiKey,
    baseUrl: process.env.CLASSIFIER_FALLBACK_API_BASE_URL || process.env.CLASSIFIER_API_BASE_URL || 'https://api.deepseek.com',
    model: process.env.CLASSIFIER_FALLBACK_MODEL || process.env.CLASSIFIER_MODEL || 'deepseek-v4-pro',
    providerName: process.env.CLASSIFIER_FALLBACK_PROVIDER_NAME || 'fallback'
  };
}

function gmailAccounts(): GmailAccountConfig[] {
  const jsonPath = process.env.GMAIL_ACCOUNTS_JSON || 'config/gmail-accounts.json';
  if (existsSync(jsonPath)) {
    return gmailAccountsFromJson(jsonPath);
  }

  const raw = process.env.GMAIL_ACCOUNTS;
  if (!raw) {
    return [{
      id: 'primary',
      displayName: process.env.GMAIL_ACCOUNT_NAME || 'Primary Gmail',
      refreshToken: required('GOOGLE_REFRESH_TOKEN')
    }];
  }

  const accounts = raw.split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map(parseGmailAccount);

  if (accounts.length === 0) {
    throw new Error('GMAIL_ACCOUNTS must include at least one account');
  }

  const ids = new Set<string>();
  for (const account of accounts) {
    if (ids.has(account.id)) {
      throw new Error(`Duplicate Gmail account id in GMAIL_ACCOUNTS: ${account.id}`);
    }
    ids.add(account.id);
  }

  return accounts;
}

function gmailAccountsFromJson(path: string): GmailAccountConfig[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    accounts?: Array<{
      id?: string;
      displayName?: string;
      refreshToken?: string;
      refreshTokenFile?: string;
    }>;
  };

  const accounts = parsed.accounts?.map((account) => {
    if (!account.id || !account.displayName) {
      throw new Error(`${path} accounts must include id and displayName`);
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(account.id)) {
      throw new Error(`Gmail account id must contain only letters, numbers, "_" or "-": ${account.id}`);
    }

    const refreshToken = account.refreshToken || refreshTokenFromFile(path, account.refreshTokenFile);
    return {
      id: account.id,
      displayName: account.displayName,
      refreshToken
    };
  }) || [];

  if (accounts.length === 0) {
    throw new Error(`${path} must include at least one account`);
  }

  const ids = new Set<string>();
  for (const account of accounts) {
    if (ids.has(account.id)) {
      throw new Error(`Duplicate Gmail account id in ${path}: ${account.id}`);
    }
    ids.add(account.id);
  }

  return accounts;
}

function refreshTokenFromFile(configPath: string, refreshTokenFile: string | undefined): string {
  if (!refreshTokenFile) {
    throw new Error(`${configPath} account must include refreshTokenFile or refreshToken`);
  }

  const parsed = JSON.parse(readFileSync(refreshTokenFile, 'utf8')) as { refresh_token?: string; refreshToken?: string };
  const refreshToken = parsed.refresh_token || parsed.refreshToken;
  if (!refreshToken) {
    throw new Error(`${refreshTokenFile} must include refresh_token`);
  }
  return refreshToken;
}

function parseGmailAccount(raw: string): GmailAccountConfig {
  const [id, displayName, refreshTokenName] = raw.split(':').map((part) => part.trim());
  if (!id || !displayName || !refreshTokenName) {
    throw new Error('GMAIL_ACCOUNTS entries must be formatted as id:displayName:REFRESH_TOKEN_ENV');
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Gmail account id must contain only letters, numbers, "_" or "-": ${id}`);
  }

  return {
    id,
    displayName,
    refreshToken: required(refreshTokenName)
  };
}

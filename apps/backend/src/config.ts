import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import type { AppConfig, Category, CleanupConfig, GmailAccountConfig, LlmClassifierConfig } from './types.js';

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

function boolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be "true" or "false"`);
}

export function loadConfig(): AppConfig {
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
    discord: {
      botToken: required('DISCORD_BOT_TOKEN'),
      digestChannelId: required('DISCORD_DIGEST_CHANNEL_ID'),
      realtimeChannelId: process.env.DISCORD_REALTIME_CHANNEL_ID || '',
      debugChannelId: process.env.DISCORD_DEBUG_CHANNEL_ID || '',
      debugCooldownMs: integer('DISCORD_DEBUG_COOLDOWN_MINUTES', 60) * 60 * 1000
    },
    digest: {
      timezone: process.env.DIGEST_TIMEZONE || 'Australia/Sydney',
      cron: process.env.DIGEST_CRON || '0 19 * * *',
      processCron: process.env.DIGEST_PROCESS_CRON || '*/5 * * * *',
      lookbackHours: integer('GMAIL_LOOKBACK_HOURS', 24),
      maxMessages: integer('GMAIL_MAX_MESSAGES', 100),
      unreadOnly: boolean('GMAIL_UNREAD_ONLY', true)
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
    cleanup: cleanupConfig(),
    database: {
      path: process.env.SQLITE_PATH || 'data/hedwig.db'
    }
  };
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

function cleanupConfig(): CleanupConfig {
  // Defaults: junk is disposable as soon as it is processed; fyi/admin are kept
  // for a grace window; course/action are never auto-trashed. Set any
  // CLEANUP_TTL_*_DAYS to "never" (or omit it) to keep that category forever.
  const defaults: Array<[Category, number | null]> = [
    ['junk', 0],
    ['fyi', 14],
    ['admin', 30],
    ['course', null],
    ['action', null]
  ];

  const ttlDays: Partial<Record<Category, number>> = {};
  for (const [category, fallback] of defaults) {
    const days = ttlDaysFor(`CLEANUP_TTL_${category.toUpperCase()}_DAYS`, fallback);
    if (days !== null) ttlDays[category] = days;
  }

  return {
    ttlDays,
    maxPerAccount: integer('CLEANUP_MAX_PER_ACCOUNT', 200)
  };
}

function ttlDaysFor(name: string, fallback: number | null): number | null {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '' || trimmed === 'never' || trimmed === 'off') return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer or "never"`);
  }
  return parsed;
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

import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import type { AppConfig, GmailAccountConfig } from './types.js';

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
      realtimeChannelId: process.env.DISCORD_REALTIME_CHANNEL_ID || ''
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
      llm: {
        apiKey: process.env.CLASSIFIER_API_KEY || process.env.DEEPSEEK_API_KEY || '',
        baseUrl: process.env.CLASSIFIER_API_BASE_URL || 'https://api.deepseek.com',
        model: process.env.CLASSIFIER_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro',
        providerName: process.env.CLASSIFIER_PROVIDER_NAME || (rawProvider === 'deepseek' ? 'deepseek' : 'openai-compatible')
      }
    },
    database: {
      path: process.env.SQLITE_PATH || 'data/hedwig.db'
    }
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

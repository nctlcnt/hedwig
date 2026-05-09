import 'dotenv/config';
import type { AppConfig } from './types.js';

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
  const rawProvider = process.env.CLASSIFIER_PROVIDER || (process.env.GEMINI_API_KEY ? 'gemini' : 'rule');
  if (rawProvider !== 'rule' && rawProvider !== 'gemini') {
    throw new Error(`CLASSIFIER_PROVIDER must be "rule" or "gemini", got: ${rawProvider}`);
  }

  return {
    google: {
      clientId: required('GOOGLE_CLIENT_ID'),
      clientSecret: required('GOOGLE_CLIENT_SECRET'),
      redirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost',
      refreshToken: required('GOOGLE_REFRESH_TOKEN')
    },
    discord: {
      botToken: required('DISCORD_BOT_TOKEN'),
      digestChannelId: required('DISCORD_DIGEST_CHANNEL_ID')
    },
    digest: {
      timezone: process.env.DIGEST_TIMEZONE || 'Australia/Sydney',
      cron: process.env.DIGEST_CRON || '0 19 * * *',
      lookbackHours: integer('GMAIL_LOOKBACK_HOURS', 24),
      maxMessages: integer('GMAIL_MAX_MESSAGES', 100)
    },
    classifier: {
      provider: rawProvider,
      gemini: {
        apiKey: process.env.GEMINI_API_KEY || '',
        model: process.env.GEMINI_MODEL || 'gemini-2.5-flash'
      }
    },
    database: {
      path: process.env.SQLITE_PATH || 'data/hedwig.db'
    }
  };
}

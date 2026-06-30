import type { gmail_v1 } from 'googleapis';

export type Category = 'action' | 'fyi' | 'course' | 'admin' | 'junk';
export type ProcessingAction = 'archive' | 'digest_only' | 'push_now';

export type AppConfig = {
  google: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    accounts: GmailAccountConfig[];
  };
  discord: {
    botToken: string;
    digestChannelId: string;
    realtimeChannelId: string;
    // Optional operational-error channel. Alerts here are deduped: the same
    // problem signature is silenced for debugCooldownMs after it fires.
    debugChannelId: string;
    debugCooldownMs: number;
  };
  digest: {
    timezone: string;
    cron: string;
    processCron: string;
    lookbackHours: number;
    maxMessages: number;
    unreadOnly: boolean;
  };
  classifier: {
    provider: 'rule' | 'openai-compatible';
    rulesPath: string;
    llm: LlmClassifierConfig;
    // Optional secondary LLM tried when the primary one fails (rate limit,
    // outage, insufficient balance) before giving up to the rule classifier.
    fallbackLlm?: LlmClassifierConfig;
    // Per-request resilience for the LLM calls. maxRetries drives the SDK's
    // exponential backoff (which honors Retry-After), so a 429 rate limit
    // self-throttles instead of immediately dropping to the fallback chain.
    maxRetries: number;
    requestTimeoutMs: number;
  };
  cleanup: CleanupConfig;
  database: {
    path: string;
  };
};

export type LlmClassifierConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  providerName: string;
};

export type ClassifierFailure = {
  from: string;
  subject: string;
  gmailUrl: string;
  reason: string;
};

export type CleanupConfig = {
  // Per-category time-to-live in days. A category present here is eligible for
  // trashing once it is older than the given number of days. Categories that
  // are absent are never trashed (e.g. course, action by default).
  ttlDays: Partial<Record<Category, number>>;
  maxPerAccount: number;
};

export type CleanupCandidate = {
  accountId: string;
  gmailId: string;
  threadId: string;
  accountEmail: string;
  from: string;
  subject: string;
  category: Category;
  importance: number;
  summary: string;
  processedAt: string;
};

export type GmailAccountConfig = {
  id: string;
  displayName: string;
  refreshToken: string;
};

export type GmailClient = gmail_v1.Gmail;

export type EmailMessage = {
  accountId: string;
  accountEmail: string;
  id: string;
  threadId: string;
  labelIds: string[];
  headers: gmail_v1.Schema$MessagePartHeader[];
  subject: string;
  from: string;
  date: Date | null;
  snippet: string;
  text: string;
  gmailUrl: string;
};

export type Classification = {
  category: Category;
  importance: number;
  summary: string;
  confidence: number;
  reason?: string;
  provider: string;
};

export type DigestItem = {
  accountId: string;
  accountName: string;
  mailId: string;
  id: string;
  category: Category;
  from: string;
  subject: string;
  summary: string;
  importance: number;
  confidence: number;
  provider: string;
  processedAs: ProcessingAction;
  gmailUrl: string;
};

export type EmailPreviewLink = {
  url: string;
  label?: string;
};

export type CachedEmailPreview = {
  accountId: string;
  accountName: string;
  mailId: string;
  id: string;
  from: string;
  subject: string;
  summary: string;
  bodyText: string;
  links: EmailPreviewLink[];
  gmailUrl: string;
  expiresAt: string;
};

export type DigestSection = {
  category: Category;
  title: string;
  items: DigestItem[];
  lead?: string;
};

export type DigestAccountSummary = {
  accountId: string;
  accountName: string;
  accountEmail: string;
  runId: number;
  total: number;
  counts: Record<Category, number>;
  error?: string;
};

export type DigestReport = {
  runIds: number[];
  account: string;
  date: string;
  total: number;
  counts: Record<Category, number>;
  accounts: DigestAccountSummary[];
  sections: DigestSection[];
};

export type EmailClassifier = {
  classify(email: EmailMessage): Promise<Classification>;
};

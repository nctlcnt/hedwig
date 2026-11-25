import type { gmail_v1 } from 'googleapis';

export type Category = 'action' | 'fyi' | 'course' | 'admin' | 'junk';
export type ProcessingOutcome = 'suppress' | 'digest_only' | 'push_now';

export type AppConfig = DiscordAppConfig | TelegramAppConfig;

export type DiscordAppConfig = CommonAppConfig & {
  messagingProvider: 'discord';
  discord: {
    botToken: string;
    digestChannelId: string;
    realtimeChannelId: string;
    debugChannelId: string;
    debugCooldownMs: number;
  };
  followup: FollowupConfig;
};

export type TelegramAppConfig = CommonAppConfig & {
  messagingProvider: 'telegram';
  telegram: TelegramConfig;
};

export type TelegramConfig = {
  botToken: string;
  ownerUserId: number;
  chatId: number;
  debugChatId: number | null;
  debugCooldownMs: number;
};

type CommonAppConfig = {
  google: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    accounts: GmailAccountConfig[];
  };
  digest: {
    timezone: string;
    cron: string;
    processCron: string;
    lookbackHours: number;
    maxMessages: number;
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
  database: {
    path: string;
  };
};

export type FollowupConfig = {
  enabled: boolean;
  forumChannelId: string;
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
  attentionPoints: string[];
  suggestedActions: string[];
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
  attentionPoints: string[];
  suggestedActions: string[];
  importance: number;
  confidence: number;
  provider: string;
  processingOutcome: ProcessingOutcome;
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
  attentionPoints: string[];
  suggestedActions: string[];
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

export type BatchClassificationResult = {
  emailId: string;
  classification: Classification;
};

export type EmailClassifier = {
  classify(email: EmailMessage): Promise<Classification>;
  // First version calls classify() once per email; a real batched LLM call
  // lands in a later micro-batch step (see docs/micro-batch.md).
  classifyBatch(emails: EmailMessage[]): Promise<BatchClassificationResult[]>;
};

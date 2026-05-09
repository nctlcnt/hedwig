import type { gmail_v1 } from 'googleapis';

export type Category = 'action' | 'fyi' | 'course' | 'admin' | 'junk';

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
  };
  digest: {
    timezone: string;
    cron: string;
    lookbackHours: number;
    maxMessages: number;
    unreadOnly: boolean;
  };
  classifier: {
    provider: 'rule' | 'gemini';
    gemini: {
      apiKey: string;
      model: string;
    };
  };
  database: {
    path: string;
  };
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
  gmailLabel: string;
  importance: number;
  summary: string;
  confidence: number;
  reason?: string;
  provider: string;
};

export type DigestItem = {
  accountId: string;
  accountName: string;
  id: string;
  from: string;
  subject: string;
  summary: string;
  importance: number;
  confidence: number;
  provider: string;
  gmailUrl: string;
};

export type DigestSection = {
  category: Category;
  title: string;
  items: DigestItem[];
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

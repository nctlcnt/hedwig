import type { EmailMessage } from '../types.js';

export type MailAccount = {
  id: string;
  displayName: string;
};

export type MailMessageRef = {
  id?: string | null;
};

export type MailListOptions = {
  lookbackHours: number;
  maxMessages: number;
  unreadOnly: boolean;
};

export type MailSyncOptions = {
  // Opaque per-account cursor from the previous sync (null on first run). The
  // gateway is responsible for its own cursor semantics; callers only store and
  // replay it.
  cursor: string | null;
  lookbackHours: number;
  maxMessages: number;
};

export type MailSyncResult = {
  refs: MailMessageRef[];
  cursor: string;
  // True when the gateway could not sync incrementally and fell back to a full
  // window scan (first run or expired cursor).
  reset: boolean;
};

export type MailGateway = {
  listAccounts(): MailAccount[];
  getCurrentUser(account: MailAccount): Promise<string>;
  getFollowupLabelId(account: MailAccount): Promise<string | null>;
  listRecentInboxMessages(account: MailAccount, options: MailListOptions): Promise<MailMessageRef[]>;
  listUnreadInboxMessages(account: MailAccount, options: { limit: number }): Promise<MailMessageRef[]>;
  syncInboxMessages(account: MailAccount, options: MailSyncOptions): Promise<MailSyncResult>;
  getMessage(account: MailAccount, accountEmail: string, id: string): Promise<EmailMessage>;
  getMessageLabels(account: MailAccount, id: string): Promise<string[] | null>;
  markMessagesRead(account: MailAccount, messageIds: string[]): Promise<void>;
  removeFromInbox(account: MailAccount, messageIds: string[]): Promise<void>;
  trashMessages(account: MailAccount, messageIds: string[]): Promise<void>;
};

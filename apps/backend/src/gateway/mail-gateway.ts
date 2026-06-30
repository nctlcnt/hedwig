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

export type MailGateway = {
  listAccounts(): MailAccount[];
  getCurrentUser(account: MailAccount): Promise<string>;
  ensureFollowupLabel(account: MailAccount): Promise<string>;
  listRecentInboxMessages(account: MailAccount, options: MailListOptions): Promise<MailMessageRef[]>;
  listUnreadInboxMessages(account: MailAccount, options: { limit: number }): Promise<MailMessageRef[]>;
  getMessage(account: MailAccount, accountEmail: string, id: string): Promise<EmailMessage>;
  getMessageLabels(account: MailAccount, id: string): Promise<string[] | null>;
  markMessagesRead(account: MailAccount, messageIds: string[]): Promise<void>;
  removeFromInbox(account: MailAccount, messageIds: string[]): Promise<void>;
  trashMessages(account: MailAccount, messageIds: string[]): Promise<void>;
};

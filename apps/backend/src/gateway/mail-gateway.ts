import type { EmailMessage } from '../types.js';

export type MailAccount = {
  id: string;
  displayName: string;
};

export type MailMessageRef = {
  id?: string | null;
};

export type MailLabelMap = Map<string, string>;

export type MailListOptions = {
  lookbackHours: number;
  maxMessages: number;
  unreadOnly: boolean;
};

export type MailGateway = {
  listAccounts(): MailAccount[];
  getCurrentUser(account: MailAccount): Promise<string>;
  ensureAutoLabels(account: MailAccount): Promise<MailLabelMap>;
  listRecentInboxMessages(account: MailAccount, options: MailListOptions): Promise<MailMessageRef[]>;
  getMessage(account: MailAccount, accountEmail: string, id: string): Promise<EmailMessage>;
  applyLabel(account: MailAccount, messageId: string, labelId: string, removeLabelIds?: string[]): Promise<void>;
  markMessagesRead(account: MailAccount, messageIds: string[]): Promise<void>;
  removeFromInbox(account: MailAccount, messageIds: string[]): Promise<void>;
};

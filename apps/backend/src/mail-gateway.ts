import type { AppConfig, EmailMessage } from './types.js';

export type MailAccount = {
  id: string;
  displayName: string;
};

export type MailMessageRef = {
  id?: string | null;
};

export type MailProfile = {
  emailAddress: string;
};

export type MailListOptions = Pick<AppConfig['digest'], 'lookbackHours' | 'maxMessages' | 'unreadOnly'>;

export type MailGateway = {
  listAccounts(): Promise<MailAccount[]> | MailAccount[];
  getCurrentUserProfile(account: MailAccount): Promise<MailProfile>;
  ensureFollowupLabel(account: MailAccount): Promise<string>;
  listRecentInboxMessages(account: MailAccount, options: MailListOptions): Promise<MailMessageRef[]>;
  getMessage(account: MailAccount, accountEmail: string, id: string): Promise<EmailMessage>;
  markMessagesRead(account: MailAccount, messageIds: string[]): Promise<void>;
};

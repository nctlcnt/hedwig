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
  ensureAutoLabels(account: MailAccount): Promise<Map<string, string>>;
  listRecentInboxMessages(account: MailAccount, options: MailListOptions): Promise<MailMessageRef[]>;
  getMessage(account: MailAccount, accountEmail: string, id: string): Promise<EmailMessage>;
  applyLabel(
    account: MailAccount,
    messageId: string,
    labelId: string,
    removeLabelIds?: string[]
  ): Promise<void>;
  markMessagesRead(account: MailAccount, messageIds: string[]): Promise<void>;
};

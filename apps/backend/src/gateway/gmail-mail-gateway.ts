import {
  applyLabel,
  createGmailClient,
  ensureAutoLabels,
  getCurrentUser,
  getMessage,
  listRecentInboxMessages,
  markMessagesRead,
  removeFromInbox
} from '../gmail.js';
import type { AppConfig, EmailMessage, GmailAccountConfig, GmailClient } from '../types.js';
import type { MailAccount, MailGateway, MailListOptions, MailMessageRef } from './mail-gateway.js';

export function createGmailMailGateway(config: AppConfig): MailGateway {
  return new GmailMailGateway(config);
}

class GmailMailGateway implements MailGateway {
  private readonly accountsById: Map<string, GmailAccountConfig>;
  private readonly clientsById = new Map<string, GmailClient>();

  constructor(private readonly config: AppConfig) {
    this.accountsById = new Map(config.google.accounts.map((account) => [account.id, account]));
  }

  listAccounts(): MailAccount[] {
    return this.config.google.accounts.map((account) => ({
      id: account.id,
      displayName: account.displayName
    }));
  }

  async getCurrentUser(account: MailAccount): Promise<string> {
    return getCurrentUser(this.clientFor(account));
  }

  async ensureAutoLabels(account: MailAccount): Promise<Map<string, string>> {
    return ensureAutoLabels(this.clientFor(account));
  }

  async listRecentInboxMessages(account: MailAccount, options: MailListOptions): Promise<MailMessageRef[]> {
    return listRecentInboxMessages(this.clientFor(account), options);
  }

  async getMessage(account: MailAccount, accountEmail: string, id: string): Promise<EmailMessage> {
    return getMessage(this.clientFor(account), this.configFor(account), accountEmail, id);
  }

  async applyLabel(account: MailAccount, messageId: string, labelId: string, removeLabelIds: string[] = []): Promise<void> {
    await applyLabel(this.clientFor(account), messageId, labelId, removeLabelIds);
  }

  async markMessagesRead(account: MailAccount, messageIds: string[]): Promise<void> {
    await markMessagesRead(this.clientFor(account), messageIds);
  }

  async removeFromInbox(account: MailAccount, messageIds: string[]): Promise<void> {
    await removeFromInbox(this.clientFor(account), messageIds);
  }

  private clientFor(account: MailAccount): GmailClient {
    const existing = this.clientsById.get(account.id);
    if (existing) return existing;

    const accountConfig = this.configFor(account);
    const client = createGmailClient(this.config, accountConfig);
    this.clientsById.set(account.id, client);
    return client;
  }

  private configFor(account: MailAccount): GmailAccountConfig {
    const accountConfig = this.accountsById.get(account.id);
    if (!accountConfig) {
      throw new Error(`Unknown Gmail account id: ${account.id}`);
    }
    return accountConfig;
  }
}

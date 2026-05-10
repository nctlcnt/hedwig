import {
  applyLabel,
  createGmailClient,
  ensureAutoLabels,
  getCurrentUser,
  getMessage,
  listRecentInboxMessages,
  markMessagesRead
} from './gmail.js';
import type { MailAccount, MailGateway, MailListOptions, MailMessageRef, MailProfile } from './mail-gateway.js';
import type { AppConfig, EmailMessage, GmailAccountConfig, GmailClient } from './types.js';

export class GmailMailGateway implements MailGateway {
  private readonly clients = new Map<string, GmailClient>();

  constructor(private readonly config: AppConfig) {}

  listAccounts(): MailAccount[] {
    return this.config.google.accounts.map(({ id, displayName }) => ({ id, displayName }));
  }

  async getCurrentUserProfile(account: MailAccount): Promise<MailProfile> {
    return {
      emailAddress: await getCurrentUser(this.clientFor(account))
    };
  }

  async ensureAutoLabels(account: MailAccount): Promise<Map<string, string>> {
    return ensureAutoLabels(this.clientFor(account));
  }

  async listRecentInboxMessages(account: MailAccount, options: MailListOptions): Promise<MailMessageRef[]> {
    const messages = await listRecentInboxMessages(this.clientFor(account), options);
    return messages.map((message) => ({ id: message.id }));
  }

  async getMessage(account: MailAccount, accountEmail: string, id: string): Promise<EmailMessage> {
    return getMessage(this.clientFor(account), this.accountConfig(account), accountEmail, id);
  }

  async applyLabel(
    account: MailAccount,
    messageId: string,
    labelId: string,
    removeLabelIds: string[] = []
  ): Promise<void> {
    await applyLabel(this.clientFor(account), messageId, labelId, removeLabelIds);
  }

  async markMessagesRead(account: MailAccount, messageIds: string[]): Promise<void> {
    await markMessagesRead(this.clientFor(account), messageIds);
  }

  private clientFor(account: MailAccount): GmailClient {
    const existing = this.clients.get(account.id);
    if (existing) return existing;

    const client = createGmailClient(this.config, this.accountConfig(account));
    this.clients.set(account.id, client);
    return client;
  }

  private accountConfig(account: MailAccount): GmailAccountConfig {
    const found = this.config.google.accounts.find((item) => item.id === account.id);
    if (!found) {
      throw new Error(`Unknown Gmail account id: ${account.id}`);
    }
    return found;
  }
}

export function createGmailMailGateway(config: AppConfig): MailGateway {
  return new GmailMailGateway(config);
}

import { google } from 'googleapis';
import type { gmail_v1 } from 'googleapis';
import type { AppConfig, EmailMessage, GmailAccountConfig, GmailClient } from './types.js';

const AUTO_LABELS = [
  'AUTO/action',
  'AUTO/fyi',
  'AUTO/course',
  'AUTO/admin',
  'AUTO/junk',
  'AUTO/digest'
];

export function createGmailClient(config: AppConfig, account: GmailAccountConfig): GmailClient {
  const auth = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );
  auth.setCredentials({ refresh_token: account.refreshToken });
  return google.gmail({ version: 'v1', auth });
}

export async function getCurrentUser(gmail: GmailClient): Promise<string> {
  const response = await gmail.users.getProfile({ userId: 'me' });
  return response.data.emailAddress || 'me';
}

export async function ensureAutoLabels(gmail: GmailClient): Promise<Map<string, string>> {
  const existing = await gmail.users.labels.list({ userId: 'me' });
  const byName = new Map((existing.data.labels || []).map((label) => [label.name, label]));
  const labels = new Map<string, string>();

  for (const name of AUTO_LABELS) {
    const current = byName.get(name);
    if (current?.id) {
      labels.set(name, current.id);
      continue;
    }

    const created = await gmail.users.labels.create({
      userId: 'me',
      requestBody: {
        name,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show'
      }
    });
    if (!created.data.id) {
      throw new Error(`Gmail did not return an id for created label: ${name}`);
    }
    labels.set(name, created.data.id);
  }

  return labels;
}

export async function listRecentInboxMessages(
  gmail: GmailClient,
  { lookbackHours, maxMessages, unreadOnly }: AppConfig['digest']
): Promise<gmail_v1.Schema$Message[]> {
  const afterSeconds = Math.floor((Date.now() - lookbackHours * 60 * 60 * 1000) / 1000);
  const unreadQuery = unreadOnly ? ' is:unread' : '';
  const response = await gmail.users.messages.list({
    userId: 'me',
    maxResults: maxMessages,
    q: `in:inbox${unreadQuery} -in:spam -in:trash after:${afterSeconds}`
  });

  return response.data.messages || [];
}

export async function getMessage(
  gmail: GmailClient,
  account: GmailAccountConfig,
  accountEmail: string,
  id: string
): Promise<EmailMessage> {
  const response = await gmail.users.messages.get({
    userId: 'me',
    id,
    format: 'full'
  });
  return normalizeMessage(response.data, account, accountEmail);
}

export async function applyLabel(
  gmail: GmailClient,
  messageId: string,
  labelId: string,
  removeLabelIds: string[] = []
): Promise<void> {
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: {
      addLabelIds: [labelId],
      removeLabelIds
    }
  });
}

export async function markMessagesRead(gmail: GmailClient, messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) return;

  await gmail.users.messages.batchModify({
    userId: 'me',
    requestBody: {
      ids: messageIds,
      removeLabelIds: ['UNREAD']
    }
  });
}

function normalizeMessage(
  message: gmail_v1.Schema$Message,
  account: GmailAccountConfig,
  accountEmail: string
): EmailMessage {
  const headers = message.payload?.headers || [];
  const subject = header(headers, 'Subject') || '(no subject)';
  const from = header(headers, 'From') || '(unknown sender)';
  const date = parseDate(header(headers, 'Date'), Number.parseInt(message.internalDate || '', 10));

  return {
    accountId: account.id,
    accountEmail,
    id: requireMessageField(message.id, 'id'),
    threadId: requireMessageField(message.threadId, 'threadId'),
    labelIds: message.labelIds || [],
    headers,
    subject,
    from,
    date,
    snippet: message.snippet || '',
    text: extractText(message.payload),
    gmailUrl: `https://mail.google.com/mail/u/${encodeURIComponent(accountEmail)}/#inbox/${message.threadId}`
  };
}

function header(headers: gmail_v1.Schema$MessagePartHeader[], name: string): string {
  const found = headers.find((item) => item.name?.toLowerCase() === name.toLowerCase());
  return found?.value || '';
}

function parseDate(dateHeader: string, internalDate: number): Date | null {
  const parsed = dateHeader ? new Date(dateHeader) : null;
  if (parsed && !Number.isNaN(parsed.getTime())) return parsed;
  if (Number.isFinite(internalDate)) return new Date(internalDate);
  return null;
}

function extractText(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) return '';
  const chunks: string[] = [];
  visitParts(part, chunks);
  return chunks.join('\n').replace(/\s+/g, ' ').trim().slice(0, 8000);
}

function visitParts(part: gmail_v1.Schema$MessagePart, chunks: string[]): void {
  const mimeType = part.mimeType || '';
  if (mimeType === 'text/plain' || mimeType === 'text/html') {
    const raw = part.body?.data;
    if (raw) {
      const text = Buffer.from(raw, 'base64url').toString('utf8');
      chunks.push(stripHtml(text));
    }
  }
  for (const child of part.parts || []) {
    visitParts(child, chunks);
  }
}

function stripHtml(text: string): string {
  return text
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function requireMessageField(value: string | null | undefined, name: string): string {
  if (!value) {
    throw new Error(`Gmail message is missing required field: ${name}`);
  }
  return value;
}

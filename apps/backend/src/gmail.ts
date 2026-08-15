import { google } from 'googleapis';
import type { gmail_v1 } from 'googleapis';
import { buildGmailMessageUrl } from './gmail-url.js';
import type { AppConfig, EmailMessage, GmailAccountConfig, GmailClient } from './types.js';

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

export async function listRecentInboxMessages(
  gmail: GmailClient,
  { lookbackHours, maxMessages }: Pick<AppConfig['digest'], 'lookbackHours' | 'maxMessages'>
): Promise<gmail_v1.Schema$Message[]> {
  const afterSeconds = Math.floor((Date.now() - lookbackHours * 60 * 60 * 1000) / 1000);
  const response = await gmail.users.messages.list({
    userId: 'me',
    maxResults: maxMessages,
    q: `in:inbox -in:spam -in:trash after:${afterSeconds}`
  });

  return response.data.messages || [];
}

export type InboxSyncResult = {
  messages: gmail_v1.Schema$Message[];
  cursor: string;
  reset: boolean;
};

export async function getProfileHistoryId(gmail: GmailClient): Promise<string> {
  const response = await gmail.users.getProfile({ userId: 'me' });
  if (!response.data.historyId) {
    throw new Error('Gmail profile did not return a historyId');
  }
  return String(response.data.historyId);
}

// Incremental inbox sync. With a cursor (a previously stored Gmail historyId) it
// returns only messages added to the Inbox since that point, fully independent
// of read/star/label state. Without a cursor — or when Gmail reports the cursor
// has expired (404) — it bootstraps by capturing the current historyId and
// scanning the recent window once. The historyId is captured before the window
// scan so nothing added mid-scan is skipped next run; downstream dedup prevents
// any reprocessing.
export async function syncInboxMessages(
  gmail: GmailClient,
  { cursor, lookbackHours, maxMessages }: { cursor: string | null; lookbackHours: number; maxMessages: number }
): Promise<InboxSyncResult> {
  if (cursor) {
    try {
      return await historyInboxMessages(gmail, cursor);
    } catch (error) {
      if (!isHistoryExpired(error)) throw error;
      // Cursor too old for Gmail's history retention: fall through to bootstrap.
    }
  }

  const freshCursor = await getProfileHistoryId(gmail);
  const messages = await listRecentInboxMessages(gmail, { lookbackHours, maxMessages });
  return { messages, cursor: freshCursor, reset: true };
}

async function historyInboxMessages(
  gmail: GmailClient,
  startHistoryId: string
): Promise<InboxSyncResult> {
  const byId = new Map<string, gmail_v1.Schema$Message>();
  let latestHistoryId = startHistoryId;
  let pageToken: string | undefined;

  do {
    const response = await gmail.users.history.list({
      userId: 'me',
      startHistoryId,
      historyTypes: ['messageAdded'],
      labelId: 'INBOX',
      maxResults: 500,
      pageToken
    });
    // history.list always returns the mailbox's current historyId, even with no
    // new records, so advancing the cursor keeps it from going stale.
    if (response.data.historyId) latestHistoryId = String(response.data.historyId);
    for (const record of response.data.history || []) {
      for (const added of record.messagesAdded || []) {
        const message = added.message;
        if (!message?.id) continue;
        const labels = message.labelIds || [];
        if (labels.includes('SPAM') || labels.includes('TRASH')) continue;
        byId.set(message.id, { id: message.id, threadId: message.threadId });
      }
    }
    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);

  return { messages: [...byId.values()], cursor: latestHistoryId, reset: false };
}

function isHistoryExpired(error: unknown): boolean {
  const candidate = error as { code?: number; status?: number; response?: { status?: number } };
  return candidate?.code === 404 || candidate?.status === 404 || candidate?.response?.status === 404;
}

export async function getMessage(
  gmail: GmailClient,
  account: GmailAccountConfig,
  accountEmail: string,
  id: string
): Promise<EmailMessage | null> {
  try {
    const response = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'full'
    });
    return normalizeMessage(response.data, account, accountEmail);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  return candidate.code === 404 || candidate.status === 404 || candidate.response?.status === 404;
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
    gmailUrl: buildGmailMessageUrl(accountEmail, requireMessageField(message.threadId, 'threadId'))
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
    .replace(/\s(?:href|src)=["'](https?:\/\/[^"']+)["']/gi, ' $1 ')
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

import { google } from 'googleapis';
import type { gmail_v1 } from 'googleapis';
import { buildGmailMessageUrl } from './gmail-url.js';
import type { AppConfig, EmailMessage, GmailAccountConfig, GmailClient } from './types.js';

const FOLLOWUP_LABEL = 'Hedwig/Followup';

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

export async function ensureFollowupLabel(gmail: GmailClient): Promise<string> {
  const existing = await gmail.users.labels.list({ userId: 'me' });
  const byName = new Map((existing.data.labels || []).map((label) => [label.name, label]));
  const current = byName.get(FOLLOWUP_LABEL);
  if (current?.id) {
    return current.id;
  }

  const created = await gmail.users.labels.create({
    userId: 'me',
    requestBody: {
      name: FOLLOWUP_LABEL,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show'
    }
  });
  if (!created.data.id) {
    throw new Error(`Gmail did not return an id for created label: ${FOLLOWUP_LABEL}`);
  }
  return created.data.id;
}

export async function listRecentInboxMessages(
  gmail: GmailClient,
  { lookbackHours, maxMessages, unreadOnly }: Pick<AppConfig['digest'], 'lookbackHours' | 'maxMessages' | 'unreadOnly'>
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

export async function listUnreadInboxMessages(
  gmail: GmailClient,
  limit: number
): Promise<gmail_v1.Schema$Message[]> {
  const response = await gmail.users.messages.list({
    userId: 'me',
    maxResults: limit,
    q: 'in:inbox is:unread -in:spam -in:trash'
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
  const messages = await listRecentInboxMessages(gmail, { lookbackHours, maxMessages, unreadOnly: false });
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
): Promise<EmailMessage> {
  const response = await gmail.users.messages.get({
    userId: 'me',
    id,
    format: 'full'
  });
  return normalizeMessage(response.data, account, accountEmail);
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

export async function removeFromInbox(gmail: GmailClient, messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) return;

  await gmail.users.messages.batchModify({
    userId: 'me',
    requestBody: {
      ids: messageIds,
      removeLabelIds: ['INBOX']
    }
  });
}

// Returns the current label ids for a message, or null if Gmail no longer has it
// (already deleted out of band). Uses the minimal format to avoid downloading
// the body during the cleanup pass.
export async function getMessageLabels(gmail: GmailClient, id: string): Promise<string[] | null> {
  try {
    const response = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'minimal'
    });
    return response.data.labelIds || [];
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

export async function trashMessages(gmail: GmailClient, messageIds: string[]): Promise<void> {
  // Gmail rejects adding the TRASH label through messages.modify, so each message
  // must go through the dedicated trash endpoint. Trashed mail is recoverable
  // from Gmail's Trash for 30 days.
  for (const id of messageIds) {
    await gmail.users.messages.trash({ userId: 'me', id });
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

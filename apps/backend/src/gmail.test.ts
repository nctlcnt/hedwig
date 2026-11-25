import assert from 'node:assert/strict';
import { getMessage, syncInboxMessages } from './gmail.js';
import type { GmailAccountConfig, GmailClient } from './types.js';

const calls: Array<string | undefined> = [];
const gmail = {
  users: {
    history: {
      async list({ pageToken }: { pageToken?: string }) {
        calls.push(pageToken);
        if (!pageToken) {
          return {
            data: {
              historyId: '200',
              nextPageToken: 'page-2',
              history: [{
                messagesAdded: [
                  { message: { id: 'message-1', threadId: 'thread-1', labelIds: ['INBOX'] } },
                  { message: { id: 'message-2', threadId: 'thread-2', labelIds: ['INBOX'] } }
                ]
              }]
            }
          };
        }

        return {
          data: {
            historyId: '300',
            history: [{
              messagesAdded: [
                { message: { id: 'message-3', threadId: 'thread-3', labelIds: ['INBOX'] } }
              ]
            }]
          }
        };
      }
    }
  }
} as unknown as GmailClient;

const result = await syncInboxMessages(gmail, {
  cursor: '100',
  lookbackHours: 24,
  maxMessages: 1
});

assert.deepEqual(calls, [undefined, 'page-2']);
assert.equal(result.cursor, '300');
assert.equal(result.reset, false);
assert.deepEqual(result.messages.map((message) => message.id), ['message-1', 'message-2', 'message-3']);

const missingMessageGmail = {
  users: {
    messages: {
      async get() {
        throw { response: { status: 404 } };
      }
    }
  }
} as unknown as GmailClient;
const account: GmailAccountConfig = {
  id: 'primary',
  displayName: 'Primary',
  refreshToken: 'unused'
};
assert.equal(
  await getMessage(missingMessageGmail, account, 'me@example.com', 'vanished-1'),
  null
);

const unavailableGmail = {
  users: {
    messages: {
      async get() {
        throw { response: { status: 503 } };
      }
    }
  }
} as unknown as GmailClient;
await assert.rejects(
  getMessage(unavailableGmail, account, 'me@example.com', 'message-1'),
  (error: unknown) => (error as { response?: { status?: number } }).response?.status === 503
);

console.log('gmail.test.ts: all assertions passed');

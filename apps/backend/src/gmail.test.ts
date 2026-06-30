import assert from 'node:assert/strict';
import { syncInboxMessages } from './gmail.js';
import type { GmailClient } from './types.js';

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

console.log('gmail.test.ts: all assertions passed');

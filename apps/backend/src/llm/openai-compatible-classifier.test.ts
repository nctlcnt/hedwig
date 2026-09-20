import assert from 'node:assert/strict';
import { buildBatchSystemPrompt, buildBatchUserContent } from './openai-compatible-classifier.js';
import type { EmailMessage } from '../types.js';

function email(overrides: Partial<EmailMessage>): EmailMessage {
  return {
    accountId: 'primary',
    accountEmail: 'me@example.com',
    id: 'gmail-1',
    threadId: 'thread-1',
    labelIds: [],
    headers: [],
    subject: '',
    from: 'Sender <sender@example.com>',
    date: null,
    snippet: '',
    text: '',
    gmailUrl: 'https://mail.google.com/mail/u/me/#all/thread-1',
    ...overrides
  };
}

// buildBatchUserContent: EMAILS_JSON wraps an array of per-email payloads,
// each carrying the emailId used to reconcile results with inputs (section 9).
{
  const emails = [
    email({ id: 'abc123', subject: 'Assignment due Friday', text: 'body one' }),
    email({ id: 'def456', subject: 'Weekly newsletter', text: 'x'.repeat(7000) })
  ];
  const content = buildBatchUserContent(emails);
  assert.ok(content.startsWith('EMAILS_JSON:\n'));

  const payloads = JSON.parse(content.slice('EMAILS_JSON:\n'.length));
  assert.equal(payloads.length, 2);
  assert.deepEqual(payloads.map((item: { emailId: string }) => item.emailId), ['abc123', 'def456']);
  assert.equal(payloads[0].subject, 'Assignment due Friday');
  // Same 6000-char truncation as the single-email path (buildEmailPayload).
  assert.equal(payloads[1].text.length, 6000);
}

// buildBatchSystemPrompt: keeps the shared classification rules, but swaps in
// the batch-mode instructions and the { "results": [...] } schema hint
// instead of the single-email schema.
{
  const systemPrompt = buildBatchSystemPrompt('', null);
  assert.ok(systemPrompt.includes('independent classification tasks'));
  assert.ok(systemPrompt.includes('"results"'));
  assert.ok(systemPrompt.includes('Categories:'), 'must keep the shared category rules');
  assert.ok(!systemPrompt.includes('EMAIL_JSON'), 'must not leak the single-email schema hint');
}

console.log('llm/openai-compatible-classifier.test.ts: all assertions passed');

import assert from 'node:assert/strict';
import { validateBatchResults } from './classification-batch-validation.js';
import type { EmailMessage } from './types.js';

function email(id: string): EmailMessage {
  return {
    accountId: 'primary',
    accountEmail: 'me@example.com',
    id,
    threadId: `thread-${id}`,
    labelIds: [],
    headers: [],
    subject: `Subject ${id}`,
    from: 'Sender <sender@example.com>',
    date: null,
    snippet: '',
    text: '',
    gmailUrl: `https://mail.google.com/mail/u/me/#all/thread-${id}`
  };
}

function item(emailId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    emailId,
    category: 'fyi',
    summary: `Summary for ${emailId}`,
    attentionPoints: [],
    suggestedActions: [],
    importance: 30,
    confidence: 0.7,
    reason: 'test',
    ...overrides
  };
}

const inputs = ['A', 'B', 'C'].map(email);

// All results valid: association is by emailId, so a shuffled response order
// still comes back in input order with each classification on the right email.
{
  const result = validateBatchResults(inputs, [item('C'), item('A'), item('B')], 'gemini');
  assert.ok(result.ok);
  if (!result.ok) throw new Error('unreachable');
  assert.deepEqual(result.valid.map((entry) => entry.emailId), ['A', 'B', 'C']);
  assert.equal(result.valid[0]!.classification.summary, 'Summary for A');
  assert.equal(result.valid[0]!.classification.provider, 'gemini');
  assert.deepEqual(result.retry, []);
  assert.deepEqual(result.problems, []);
}

// Section 12.3: a missing item does not fail the batch; it is reported and
// queued for a single-email retry while the other results stay usable.
{
  const result = validateBatchResults(inputs, [item('A'), item('C')], 'gemini');
  assert.ok(result.ok);
  if (!result.ok) throw new Error('unreachable');
  assert.deepEqual(result.valid.map((entry) => entry.emailId), ['A', 'C']);
  assert.deepEqual(result.retry.map((entry) => entry.id), ['B']);
  assert.deepEqual(result.problems, [{ emailId: 'B', reason: 'missing from the model response' }]);
}

// Section 12.2: an unknown emailId is rejected on its own, without affecting
// the valid results, and does not count as one of the input emails.
{
  const result = validateBatchResults(inputs, [item('A'), item('B'), item('C'), item('ZZZ')], 'gemini');
  assert.ok(result.ok);
  if (!result.ok) throw new Error('unreachable');
  assert.deepEqual(result.valid.map((entry) => entry.emailId), ['A', 'B', 'C']);
  assert.deepEqual(result.retry, []);
  assert.equal(result.problems.length, 1);
  assert.equal(result.problems[0]!.emailId, 'ZZZ');
}

// Section 12.1: a duplicate emailId invalidates the whole batch.
{
  const result = validateBatchResults(inputs, [item('A'), item('A'), item('B'), item('C')], 'gemini');
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.equal(result.reason, 'duplicate-email-id');
  assert.deepEqual(result.duplicateEmailIds, ['A']);
}

// A response whose "results" is not an array invalidates the whole batch.
{
  const result = validateBatchResults(inputs, { A: item('A') }, 'gemini');
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.equal(result.reason, 'results-not-array');
}

// Section 12.4: schema problems mark only that item invalid and queue it for
// retry instead of letting normalizeClassification silently default the field.
{
  const result = validateBatchResults(
    inputs,
    [
      item('A', { category: 'urgent' }),
      item('B', { summary: '   ' }),
      item('C', { importance: 'high' })
    ],
    'gemini'
  );
  assert.ok(result.ok);
  if (!result.ok) throw new Error('unreachable');
  assert.deepEqual(result.valid, []);
  assert.deepEqual(result.retry.map((entry) => entry.id), ['A', 'B', 'C']);
  assert.ok(result.problems.every((problem) => problem.reason.startsWith('invalid schema')));
}

// Non-array detail lists are a schema error; a missing confidence/reason is not,
// because normalizeClassification already has a sane default for those.
{
  const lenient = item('A');
  delete lenient.confidence;
  delete lenient.reason;
  const result = validateBatchResults(
    inputs,
    [lenient, item('B', { attentionPoints: 'not-an-array' }), item('C')],
    'gemini'
  );
  assert.ok(result.ok);
  if (!result.ok) throw new Error('unreachable');
  assert.deepEqual(result.valid.map((entry) => entry.emailId), ['A', 'C']);
  assert.deepEqual(result.retry.map((entry) => entry.id), ['B']);
}

// Items that are not objects, or carry no string emailId, cannot be associated
// with any input and are reported without an id; the inputs they would have
// covered are then missing and retried.
{
  const result = validateBatchResults([email('A')], [null, 'oops', { category: 'fyi' }, item('A', { emailId: 7 })], 'gemini');
  assert.ok(result.ok);
  if (!result.ok) throw new Error('unreachable');
  assert.deepEqual(result.valid, []);
  assert.deepEqual(result.retry.map((entry) => entry.id), ['A']);
  assert.equal(result.problems.filter((problem) => problem.emailId === null).length, 4);
  assert.ok(result.problems.some((problem) => problem.emailId === 'A' && problem.reason.startsWith('missing')));
}

// normalizeClassification still applies to valid items (out-of-range importance clamps).
{
  const result = validateBatchResults([email('A')], [item('A', { importance: 250 })], 'gemini');
  assert.ok(result.ok);
  if (!result.ok) throw new Error('unreachable');
  assert.equal(result.valid[0]!.classification.importance, 100);
}

console.log('classification-batch-validation.test.ts: all assertions passed');

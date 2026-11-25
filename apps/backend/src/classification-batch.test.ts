import assert from 'node:assert/strict';
import { buildClassificationBatches, estimateEmailTokens, estimateTokens } from './classification-batch.js';
import type { EmailMessage } from './types.js';

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

// estimateEmailTokens must be estimated on the payload actually sent to the
// model (email.text truncated to 6000 chars there), not the raw email body —
// otherwise a long-but-truncated email would be wrongly flagged as oversized.
{
  const huge = email({ id: 'huge', text: 'a'.repeat(50000) });
  const tokens = estimateEmailTokens(huge);
  assert.ok(tokens < 2000, `expected truncation-aware estimate, got ${tokens} tokens`);
  assert.ok(tokens > 1000, `expected the truncated 6000 chars to still count, got ${tokens} tokens`);
}

// CJK runs close to 1 char/token, Latin closer to 4 chars/token; the
// estimator must tell them apart rather than applying one flat ratio.
{
  const latin = email({ id: 'latin', text: 'a'.repeat(400) });
  const cjk = email({ id: 'cjk', text: '中'.repeat(400) });
  assert.ok(estimateEmailTokens(cjk) > estimateEmailTokens(latin));
}

// Real Chinese subject lines mix in full-width punctuation (【】 = full-width
// brackets, 。/、 = ideographic period/comma) alongside ideographs; those
// must count at the CJK ratio too, not fall through to the 4-chars/token Latin ratio.
{
  const fullWidthPunctuation = '【】，。、';
  assert.equal(estimateTokens(fullWidthPunctuation), fullWidthPunctuation.length);
}

// 12 emails, maxItems=10, plenty of token budget -> 10 + 2, no oversized items.
{
  const emails = Array.from({ length: 12 }, (_, index) => email({ id: `e${index}`, text: 'short body' }));
  const plan = buildClassificationBatches(emails, { maxItems: 10, maxInputTokens: 24000 });
  assert.deepEqual(plan.batches.map((batch) => batch.length), [10, 2]);
  assert.deepEqual(plan.oversized, []);
  assert.deepEqual(plan.batches.flat().map((item) => item.id), emails.map((item) => item.id));
}

// 6 same-size emails with a token budget that only fits 3 per batch: the
// split must follow the token budget, not just email count (maxItems is well
// above 6 here, so count alone would never force a split).
{
  const sample = email({ id: 'e0', text: 'x'.repeat(200) });
  const emails = Array.from({ length: 6 }, (_, index) => email({ id: `e${index}`, text: 'x'.repeat(200) }));
  const perEmailTokens = estimateEmailTokens(sample);
  const plan = buildClassificationBatches(emails, {
    maxItems: 10,
    maxInputTokens: perEmailTokens * 3 + Math.floor(perEmailTokens / 2)
  });
  assert.deepEqual(plan.batches.map((batch) => batch.length), [3, 3]);
  assert.deepEqual(plan.oversized, []);
}

// A single oversized email (bigger than the whole budget by itself) must not
// stall the builder: it is set aside for single-email fallback, and the
// surrounding emails still get batched normally.
{
  const smallTokens = estimateEmailTokens(email({ id: 'small', text: 'short body' }));
  const emails = [
    email({ id: 'before', text: 'short body' }),
    email({ id: 'oversized', text: 'y'.repeat(6000) }),
    email({ id: 'after', text: 'short body' })
  ];
  const plan = buildClassificationBatches(emails, { maxItems: 10, maxInputTokens: smallTokens + 5 });
  assert.deepEqual(plan.oversized.map((item) => item.id), ['oversized']);
  assert.deepEqual(plan.batches.flat().map((item) => item.id), ['before', 'after']);
  // The oversized email must be skipped (not accumulated into currentTokens)
  // rather than silently widening or corrupting the batch either side of it.
  assert.deepEqual(plan.batches.map((batch) => batch.length), [1, 1]);
}

// Empty input.
{
  const plan = buildClassificationBatches([], { maxItems: 10, maxInputTokens: 24000 });
  assert.deepEqual(plan, { batches: [], oversized: [] });
}

console.log('classification-batch.test.ts: all assertions passed');

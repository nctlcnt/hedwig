import assert from 'node:assert/strict';
import { classifyEmail, isVerificationCode, normalizeClassification } from './classifier.js';
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

// One-time codes are detected from subject/snippet.
assert.ok(isVerificationCode(email({ subject: '581167 is your code' })));
assert.ok(isVerificationCode(email({ subject: 'Your verification code' })));
assert.ok(isVerificationCode(email({ subject: '【某App】登录验证码', snippet: '您的验证码是 8821' })));
assert.ok(!isVerificationCode(email({ subject: 'New sign-in from an unknown device, was this you?' })));
assert.ok(!isVerificationCode(email({ subject: 'Lunch tomorrow?' })));

// The rule classifier routes a one-time code to junk (so it is never pushed/digested).
assert.equal(classifyEmail(email({ subject: '581167 is your code' })).category, 'junk');

// An LLM "junk" verdict for a code survives normalize even without unsubscribe
// evidence (which would otherwise be downgraded to fyi).
assert.equal(
  normalizeClassification(email({ subject: '581167 is your code' }), { category: 'junk' }, 'glm').category,
  'junk'
);

// A bare "junk" verdict on a normal email with no junk evidence is still
// downgraded to fyi (the conservative guard stays intact).
assert.equal(
  normalizeClassification(email({ subject: 'Project update' }), { category: 'junk' }, 'glm').category,
  'fyi'
);

const structured = normalizeClassification(email({ subject: 'Assignment due Friday' }), {
  category: 'action',
  summary: 'The assignment is due Friday.',
  attentionPoints: ['  Deadline: Friday  ', 'Deadline: Friday', 42 as unknown as string, 'A'.repeat(200)],
  suggestedActions: ['Submit the assignment', '', 'Check the rubric', 'Ignored fourth action', 'Ask a question']
}, 'glm');
assert.deepEqual(structured.attentionPoints, ['Deadline: Friday', 'A'.repeat(160)]);
assert.deepEqual(structured.suggestedActions, [
  'Submit the assignment',
  'Check the rubric',
  'Ignored fourth action'
]);
assert.deepEqual(
  normalizeClassification(email({ subject: 'FYI' }), { attentionPoints: 'invalid' as unknown as string[] }, 'glm')
    .attentionPoints,
  []
);

console.log('classifier.test.ts: all assertions passed');

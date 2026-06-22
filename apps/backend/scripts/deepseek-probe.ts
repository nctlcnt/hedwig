import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { createOpenAICompatibleClassifier } from '../src/llm/openai-compatible-classifier.js';
import type { EmailMessage } from '../src/types.js';

const sample: EmailMessage = {
  accountId: 'probe',
  accountEmail: 'probe@example.com',
  id: 'probe-msg-1',
  threadId: 'probe-thread-1',
  labelIds: ['INBOX', 'UNREAD'],
  headers: [
    { name: 'From', value: 'University of Sydney <noreply@sydney.edu.au>' },
    { name: 'Subject', value: 'Action required: submit COMP3027 assignment by Friday' },
    { name: 'Date', value: new Date().toUTCString() }
  ],
  subject: 'Action required: submit COMP3027 assignment by Friday',
  from: 'University of Sydney <noreply@sydney.edu.au>',
  date: new Date(),
  snippet: 'Reminder: your COMP3027 assignment 2 is due this Friday at 23:59. Late submissions will incur a 5%/day penalty.',
  text: 'Hi student,\n\nThis is a reminder that COMP3027 Assignment 2 must be submitted on Canvas before Friday 23:59 (Sydney time). Late submissions will incur a 5% per day penalty. Please contact your tutor if you have extension paperwork.\n\nBest,\nUSYD Course Coordinator',
  gmailUrl: 'https://mail.google.com/mail/u/0/#inbox/probe-msg-1'
};

async function main() {
  const config = loadConfig();
  if (config.classifier.provider !== 'openai-compatible') {
    throw new Error(`Probe expects CLASSIFIER_PROVIDER=openai-compatible, got: ${config.classifier.provider}`);
  }
  console.log(`Calling ${config.classifier.llm.providerName} model: ${config.classifier.llm.model}`);
  console.log(`Base URL: ${config.classifier.llm.baseUrl}`);

  const classifier = createOpenAICompatibleClassifier(config);
  const start = Date.now();
  const result = await classifier.classify(sample);
  const elapsed = Date.now() - start;

  console.log(`Elapsed: ${elapsed}ms`);
  console.log(JSON.stringify(result, null, 2));

  if (result.provider !== config.classifier.llm.providerName) {
    console.error(`\nFAILED: provider=${result.provider} (expected ${config.classifier.llm.providerName}). Likely fell back to rule.`);
    process.exit(1);
  }
  console.log(`\nOK: ${config.classifier.llm.providerName} returned a usable classification.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

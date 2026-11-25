import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  buildBatchSystemPrompt,
  buildBatchUserContent,
  createOpenAICompatibleClassifier
} from './openai-compatible-classifier.js';
import type { AppConfig, EmailMessage } from '../types.js';

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

// --- classifyBatch against a stub OpenAI-compatible server -----------------

type StubReply = { status?: number; results?: unknown[]; rawContent?: string };
type StubServer = { baseUrl: string; requestedIds: string[][]; close(): Promise<void> };

function item(emailId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    emailId,
    category: 'fyi',
    summary: `Summary for ${emailId}`,
    attentionPoints: [],
    suggestedActions: [],
    importance: 30,
    confidence: 0.7,
    reason: 'stub',
    ...overrides
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

// Replies to each request with the next scripted reply (the last one repeats)
// and records which emailIds each request carried.
async function startStub(replies: StubReply[]): Promise<StubServer> {
  const requestedIds: string[][] = [];
  let call = 0;
  const server: Server = createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    const userContent: string = body.messages[1].content;
    const payloads = JSON.parse(userContent.slice('EMAILS_JSON:\n'.length)) as { emailId: string }[];
    requestedIds.push(payloads.map((payload) => payload.emailId));

    const reply = replies[Math.min(call, replies.length - 1)]!;
    call += 1;
    res.setHeader('content-type', 'application/json');
    if (reply.status && reply.status >= 400) {
      res.statusCode = reply.status;
      res.end(JSON.stringify({ error: { message: 'stub failure' } }));
      return;
    }
    const content = reply.rawContent ?? JSON.stringify({ results: reply.results ?? [] });
    res.end(JSON.stringify({
      id: 'stub',
      object: 'chat.completion',
      created: 0,
      model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }]
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requestedIds,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

function configFor(primary: StubServer, fallback?: StubServer): AppConfig {
  return {
    classifier: {
      provider: 'openai-compatible',
      rulesPath: '',
      llm: { apiKey: 'test', baseUrl: primary.baseUrl, model: 'stub-model', providerName: 'primary' },
      fallbackLlm: fallback
        ? { apiKey: 'test', baseUrl: fallback.baseUrl, model: 'stub-model', providerName: 'secondary' }
        : undefined,
      maxRetries: 0,
      requestTimeoutMs: 5000
    }
  } as AppConfig;
}

async function main(): Promise<void> {
  const emails = ['A', 'B', 'C'].map((id) => email({ id, subject: `Subject ${id}` }));
  const warn = console.warn;
  console.warn = () => {};

  try {
    // One request carries the whole batch; results are matched by emailId even
    // when the model answers in a different order.
    {
      const stub = await startStub([{ results: [item('C'), item('A'), item('B')] }]);
      const classifier = createOpenAICompatibleClassifier(configFor(stub));
      const results = await classifier.classifyBatch(emails);
      assert.deepEqual(stub.requestedIds, [['A', 'B', 'C']]);
      assert.deepEqual(results.map((result) => result.emailId), ['A', 'B', 'C']);
      assert.equal(results[0]!.classification.summary, 'Summary for A');
      assert.equal(results[0]!.classification.provider, 'primary');
      await stub.close();
    }

    // classify(email) reuses the same batch request path as a batch of one.
    {
      const stub = await startStub([{ results: [item('A', { category: 'action', importance: 90 })] }]);
      const classifier = createOpenAICompatibleClassifier(configFor(stub));
      const classification = await classifier.classify(emails[0]!);
      assert.deepEqual(stub.requestedIds, [['A']]);
      assert.equal(classification.category, 'action');
      assert.equal(classification.importance, 90);
      await stub.close();
    }

    // Partial result (section 13): the missing email is retried on its own in a
    // single-email request, and the already valid results are not re-requested.
    {
      const stub = await startStub([
        { results: [item('A'), item('C')] },
        { results: [item('B', { summary: 'Recovered B' })] }
      ]);
      const classifier = createOpenAICompatibleClassifier(configFor(stub));
      const results = await classifier.classifyBatch(emails);
      assert.deepEqual(stub.requestedIds, [['A', 'B', 'C'], ['B']]);
      assert.equal(results[1]!.classification.summary, 'Recovered B');
      assert.equal(results[1]!.classification.provider, 'primary');
      await stub.close();
    }

    // An invalid item whose single-email retry also fails moves on to the
    // fallback LLM, and only that item is sent there.
    {
      const primary = await startStub([{ results: [item('A'), item('B', { category: 'urgent' }), item('C')] }]);
      const secondary = await startStub([{ results: [item('B', { summary: 'From secondary' })] }]);
      const classifier = createOpenAICompatibleClassifier(configFor(primary, secondary));
      const results = await classifier.classifyBatch(emails);
      assert.deepEqual(secondary.requestedIds, [['B']]);
      assert.equal(results[1]!.classification.provider, 'secondary');
      assert.equal(results[0]!.classification.provider, 'primary');
      await primary.close();
      await secondary.close();
    }

    // Request failure with no fallback LLM: every email in the batch degrades to
    // the rule classifier and records why.
    {
      const stub = await startStub([{ status: 500 }]);
      const classifier = createOpenAICompatibleClassifier(configFor(stub));
      const results = await classifier.classifyBatch(emails);
      assert.equal(results.length, 3);
      assert.ok(results.every((result) => result.classification.provider === 'rule-fallback'));
      assert.ok(results[0]!.classification.reason?.includes('primary failed'));
      await stub.close();
    }

    // Request failure on the primary: the whole batch goes to the fallback LLM in one request.
    {
      const primary = await startStub([{ status: 500 }]);
      const secondary = await startStub([{ results: [item('A'), item('B'), item('C')] }]);
      const classifier = createOpenAICompatibleClassifier(configFor(primary, secondary));
      const results = await classifier.classifyBatch(emails);
      assert.deepEqual(secondary.requestedIds, [['A', 'B', 'C']]);
      assert.ok(results.every((result) => result.classification.provider === 'secondary'));
      await primary.close();
      await secondary.close();
    }

    // Duplicate emailIds make the whole response untrusted: nothing from it is used.
    {
      const stub = await startStub([{ results: [item('A'), item('A'), item('B'), item('C')] }]);
      const classifier = createOpenAICompatibleClassifier(configFor(stub));
      const results = await classifier.classifyBatch(emails);
      assert.ok(results.every((result) => result.classification.provider === 'rule-fallback'));
      assert.ok(results[0]!.classification.reason?.includes('duplicate-email-id'));
      await stub.close();
    }

    // Unparseable content degrades the same way instead of throwing out of classifyBatch.
    {
      const stub = await startStub([{ rawContent: 'not json' }]);
      const classifier = createOpenAICompatibleClassifier(configFor(stub));
      const results = await classifier.classifyBatch([emails[0]!]);
      assert.equal(results[0]!.classification.provider, 'rule-fallback');
      await stub.close();
    }

    // Empty batch makes no request.
    {
      const stub = await startStub([{ results: [] }]);
      const classifier = createOpenAICompatibleClassifier(configFor(stub));
      assert.deepEqual(await classifier.classifyBatch([]), []);
      assert.deepEqual(stub.requestedIds, []);
      await stub.close();
    }
  } finally {
    console.warn = warn;
  }

  console.log('llm/openai-compatible-classifier.test.ts: all assertions passed');
}

await main();

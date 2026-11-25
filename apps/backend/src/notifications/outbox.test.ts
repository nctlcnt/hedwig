import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db.js';
import type { DiscordAppConfig, DigestItem, DigestReport, DigestSection } from '../types.js';
import { createDiscordNotifier } from './discord-notifier.js';
import { DeliveryError } from './notifier.js';
import { claimDelivery, enqueueNotification, finishDelivery } from './outbox-store.js';
import { createOutboxDrain } from './outbox-worker.js';

const directory = mkdtempSync(join(tmpdir(), 'hedwig-outbox-'));
const config = {
  messagingProvider: 'discord',
  database: { path: join(directory, 'test.db') },
  discord: {
    botToken: 'synthetic-token',
    digestChannelId: 'digest-channel',
    realtimeChannelId: 'urgent-channel',
    debugChannelId: 'debug-channel',
    debugCooldownMs: 3_600_000
  }
} as DiscordAppConfig;
const notifier = createDiscordNotifier(config);
const digest = makeDigest();
const paths: string[] = [];
const responses: Response[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  paths.push(new URL(String(input)).pathname);
  const response = responses.shift();
  if (!response) throw new Error('Unexpected Discord request');
  return response;
};

let db = openDatabase(config);
try {
  const { date } = digest;
  enqueueNotification(db, notifier, 'digest', date, notifier.planDigest(digest));
  enqueueNotification(db, notifier, 'digest', date, [{ key: 'replacement', payload: {} }]);
  const summaryPath = '/api/v10/channels/digest-channel/messages';
  const threadPath = '/api/v10/channels/digest-channel/messages/summary-id/threads';
  const detailPath = '/api/v10/channels/summary-id/messages';
  responses.push(
    ok('summary-id'),
    Response.json({ code: 160004 }, { status: 400 }),
    Response.json({ message: 'Temporary failure' }, { status: 503 }),
    ok('fyi-id')
  );
  let now = Date.now();
  const firstDrain = createOutboxDrain(db, notifier, () => now);
  const running = firstDrain();
  assert.equal(firstDrain(), running);
  await running;
  assert.deepEqual(paths, [summaryPath, threadPath, detailPath, detailPath]);
  assert.deepEqual(state(date), [
    row('summary', 'sent', 1, 'summary-id'),
    row('thread', 'sent', 1, 'summary-id'),
    row('action:1', 'pending', 1, null, 'HTTP 503'),
    row('fyi:1', 'sent', 1, 'fyi-id')
  ]);

  db.close();
  db = openDatabase(config);
  const drain = createOutboxDrain(db, notifier, () => now);
  await drain();
  assert.equal(paths.length, 4);
  now += 15_000;
  responses.push(ok('action-id'));
  await drain();
  assert.deepEqual(paths.slice(4), [detailPath]);
  assert.deepEqual(state(date)[2], row('action:1', 'sent', 2, 'action-id'));

  const urgentPart = notifier.planRealtime(digest.sections[0]!.items[0]!);
  enqueueNotification(db, notifier, 'realtime', 'urgent-1', [urgentPart]);
  responses.push(Response.json({ retry_after: 45.25 }, { status: 429, headers: { 'Retry-After': '40' } }));
  await drain();
  const urgentPath = '/api/v10/channels/urgent-channel/messages';
  assert.deepEqual(paths.slice(5), [urgentPath]);
  // A provider pause also applies to work enqueued after the rate limit.
  enqueueNotification(db, notifier, 'realtime', 'urgent-2', [urgentPart]);
  now += 45_249;
  await drain();
  assert.equal(paths.length, 6);
  now += 1;
  responses.push(ok('urgent-2-id'), ok('urgent-1-id'));
  await drain();
  assert.deepEqual(paths.slice(6), [urgentPath, urgentPath]);
  assert.deepEqual(state('urgent-1'), [row('message', 'sent', 2, 'urgent-1-id')]);

  const forbidden = '2026-11-19';
  enqueueNotification(db, notifier, 'digest', forbidden, notifier.planDigest({ ...digest, date: forbidden }));
  responses.push(Response.json({ message: 'Sensitive response details' }, { status: 403 }), Response.json({}, { status: 403 }));
  await drain();
  assert.deepEqual(paths.slice(8), [summaryPath, '/api/v10/channels/debug-channel/messages']);
  assert.deepEqual(state(forbidden), [
    row('summary', 'failed', 1, null, 'HTTP 403'),
    row('thread', 'failed', 0, null, 'Prerequisite delivery failed'),
    row('action:1', 'failed', 0, null, 'Prerequisite delivery failed'),
    row('fyi:1', 'failed', 0, null, 'Prerequisite delivery failed')
  ]);

  const otherDb = openDatabase(config);
  try {
    enqueueNotification(db, notifier, 'realtime', 'interrupted', [urgentPart]);
    const first = claimDelivery(db, notifier, now);
    assert.ok(first);
    assert.equal(claimDelivery(otherDb, notifier, now), undefined);
    now += 120_000;
    assert.equal(claimDelivery(otherDb, { ...notifier, realtimeDestination: 'new-channel' }, now), undefined);
    const recovered = claimDelivery(otherDb, notifier, now);
    assert.ok(recovered);
    assert.equal(recovered.id, first.id);
    assert.notEqual(recovered.token, first.token);
    assert.equal(finishDelivery(db, first, { messageId: 'expired-claim' }), false);
    assert.equal(finishDelivery(otherDb, recovered, { messageId: 'recovered-id' }), true);
    assert.deepEqual(state('interrupted'), [row('message', 'sent', 1, 'recovered-id')]);
  } finally {
    otherDb.close();
  }

  enqueueNotification(db, notifier, 'realtime', 'exhausted', [urgentPart]);
  let attempts = 0;
  const drainFailing = createOutboxDrain(db, {
    ...notifier,
    alertCooldownMs: null,
    async deliver() {
      attempts += 1;
      throw new DeliveryError('network');
    }
  }, () => now);
  for (let attempt = 0; attempt < 7; attempt += 1) {
    await drainFailing();
    now += 300_000;
  }
  assert.equal(attempts, 6);
  assert.deepEqual(state('exhausted'), [row('message', 'failed', 6, null, 'network')]);
  assert.equal(responses.length, 0);
  assert.deepEqual(db.prepare(`select id from notification_outbox where payload_json is not null`).all(), []);
} finally {
  globalThis.fetch = originalFetch;
  if (db.open) db.close();
  rmSync(directory, { recursive: true, force: true });
}

console.log('outbox.test.ts: all assertions passed');

function state(key: string): unknown[] {
  return db.prepare(`
    select part_key as key, status, attempt_count as attempts, message_id as messageId, last_error as error
    from notification_outbox where notification_key = ? order by id
  `).all(key);
}

function row(key: string, status: string, attempts: number, messageId: string | null, error: string | null = null) {
  return { key, status, attempts, messageId, error };
}

function ok(id: string): Response {
  return Response.json({ id });
}

function makeDigest(): DigestReport {
  const sections: DigestSection[] = (['action', 'fyi'] as const).map((category) => {
    const item: DigestItem = {
      id: category,
      mailId: `primary:${category}`,
      accountId: 'primary',
      accountName: 'Test Account',
      category,
      from: 'Test Sender',
      subject: `Test ${category}`,
      summary: 'Test summary',
      attentionPoints: [],
      suggestedActions: [],
      importance: 50,
      confidence: 1,
      provider: 'rule',
      processingOutcome: category === 'action' ? 'push_now' : 'digest_only',
      gmailUrl: 'https://mail.google.com/mail/#all/test'
    };
    return { category, title: category, lead: '', items: [item] };
  });
  return {
    runIds: [], account: 'Test Account', date: '2026-11-18', total: 2, accounts: [], sections,
    counts: { action: 1, fyi: 1, course: 0, admin: 0, junk: 0 }
  };
}

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db.js';
import type { AppConfig, DigestItem, DigestReport, DigestSection } from '../types.js';
import { DeliveryError, type DeliveryPart, type DeliveryRequest, type Notifier, type OperationalAlert } from './notifier.js';
import { claimDelivery, enqueueNotification, finishDelivery } from './outbox-store.js';
import { createOutboxDrain } from './outbox-worker.js';

const directory = mkdtempSync(join(tmpdir(), 'hedwig-outbox-'));
const config = { database: { path: join(directory, 'test.db') } } as AppConfig;
const digest = makeDigest();

// A fake platform with the dependency shape the outbox must support: a summary,
// a thread that needs the summary's message ID, and detail parts under the thread.
const requests: DeliveryRequest[] = [];
const outcomes: Array<string | DeliveryError> = [];
const alerts: OperationalAlert[] = [];
const notifier: Notifier = {
  platform: 'fake',
  digestDestination: 'digest-chat',
  realtimeDestination: 'urgent-chat',
  alertCooldownMs: 3_600_000,
  planDigest(report: DigestReport): DeliveryPart[] {
    const parts: DeliveryPart[] = [{ key: 'summary', payload: { text: report.date } }];
    if (report.total === 0) return parts;
    parts.push({ key: 'thread', after: 'summary', payload: { text: 'thread' } });
    for (const section of report.sections) {
      if (section.items.length > 0) parts.push({ key: `${section.category}:1`, after: 'thread', payload: { text: section.category } });
    }
    return parts;
  },
  planRealtime(item: DigestItem): DeliveryPart {
    return { key: 'message', payload: { text: item.subject } };
  },
  async deliver(request: DeliveryRequest): Promise<string> {
    requests.push(request);
    const outcome = outcomes.shift();
    if (outcome === undefined) throw new Error('Unexpected delivery');
    if (outcome instanceof DeliveryError) throw outcome;
    return outcome;
  },
  async sendOperationalAlert(alert: OperationalAlert): Promise<void> {
    alerts.push(alert);
  }
};

let db = openDatabase(config);
try {
  const { date } = digest;
  enqueueNotification(db, notifier, 'digest', date, notifier.planDigest(digest));
  // A repeated cron run for the same day must not create a second digest.
  enqueueNotification(db, notifier, 'digest', date, [{ key: 'replacement', payload: {} }]);
  outcomes.push('summary-id', 'thread-id', new DeliveryError(503), 'fyi-id');
  let now = Date.now();
  const firstDrain = createOutboxDrain(db, notifier, () => now);
  const running = firstDrain();
  assert.equal(firstDrain(), running);
  await running;
  assert.deepEqual(targets(), [
    ['digest-chat', null],
    ['digest-chat', 'summary-id'],
    ['digest-chat', 'thread-id'],
    ['digest-chat', 'thread-id']
  ]);
  assert.deepEqual(state(date), [
    row('summary', 'sent', 1, 'summary-id'),
    row('thread', 'sent', 1, 'thread-id'),
    row('action:1', 'pending', 1, null, 'HTTP 503'),
    row('fyi:1', 'sent', 1, 'fyi-id')
  ]);

  // Pending work survives a restart and waits for its backoff.
  db.close();
  db = openDatabase(config);
  const drain = createOutboxDrain(db, notifier, () => now);
  await drain();
  assert.equal(requests.length, 4);
  now += 15_000;
  outcomes.push('action-id');
  await drain();
  assert.deepEqual(targets().slice(4), [['digest-chat', 'thread-id']]);
  assert.deepEqual(state(date)[2], row('action:1', 'sent', 2, 'action-id'));

  const urgentPart = notifier.planRealtime(digest.sections[0]!.items[0]!);
  enqueueNotification(db, notifier, 'realtime', 'urgent-1', [urgentPart]);
  outcomes.push(new DeliveryError(429, 45_250));
  await drain();
  assert.deepEqual(targets().slice(5), [['urgent-chat', null]]);
  // A provider pause also applies to work enqueued after the rate limit.
  enqueueNotification(db, notifier, 'realtime', 'urgent-2', [urgentPart]);
  now += 45_249;
  await drain();
  assert.equal(requests.length, 6);
  now += 1;
  outcomes.push('urgent-2-id', 'urgent-1-id');
  await drain();
  assert.deepEqual(targets().slice(6), [['urgent-chat', null], ['urgent-chat', null]]);
  assert.deepEqual(state('urgent-1'), [row('message', 'sent', 2, 'urgent-1-id')]);
  assert.deepEqual(state('urgent-2'), [row('message', 'sent', 1, 'urgent-2-id')]);

  // A permanent error fails the dependent parts and raises one operational alert.
  const forbidden = '2026-11-19';
  enqueueNotification(db, notifier, 'digest', forbidden, notifier.planDigest({ ...digest, date: forbidden }));
  outcomes.push(new DeliveryError(403));
  await drain();
  assert.equal(requests.length, 9);
  assert.deepEqual(state(forbidden), [
    row('summary', 'failed', 1, null, 'HTTP 403'),
    row('thread', 'failed', 0, null, 'Prerequisite delivery failed'),
    row('action:1', 'failed', 0, null, 'Prerequisite delivery failed'),
    row('fyi:1', 'failed', 0, null, 'Prerequisite delivery failed')
  ]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.kind, 'job-failure');
  assert.equal(alerts[0]!.signature, 'notification-delivery:fake:digest|HTTP 403');

  const otherDb = openDatabase(config);
  try {
    enqueueNotification(db, notifier, 'realtime', 'interrupted', [urgentPart]);
    const first = claimDelivery(db, notifier, now);
    assert.ok(first);
    assert.equal(claimDelivery(otherDb, notifier, now), undefined);
    now += 120_000;
    assert.equal(claimDelivery(otherDb, { ...notifier, realtimeDestination: 'new-chat' }, now), undefined);
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
  assert.equal(outcomes.length, 0);
  assert.deepEqual(db.prepare(`select id from notification_outbox where payload_json is not null`).all(), []);
} finally {
  if (db.open) db.close();
  rmSync(directory, { recursive: true, force: true });
}

console.log('outbox.test.ts: all assertions passed');

function targets(): Array<[string, string | null]> {
  return requests.map((request) => [request.destination, request.parentMessageId]);
}

function state(key: string): unknown[] {
  return db.prepare(`
    select part_key as key, status, attempt_count as attempts, message_id as messageId, last_error as error
    from notification_outbox where notification_key = ? order by id
  `).all(key);
}

function row(key: string, status: string, attempts: number, messageId: string | null, error: string | null = null) {
  return { key, status, attempts, messageId, error };
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
    return { category, title: category, items: [item] };
  });
  return {
    runIds: [], account: 'Test Account', date: '2026-11-18', total: 2, accounts: [], sections,
    counts: { action: 1, fyi: 1, course: 0, admin: 0, junk: 0 }
  };
}

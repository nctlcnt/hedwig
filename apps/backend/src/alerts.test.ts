import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportProblem } from './alerts.js';
import { isAlertOnCooldown, openDatabase } from './db.js';
import type { Notifier, OperationalAlert } from './notifications/notifier.js';
import type { AppConfig } from './types.js';

const directory = mkdtempSync(join(tmpdir(), 'hedwig-alerts-'));
const db = openDatabase({ database: { path: join(directory, 'test.db') } } as AppConfig);
const alert: OperationalAlert = {
  kind: 'account-failure',
  signature: 'account-failed:main|invalid_grant',
  accountName: 'Main Gmail',
  accountEmail: 'main@example.test',
  detail: 'invalid_grant'
};

const sent: OperationalAlert[] = [];
function makeNotifier(alertCooldownMs: number | null): Notifier {
  return {
    platform: 'test',
    digestDestination: 'digest',
    realtimeDestination: null,
    alertCooldownMs,
    planDigest: () => [],
    planRealtime: () => ({ key: 'message', payload: {} }),
    deliver: async () => 'message-id',
    sendOperationalAlert: async (problem) => {
      sent.push(problem);
    }
  };
}

const logged: string[] = [];
const originalError = console.error;
console.error = (...args: unknown[]) => {
  logged.push(args.map(String).join(' '));
};

try {
  // Without an alert destination, every occurrence is logged and nothing is sent or recorded.
  await reportProblem(makeNotifier(null), db, alert);
  await reportProblem(makeNotifier(null), db, alert);
  assert.equal(sent.length, 0);
  assert.equal(logged.length, 2);
  const [line = ''] = logged;
  assert.match(line, /no alert destination configured/);
  assert.match(line, /account-failure account-failed:main\|invalid_grant/);
  assert.doesNotMatch(line, /main@example\.test/);
  assert.equal(isAlertOnCooldown(db, alert.signature, 3_600_000), false);

  // With a destination, the alert is sent once and then held by the cooldown without logging.
  logged.length = 0;
  await reportProblem(makeNotifier(3_600_000), db, alert);
  await reportProblem(makeNotifier(3_600_000), db, alert);
  assert.equal(sent.length, 1);
  assert.equal(logged.length, 0);
} finally {
  console.error = originalError;
  db.close();
  rmSync(directory, { recursive: true, force: true });
}

console.log('alerts tests passed');

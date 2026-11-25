import { isAlertOnCooldown, recordAlertSent } from './db.js';
import type { HedwigDb } from './db.js';
import type { Notifier, OperationalAlert } from './notifications/notifier.js';

// Deduplicates alerts by signature after a successful send. Failed alerts are
// logged locally so they cannot break the pipeline or trigger another alert.
export async function reportProblem(notifier: Notifier, db: HedwigDb, problem: OperationalAlert): Promise<void> {
  try {
    const cooldown = notifier.alertCooldownMs;
    if (cooldown === null || isAlertOnCooldown(db, problem.signature, cooldown)) return;
    await notifier.sendOperationalAlert(problem);
    recordAlertSent(db, problem.signature);
  } catch (error) {
    console.error('Failed to send operational alert', error);
  }
}

export function problemMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

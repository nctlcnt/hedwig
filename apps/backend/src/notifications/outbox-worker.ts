import { reportProblem } from '../alerts.js';
import type { HedwigDb } from '../db.js';
import { DeliveryError, type Notifier } from './notifier.js';
import { claimDelivery, finishDelivery, type ClaimedDelivery } from './outbox-store.js';

const MAX_ATTEMPTS = 6;
const INITIAL_BACKOFF_MS = 15_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export function createOutboxDrain(db: HedwigDb, notifier: Notifier, now: () => number = Date.now): () => Promise<void> {
  let active: Promise<void> | undefined;

  async function drain(): Promise<void> {
    if (notifier.canDeliver?.() === false) return;
    for (let job = claimDelivery(db, notifier, now()); job; job = claimDelivery(db, notifier, now())) {
      let messageId: string;
      try {
        messageId = await notifier.deliver({
          destination: job.destination,
          parentMessageId: job.parentMessageId,
          payload: JSON.parse(job.payloadJson) as object
        });
      } catch (error) {
        await handleFailure(db, notifier, job, error, now());
        continue;
      }
      finishDelivery(db, job, { messageId });
    }
  }

  return () => {
    active ??= drain().finally(() => { active = undefined; });
    return active;
  };
}

async function handleFailure(
  db: HedwigDb,
  notifier: Notifier,
  job: ClaimedDelivery,
  error: unknown,
  now: number
): Promise<void> {
  const deliveryError = error instanceof DeliveryError ? error : undefined;
  const reason = deliveryError?.message ?? 'Invalid delivery or unexpected sender error';
  const attempts = job.attemptCount + 1;
  const delay = Math.max(
    deliveryError?.retryAfterMs ?? 0,
    Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** job.attemptCount)
  );
  const retryAt = deliveryError?.retryable && attempts < MAX_ATTEMPTS ? now + delay : null;
  const pauseUntil = deliveryError?.status === 429 ? now + delay : undefined;
  if (!finishDelivery(db, job, { error: reason, retryAt, pauseUntil })) return;

  const label = `${job.platform} ${job.kind} part ${job.partKey} (#${job.id})`;
  if (retryAt !== null) {
    console.warn(`Notification ${label} attempt ${attempts} failed (${reason}), retry scheduled`);
    return;
  }

  console.error(`Notification ${label} failed permanently after ${attempts} attempt(s): ${reason}`);
  // A rate-limited provider cannot accept a debug alert during its cooldown.
  if (pauseUntil !== undefined) return;
  await reportProblem(notifier, db, {
    kind: 'job-failure',
    signature: `notification-delivery:${job.platform}:${job.kind}|${reason}`,
    title: '通知投递失败',
    detail: `${label}，尝试 ${attempts} 次，错误：${reason}`
  });
}

import { randomUUID } from 'node:crypto';
import type { HedwigDb } from '../db.js';
import type { DeliveryPart, Notifier } from './notifier.js';

type NotificationKind = 'digest' | 'realtime';
type Destinations = Pick<Notifier, 'platform' | 'digestDestination' | 'realtimeDestination'>;

export type ClaimedDelivery = {
  id: number;
  kind: NotificationKind;
  partKey: string;
  platform: string;
  destination: string;
  parentMessageId: string | null;
  payloadJson: string;
  attemptCount: number;
  token: string;
};

// Longer than the transport's request timeout. Expired claims can be taken by
// a restarted worker. The claim token fences writes from the previous owner.
const CLAIM_LEASE_MS = 2 * 60_000;

export function migrateNotificationOutbox(db: HedwigDb): void {
  db.exec(`
    create table if not exists notification_outbox (
      id integer primary key,
      platform text not null,
      destination text not null,
      kind text not null check (kind in ('digest', 'realtime')),
      notification_key text not null,
      part_key text not null,
      parent_id integer references notification_outbox(id),
      payload_json text,
      status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
      attempt_count integer not null default 0,
      next_attempt_at integer not null,
      claim_until integer,
      claim_token text,
      message_id text,
      sent_at integer,
      last_error text,
      unique (platform, destination, kind, notification_key, part_key)
    );

    create index if not exists idx_notification_outbox_due
      on notification_outbox(platform, destination, kind, next_attempt_at, id)
      where status in ('pending', 'sending');

    create index if not exists idx_notification_outbox_parent
      on notification_outbox(parent_id);

    create table if not exists notification_rate_limits (
      platform text primary key,
      retry_at integer not null
    );
  `);
  db.transaction(() => {
    const columns = db.pragma('table_info(notification_outbox)') as { name: string }[];
    if (!columns.some(({ name }) => name === 'sent_at')) {
      db.exec('alter table notification_outbox add column sent_at integer');
    }
  }).immediate();
}

export function getNotificationStatus(db: HedwigDb, notifier: Destinations): {
  lastSentAt: number | null; pending: number;
} {
  return db.prepare(`
    select max(sent_at) as lastSentAt, count(*) filter (where status in ('pending', 'sending')) as pending
    from notification_outbox
    where platform = @platform and (
      (kind = 'digest' and destination = @digestDestination)
      or (kind = 'realtime' and destination = @realtimeDestination)
    )
  `).get({
    platform: notifier.platform,
    digestDestination: notifier.digestDestination,
    realtimeDestination: notifier.realtimeDestination
  }) as { lastSentAt: number | null; pending: number };
}

export function enqueueNotification(
  db: HedwigDb,
  notifier: Destinations,
  kind: NotificationKind,
  key: string,
  parts: DeliveryPart[]
): void {
  const destination = kind === 'digest' ? notifier.digestDestination : notifier.realtimeDestination;
  if (!destination || parts.length === 0) return;

  db.transaction(() => {
    const exists = db.prepare(`
      select 1 from notification_outbox
      where platform = ? and destination = ? and kind = ? and notification_key = ?
      limit 1
    `).get(notifier.platform, destination, kind, key);
    if (exists) return;

    const ids = new Map<string, number>();
    const insert = db.prepare(`
      insert into notification_outbox (
        platform, destination, kind, notification_key, part_key, parent_id, payload_json, next_attempt_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = Date.now();
    for (const part of parts) {
      const parentId = part.after === undefined ? null : ids.get(part.after);
      if (parentId === undefined) throw new Error(`Unknown notification dependency: ${part.after}`);
      const row = insert.run(notifier.platform, destination, kind, key, part.key, parentId, JSON.stringify(part.payload), now);
      ids.set(part.key, Number(row.lastInsertRowid));
    }
  }).immediate();
}

export function claimDelivery(db: HedwigDb, notifier: Destinations, now: number): ClaimedDelivery | undefined {
  return db.transaction(() => {
    const row = db.prepare(`
      select job.id, job.kind, job.part_key as partKey, job.platform, job.destination,
        parent.message_id as parentMessageId, job.payload_json as payloadJson, job.attempt_count as attemptCount
      from notification_outbox job
      left join notification_outbox parent on parent.id = job.parent_id
      where job.platform = @platform
        and ((job.kind = 'digest' and job.destination = @digestDestination)
          or (job.kind = 'realtime' and job.destination = @realtimeDestination))
        and job.status in ('pending', 'sending')
        and ((job.status = 'pending' and job.next_attempt_at <= @now)
          or (job.status = 'sending' and job.claim_until <= @now))
        and (job.parent_id is null or parent.status = 'sent')
        and not exists (
          select 1 from notification_rate_limits where platform = @platform and retry_at > @now
        )
      order by job.next_attempt_at, job.id
      limit 1
    `).get({
      platform: notifier.platform,
      digestDestination: notifier.digestDestination,
      realtimeDestination: notifier.realtimeDestination,
      now
    }) as Omit<ClaimedDelivery, 'token'> | undefined;
    if (!row) return undefined;

    const token = randomUUID();
    db.prepare(`
      update notification_outbox set status = 'sending', claim_token = ?, claim_until = ? where id = ?
    `).run(token, now + CLAIM_LEASE_MS, row.id);
    return { ...row, token };
  }).immediate();
}

type DeliveryResult = { messageId: string } | { error: string; retryAt: number | null; pauseUntil?: number };

export function finishDelivery(db: HedwigDb, job: ClaimedDelivery, result: DeliveryResult): boolean {
  return db.transaction(() => {
    const sent = 'messageId' in result;
    const retryAt = sent ? null : result.retryAt;
    const status = sent ? 'sent' : retryAt === null ? 'failed' : 'pending';
    const { changes } = db.prepare(`
      update notification_outbox
      set status = @status, attempt_count = attempt_count + 1, claim_token = null, claim_until = null,
        message_id = @messageId, sent_at = @sentAt, last_error = @error, next_attempt_at = coalesce(@retryAt, next_attempt_at),
        payload_json = case when @status = 'pending' then payload_json else null end
      where id = @id and claim_token = @token and status = 'sending'
    `).run({
      status,
      id: job.id,
      token: job.token,
      messageId: sent ? result.messageId : null,
      sentAt: sent ? Date.now() : null,
      error: sent ? null : result.error,
      retryAt
    });
    if (!changes) return false;

    if (!sent && result.pauseUntil !== undefined) {
      db.prepare(`
        insert into notification_rate_limits (platform, retry_at) values (?, ?)
        on conflict(platform) do update set retry_at = max(retry_at, excluded.retry_at)
      `).run(job.platform, result.pauseUntil);
    }
    if (status === 'failed') {
      db.prepare(`
        with recursive blocked(id) as (
          select id from notification_outbox where parent_id = ?
          union all
          select job.id from notification_outbox job join blocked on job.parent_id = blocked.id
        )
        update notification_outbox
        set status = 'failed', last_error = 'Prerequisite delivery failed', payload_json = null
        where status = 'pending' and id in (select id from blocked)
      `).run(job.id);
    }
    return true;
  }).immediate();
}

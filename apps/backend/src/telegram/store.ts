import { randomBytes, randomUUID } from 'node:crypto';
import type { HedwigDb } from '../db.js';
import type { Category, DigestItem, TelegramConfig } from '../types.js';

export type TelegramPrivateChat = Pick<TelegramConfig, 'ownerUserId' | 'chatId'> & { botId: number };

export type TelegramDigestSection = {
  category: Category;
  title: string;
  items: Pick<DigestItem, 'mailId' | 'accountName' | 'subject' | 'summary'>[];
};

type TelegramDigestSnapshot = {
  id: number;
  date: string;
  overview: string;
  sections: TelegramDigestSection[];
  expiresAt: number;
};

export type TelegramListPage = { snapshotId: number; section: number; page: number };
export type TelegramMailView = { mailId: string; list?: TelegramListPage };
export type TelegramView =
  | { kind: 'overview'; snapshotId: number }
  | { kind: 'section'; list: TelegramListPage }
  | { kind: 'mail'; mail: TelegramMailView }
  | { kind: 'body'; mail: TelegramMailView; page: number };

const LEASE_MS = 75_000;
// Telegram retains updates for 24 hours and can pick a new, lower update ID
// after a week without updates. Do not send a stale offset in that case.
const OFFSET_TTL_MS = 2 * 24 * 60 * 60_000;
const CALLBACK_TTL_MS = 7 * 24 * 60 * 60_000;

export function telegramDestination(chat: TelegramPrivateChat): string {
  return `${chat.botId}:${chat.ownerUserId}:${chat.chatId}`;
}

export function migrateTelegramStore(db: HedwigDb): void {
  db.exec(`
    create table if not exists telegram_poll_state (
      bot_id integer primary key,
      next_offset integer,
      offset_saved_at integer,
      lease_token text,
      lease_until integer
    );

    create table if not exists telegram_private_chats (
      bot_id integer not null,
      owner_user_id integer not null,
      chat_id integer not null,
      primary key (bot_id, owner_user_id, chat_id)
    );

    create table if not exists telegram_preview_tokens (
      token text primary key,
      bot_id integer not null,
      owner_user_id integer not null,
      chat_id integer not null,
      mail_id text not null,
      expires_at integer not null,
      used_at integer
    );
    create index if not exists idx_telegram_preview_tokens_expires
      on telegram_preview_tokens(expires_at);

    create table if not exists telegram_digest_snapshots (
      id integer primary key autoincrement,
      destination text not null,
      digest_date text not null,
      scheduled integer not null,
      overview text not null,
      sections_json text not null,
      expires_at integer not null
    );
    create unique index if not exists idx_telegram_scheduled_digest
      on telegram_digest_snapshots(destination, digest_date) where scheduled = 1;
    create index if not exists idx_telegram_digest_expires
      on telegram_digest_snapshots(expires_at);

    create table if not exists telegram_view_tokens (
      token text primary key,
      destination text not null,
      view_json text not null,
      expires_at integer not null,
      unique(destination, view_json)
    );
    create index if not exists idx_telegram_view_tokens_expires
      on telegram_view_tokens(expires_at);
  `);
}

export function saveTelegramDigestSnapshot(
  db: HedwigDb,
  chat: TelegramPrivateChat,
  snapshot: Omit<TelegramDigestSnapshot, 'id' | 'expiresAt'>,
  scheduled: boolean
): TelegramDigestSnapshot {
  const expiresAt = Date.now() + CALLBACK_TTL_MS;
  const { lastInsertRowid } = db.prepare(`
    insert into telegram_digest_snapshots (destination, digest_date, scheduled, overview, sections_json, expires_at)
    values (?, ?, ?, ?, ?, ?)
  `).run(telegramDestination(chat), snapshot.date, Number(scheduled), snapshot.overview, JSON.stringify(snapshot.sections), expiresAt);
  return { ...snapshot, id: Number(lastInsertRowid), expiresAt };
}

export function findTelegramDigestSnapshot(
  db: HedwigDb,
  chat: TelegramPrivateChat,
  lookup: { id: number } | { scheduledDate: string }
): TelegramDigestSnapshot | undefined {
  const condition = 'id' in lookup ? 'id = ?' : 'digest_date = ? and scheduled = 1';
  const row = db.prepare(`
    select id, digest_date as date, overview, sections_json as sectionsJson, expires_at as expiresAt
    from telegram_digest_snapshots
    where destination = ? and expires_at > ? and ${condition}
  `).get(telegramDestination(chat), Date.now(), 'id' in lookup ? lookup.id : lookup.scheduledDate) as
    (Omit<TelegramDigestSnapshot, 'sections'> & { sectionsJson: string }) | undefined;
  if (!row) return undefined;
  const { sectionsJson, ...snapshot } = row;
  return { ...snapshot, sections: JSON.parse(sectionsJson) as TelegramDigestSection[] };
}

export function telegramViewToken(db: HedwigDb, chat: TelegramPrivateChat, view: TelegramView, expiresAt?: number): string {
  const now = Date.now();
  const destination = telegramDestination(chat);
  const viewJson = JSON.stringify(view);
  const row = db.prepare(`
    select token from telegram_view_tokens where destination = ? and view_json = ? and expires_at > ?
  `).get(destination, viewJson, now) as { token: string } | undefined;
  if (row) return row.token;
  const { token } = db.prepare(`
    insert into telegram_view_tokens (token, destination, view_json, expires_at)
    values (?, ?, ?, ?)
    on conflict(destination, view_json) do update set
      token = case when telegram_view_tokens.expires_at <= ? then excluded.token else telegram_view_tokens.token end,
      expires_at = case when telegram_view_tokens.expires_at <= ? then excluded.expires_at else telegram_view_tokens.expires_at end
    returning token
  `).get(randomBytes(16).toString('base64url'), destination, viewJson, expiresAt ?? now + CALLBACK_TTL_MS, now, now) as { token: string };
  return token;
}

export function findTelegramView(db: HedwigDb, chat: TelegramPrivateChat, action: string): TelegramView | undefined {
  const match = /^(view|mail):([A-Za-z0-9_-]{22})$/.exec(action);
  if (!match) return undefined;
  const token = match[2]!;
  if (match[1] === 'mail') {
    const legacy = db.prepare(`
      select mail_id as mailId from telegram_preview_tokens
      where token = ? and bot_id = ? and owner_user_id = ? and chat_id = ? and expires_at > ?
    `).get(token, chat.botId, chat.ownerUserId, chat.chatId, Date.now()) as { mailId: string } | undefined;
    return legacy && { kind: 'mail', mail: { mailId: legacy.mailId } };
  }
  const row = db.prepare(`
    select view_json as viewJson from telegram_view_tokens
    where token = ? and destination = ? and expires_at > ?
  `).get(token, telegramDestination(chat), Date.now()) as { viewJson: string } | undefined;
  return row && JSON.parse(row.viewJson) as TelegramView;
}

export function pruneTelegramViews(db: HedwigDb): void {
  const now = Date.now();
  db.prepare('delete from telegram_view_tokens where expires_at <= ?').run(now);
  db.prepare('delete from telegram_digest_snapshots where expires_at <= ?').run(now);
  db.prepare('delete from telegram_preview_tokens where expires_at <= ?').run(now);
}

export function acquireTelegramLease(db: HedwigDb, botId: number, now = Date.now()): string {
  const token = randomUUID();
  const { changes } = db.prepare(`
    insert into telegram_poll_state (bot_id, lease_token, lease_until) values (?, ?, ?)
    on conflict(bot_id) do update set lease_token = excluded.lease_token, lease_until = excluded.lease_until
    where lease_until is null or lease_until <= ?
  `).run(botId, token, now + LEASE_MS, now);
  if (!changes) throw new Error('Another Telegram poller holds this bot’s lease');
  return token;
}

export function renewTelegramLease(db: HedwigDb, botId: number, token: string, now = Date.now()): void {
  const { changes } = db.prepare(`
    update telegram_poll_state set lease_until = ? where bot_id = ? and lease_token = ? and lease_until > ?
  `).run(now + LEASE_MS, botId, token, now);
  if (!changes) throw new Error('Telegram poller lease expired or was replaced');
}

export function releaseTelegramLease(db: HedwigDb, botId: number, token: string): void {
  db.prepare(`
    update telegram_poll_state set lease_token = null, lease_until = null where bot_id = ? and lease_token = ?
  `).run(botId, token);
}

export function telegramOffset(db: HedwigDb, botId: number, now = Date.now()): number | undefined {
  const row = db.prepare(`
    select next_offset as offset from telegram_poll_state where bot_id = ? and offset_saved_at > ?
  `).get(botId, now - OFFSET_TTL_MS) as { offset: number } | undefined;
  return row?.offset;
}

export function saveTelegramOffset(db: HedwigDb, botId: number, lease: string, offset: number, now = Date.now()): void {
  const { changes } = db.prepare(`
    update telegram_poll_state set next_offset = ?, offset_saved_at = ?
    where bot_id = ? and lease_token = ? and lease_until > ?
  `).run(offset, now, botId, lease, now);
  if (!changes) throw new Error('Telegram poller lost its lease before confirming an update');
}

export function isTelegramChatReady(db: HedwigDb, chat: TelegramPrivateChat): boolean {
  return Boolean(db.prepare(`
    select 1 from telegram_private_chats where bot_id = ? and owner_user_id = ? and chat_id = ?
  `).get(chat.botId, chat.ownerUserId, chat.chatId));
}

export function markTelegramChatReady(db: HedwigDb, chat: TelegramPrivateChat): void {
  db.prepare(`
    insert into telegram_private_chats (bot_id, owner_user_id, chat_id) values (?, ?, ?) on conflict do nothing
  `).run(chat.botId, chat.ownerUserId, chat.chatId);
}



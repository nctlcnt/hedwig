import type { Database } from 'better-sqlite3';

export type FollowupKind = 'conversation' | 'todo' | 'read_later';
export type FollowupState = 'opening' | 'open' | 'closing' | 'closed' | 'failed';

export type FollowupRecord = {
  id: number;
  kind: FollowupKind;
  state: FollowupState;
  accountId: string;
  gmailThreadId: string;
  sourceGmailId: string;
  title: string;
  summary: string;
  discordForumChannelId: string | null;
  discordThreadId: string | null;
  discordMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  closeNote: string | null;
  lastError: string | null;
  retryCount: number;
};

export type FollowupMessage = {
  followupId: number;
  gmailId: string;
  sender: string;
  subject: string;
  messageDate: string | null;
  gmailUrl: string;
  bodyText: string;
  summary: string;
  attentionPoints: string[];
  suggestedActions: string[];
  links: Array<{ url: string; label?: string }>;
  capturedAt: string;
};

export type FollowupMessageInput = Omit<FollowupMessage, 'followupId' | 'capturedAt'> & {
  gmailThreadId: string;
};

export type FollowupReservation = {
  followup: FollowupRecord;
  created: boolean;
};

type StoredMailSnapshot = {
  accountId: string;
  gmailId: string;
  gmailThreadId: string;
  sender: string;
  subject: string;
  messageDate: string | null;
  gmailUrl: string;
  snippet: string;
  bodyText: string | null;
  summary: string | null;
  attentionPointsJson: string | null;
  suggestedActionsJson: string | null;
  linksJson: string | null;
};

type FollowupRow = {
  id: number;
  kind: string;
  state: string;
  accountId: string;
  gmailThreadId: string;
  sourceGmailId: string;
  title: string;
  summary: string;
  discordForumChannelId: string | null;
  discordThreadId: string | null;
  discordMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  closeNote: string | null;
  lastError: string | null;
  retryCount: number;
};

type FollowupMessageRow = {
  followupId: number;
  gmailId: string;
  sender: string;
  subject: string;
  messageDate: string | null;
  gmailUrl: string;
  bodyText: string;
  summary: string;
  attentionPointsJson: string;
  suggestedActionsJson: string;
  linksJson: string;
  capturedAt: string;
};

export function migrateFollowupStore(db: Database): void {
  db.exec(`
    create table if not exists followups (
      id integer primary key autoincrement,
      kind text not null check (kind in ('conversation', 'todo', 'read_later')),
      state text not null check (state in ('opening', 'open', 'closing', 'closed', 'failed')),
      account_id text not null,
      gmail_thread_id text not null,
      source_gmail_id text not null,
      title text not null,
      summary text not null,
      discord_forum_channel_id text,
      discord_thread_id text,
      discord_message_id text,
      created_at text not null,
      updated_at text not null,
      closed_at text,
      close_note text,
      last_error text,
      retry_count integer not null default 0,
      unique (account_id, gmail_thread_id),
      foreign key (account_id, source_gmail_id)
        references messages(account_id, gmail_id) on delete restrict
    );

    create table if not exists followup_messages (
      followup_id integer not null references followups(id) on delete cascade,
      gmail_id text not null,
      sender text not null,
      subject text not null,
      message_date text,
      gmail_url text not null,
      body_text text not null,
      summary text not null,
      attention_points_json text not null default '[]',
      suggested_actions_json text not null default '[]',
      links_json text not null default '[]',
      captured_at text not null,
      primary key (followup_id, gmail_id)
    );

    create index if not exists idx_followups_state_kind
      on followups(state, kind);

    create index if not exists idx_followup_messages_followup_date
      on followup_messages(followup_id, message_date, captured_at);
  `);
}

export function reserveFollowup(
  db: Database,
  accountId: string,
  gmailId: string,
  kind: FollowupKind,
  now: Date = new Date()
): FollowupReservation | null {
  const nowIso = now.toISOString();
  const source = storedMailSnapshot(db, accountId, gmailId, nowIso);
  if (!source) return null;

  return db.transaction(() => {
    const result = db.prepare(`
      insert into followups (
        kind, state, account_id, gmail_thread_id, source_gmail_id,
        title, summary, created_at, updated_at
      )
      values (?, 'opening', ?, ?, ?, ?, ?, ?, ?)
      on conflict(account_id, gmail_thread_id) do nothing
    `).run(
      kind,
      source.accountId,
      source.gmailThreadId,
      source.gmailId,
      source.subject || '(no subject)',
      source.summary || source.snippet || source.subject || '(no summary)',
      nowIso,
      nowIso
    );

    const followup = getFollowupByThread(db, source.accountId, source.gmailThreadId);
    if (!followup) {
      throw new Error('Failed to reserve follow-up record');
    }

    for (const message of storedThreadSnapshots(db, source.accountId, source.gmailThreadId, nowIso)) {
      insertFollowupMessage(db, followup.id, snapshotInput(message), nowIso);
    }

    return {
      followup,
      created: result.changes === 1
    };
  })();
}

export function getFollowup(db: Database, followupId: number): FollowupRecord | null {
  const row = db.prepare(`${followupSelect()} where id = ?`)
    .get(followupId) as FollowupRow | undefined;
  return row ? mapFollowup(row) : null;
}

export function getFollowupByThread(
  db: Database,
  accountId: string,
  gmailThreadId: string
): FollowupRecord | null {
  const row = db.prepare(`${followupSelect()} where account_id = ? and gmail_thread_id = ?`)
    .get(accountId, gmailThreadId) as FollowupRow | undefined;
  return row ? mapFollowup(row) : null;
}

export function listFollowupMessages(db: Database, followupId: number): FollowupMessage[] {
  const rows = db.prepare(`
    select
      followup_id as followupId,
      gmail_id as gmailId,
      sender,
      subject,
      message_date as messageDate,
      gmail_url as gmailUrl,
      body_text as bodyText,
      summary,
      attention_points_json as attentionPointsJson,
      suggested_actions_json as suggestedActionsJson,
      links_json as linksJson,
      captured_at as capturedAt
    from followup_messages
    where followup_id = ?
    order by coalesce(message_date, captured_at), captured_at, gmail_id
  `).all(followupId) as FollowupMessageRow[];
  return rows.map(mapFollowupMessage);
}

export function recordFollowupMessage(
  db: Database,
  followupId: number,
  message: FollowupMessageInput,
  now: Date = new Date()
): boolean {
  const followup = getFollowup(db, followupId);
  if (!followup) throw new Error(`Unknown follow-up: ${followupId}`);
  if (followup.gmailThreadId !== message.gmailThreadId) {
    throw new Error(
      `Message thread ${message.gmailThreadId} does not match follow-up thread ${followup.gmailThreadId}`
    );
  }
  return insertFollowupMessage(db, followupId, message, now.toISOString());
}

export function claimFailedFollowupRetry(
  db: Database,
  followupId: number,
  now: Date = new Date()
): boolean {
  const result = db.prepare(`
    update followups
    set state = 'opening', updated_at = ?, last_error = null
    where id = ? and state = 'failed'
  `).run(now.toISOString(), followupId);
  return result.changes === 1;
}

export function attachFollowupDiscordThread(
  db: Database,
  followupId: number,
  discord: {
    forumChannelId: string;
    threadId: string;
    messageId: string;
  },
  now: Date = new Date()
): FollowupRecord {
  if (!discord.forumChannelId || !discord.threadId || !discord.messageId) {
    throw new Error('Discord follow-up identifiers must be non-empty');
  }

  const current = requireFollowup(db, followupId);
  if (current.state === 'open') {
    const sameIds = current.discordForumChannelId === discord.forumChannelId
      && current.discordThreadId === discord.threadId
      && current.discordMessageId === discord.messageId;
    if (!sameIds) {
      throw new Error(`Follow-up ${followupId} is already attached to another Discord thread`);
    }
    return current;
  }
  if (current.state !== 'opening') {
    throw new Error(`Cannot attach Discord thread while follow-up ${followupId} is ${current.state}`);
  }

  db.prepare(`
    update followups
    set
      state = 'open',
      discord_forum_channel_id = ?,
      discord_thread_id = ?,
      discord_message_id = ?,
      updated_at = ?,
      last_error = null
    where id = ? and state = 'opening'
  `).run(
    discord.forumChannelId,
    discord.threadId,
    discord.messageId,
    now.toISOString(),
    followupId
  );
  return requireFollowup(db, followupId);
}

export function recordFollowupFailure(
  db: Database,
  followupId: number,
  error: unknown,
  now: Date = new Date()
): FollowupRecord {
  const current = requireFollowup(db, followupId);
  if (current.state !== 'opening' && current.state !== 'failed') {
    throw new Error(`Cannot record creation failure while follow-up ${followupId} is ${current.state}`);
  }
  db.prepare(`
    update followups
    set state = 'failed', updated_at = ?, last_error = ?, retry_count = retry_count + 1
    where id = ?
  `).run(now.toISOString(), errorMessage(error).slice(0, 2000), followupId);
  return requireFollowup(db, followupId);
}

export function beginFollowupClose(
  db: Database,
  followupId: number,
  now: Date = new Date()
): FollowupRecord {
  const current = requireFollowup(db, followupId);
  if (current.state === 'closing' || current.state === 'closed') return current;
  if (current.state !== 'open') {
    throw new Error(`Cannot close follow-up ${followupId} while it is ${current.state}`);
  }
  db.prepare(`
    update followups set state = 'closing', updated_at = ? where id = ? and state = 'open'
  `).run(now.toISOString(), followupId);
  return requireFollowup(db, followupId);
}

export function completeFollowupClose(
  db: Database,
  followupId: number,
  note: string | null,
  now: Date = new Date()
): FollowupRecord {
  const current = requireFollowup(db, followupId);
  if (current.state === 'closed') return current;
  if (current.state !== 'open' && current.state !== 'closing') {
    throw new Error(`Cannot complete follow-up ${followupId} while it is ${current.state}`);
  }
  const nowIso = now.toISOString();
  db.prepare(`
    update followups
    set state = 'closed', close_note = ?, closed_at = ?, updated_at = ?
    where id = ?
  `).run(note?.trim() || null, nowIso, nowIso, followupId);
  return requireFollowup(db, followupId);
}

function storedMailSnapshot(
  db: Database,
  accountId: string,
  gmailId: string,
  nowIso: string
): StoredMailSnapshot | null {
  const row = db.prepare(`
    select
      m.account_id as accountId,
      m.gmail_id as gmailId,
      m.thread_id as gmailThreadId,
      m.sender,
      m.subject,
      m.message_date as messageDate,
      m.gmail_url as gmailUrl,
      m.snippet,
      b.body_text as bodyText,
      c.summary,
      c.attention_points_json as attentionPointsJson,
      c.suggested_actions_json as suggestedActionsJson,
      b.links_json as linksJson
    from messages m
    left join email_body_cache b
      on b.account_id = m.account_id
      and b.gmail_id = m.gmail_id
      and b.expires_at > ?
    left join message_classifications c
      on c.id = (
        select c2.id
        from message_classifications c2
        where c2.account_id = m.account_id and c2.gmail_id = m.gmail_id
        order by c2.processed_at desc, c2.id desc
        limit 1
      )
    where m.account_id = ? and m.gmail_id = ?
  `).get(nowIso, accountId, gmailId) as StoredMailSnapshot | undefined;
  return row ?? null;
}

function storedThreadSnapshots(
  db: Database,
  accountId: string,
  gmailThreadId: string,
  nowIso: string
): StoredMailSnapshot[] {
  return db.prepare(`
    select
      m.account_id as accountId,
      m.gmail_id as gmailId,
      m.thread_id as gmailThreadId,
      m.sender,
      m.subject,
      m.message_date as messageDate,
      m.gmail_url as gmailUrl,
      m.snippet,
      b.body_text as bodyText,
      c.summary,
      c.attention_points_json as attentionPointsJson,
      c.suggested_actions_json as suggestedActionsJson,
      b.links_json as linksJson
    from messages m
    left join email_body_cache b
      on b.account_id = m.account_id
      and b.gmail_id = m.gmail_id
      and b.expires_at > ?
    left join message_classifications c
      on c.id = (
        select c2.id
        from message_classifications c2
        where c2.account_id = m.account_id and c2.gmail_id = m.gmail_id
        order by c2.processed_at desc, c2.id desc
        limit 1
      )
    where m.account_id = ? and m.thread_id = ?
    order by coalesce(m.message_date, m.updated_at), m.gmail_id
  `).all(nowIso, accountId, gmailThreadId) as StoredMailSnapshot[];
}

function snapshotInput(source: StoredMailSnapshot): FollowupMessageInput {
  return {
    gmailThreadId: source.gmailThreadId,
    gmailId: source.gmailId,
    sender: source.sender,
    subject: source.subject,
    messageDate: source.messageDate,
    gmailUrl: source.gmailUrl,
    bodyText: source.bodyText || source.snippet,
    summary: source.summary || source.snippet || source.subject,
    attentionPoints: parseStringArray(source.attentionPointsJson),
    suggestedActions: parseStringArray(source.suggestedActionsJson),
    links: parseLinks(source.linksJson)
  };
}

function insertFollowupMessage(
  db: Database,
  followupId: number,
  message: FollowupMessageInput,
  capturedAt: string
): boolean {
  const result = db.prepare(`
    insert into followup_messages (
      followup_id, gmail_id, sender, subject, message_date, gmail_url, body_text, summary,
      attention_points_json, suggested_actions_json, links_json, captured_at
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(followup_id, gmail_id) do nothing
  `).run(
    followupId,
    message.gmailId,
    message.sender,
    message.subject,
    message.messageDate,
    message.gmailUrl,
    message.bodyText,
    message.summary,
    JSON.stringify(message.attentionPoints),
    JSON.stringify(message.suggestedActions),
    JSON.stringify(message.links),
    capturedAt
  );
  return result.changes === 1;
}

function followupSelect(): string {
  return `
    select
      id,
      kind,
      state,
      account_id as accountId,
      gmail_thread_id as gmailThreadId,
      source_gmail_id as sourceGmailId,
      title,
      summary,
      discord_forum_channel_id as discordForumChannelId,
      discord_thread_id as discordThreadId,
      discord_message_id as discordMessageId,
      created_at as createdAt,
      updated_at as updatedAt,
      closed_at as closedAt,
      close_note as closeNote,
      last_error as lastError,
      retry_count as retryCount
    from followups
  `;
}

function requireFollowup(db: Database, followupId: number): FollowupRecord {
  const followup = getFollowup(db, followupId);
  if (!followup) throw new Error(`Unknown follow-up: ${followupId}`);
  return followup;
}

function mapFollowup(row: FollowupRow): FollowupRecord {
  return {
    ...row,
    kind: row.kind as FollowupKind,
    state: row.state as FollowupState
  };
}

function mapFollowupMessage(row: FollowupMessageRow): FollowupMessage {
  return {
    followupId: row.followupId,
    gmailId: row.gmailId,
    sender: row.sender,
    subject: row.subject,
    messageDate: row.messageDate,
    gmailUrl: row.gmailUrl,
    bodyText: row.bodyText,
    summary: row.summary,
    attentionPoints: parseStringArray(row.attentionPointsJson),
    suggestedActions: parseStringArray(row.suggestedActionsJson),
    links: parseLinks(row.linksJson),
    capturedAt: row.capturedAt
  };
}

function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function parseLinks(raw: string | null): Array<{ url: string; label?: string }> {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (typeof item === 'string') return [{ url: item }];
      if (!item || typeof item !== 'object' || !('url' in item) || typeof item.url !== 'string') {
        return [];
      }
      const label = 'label' in item && typeof item.label === 'string' ? item.label : undefined;
      return [label ? { url: item.url, label } : { url: item.url }];
    });
  } catch {
    return [];
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

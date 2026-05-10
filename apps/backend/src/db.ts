import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { AppConfig, Category, Classification, DigestItem, EmailMessage, ProcessingAction } from './types.js';

export type HedwigDb = DatabaseType;

export function openDatabase(config: AppConfig): HedwigDb {
  mkdirSync(dirname(config.database.path), { recursive: true });
  const db = new Database(config.database.path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function createDigestRun(db: HedwigDb, accountId: string, account: string, startedAt: Date): number {
  const result = db.prepare(`
    insert into digest_runs (account_id, account, started_at, status)
    values (?, ?, ?, 'running')
  `).run(accountId, account, startedAt.toISOString());
  return Number(result.lastInsertRowid);
}

export function finishDigestRun(db: HedwigDb, runId: number, total: number): void {
  db.prepare(`
    update digest_runs
    set finished_at = ?, total_messages = ?, status = 'sent'
    where id = ?
  `).run(new Date().toISOString(), total, runId);
}

export function updateDigestRunAccount(db: HedwigDb, runId: number, account: string): void {
  db.prepare(`
    update digest_runs
    set account = ?
    where id = ?
  `).run(account, runId);
}

export function failDigestRun(db: HedwigDb, runId: number, error: unknown): void {
  db.prepare(`
    update digest_runs
    set finished_at = ?, status = 'failed', error = ?
    where id = ?
  `).run(new Date().toISOString(), errorMessage(error), runId);
}

export function saveMessage(db: HedwigDb, account: string, email: EmailMessage): void {
  db.prepare(`
    insert into messages (
      account_id, gmail_id, thread_id, account, sender, subject, message_date, snippet, gmail_url, updated_at
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(account_id, gmail_id) do update set
      thread_id = excluded.thread_id,
      account = excluded.account,
      sender = excluded.sender,
      subject = excluded.subject,
      message_date = excluded.message_date,
      snippet = excluded.snippet,
      gmail_url = excluded.gmail_url,
      updated_at = excluded.updated_at
  `).run(
    email.accountId,
    email.id,
    email.threadId,
    account,
    email.from,
    email.subject,
    email.date?.toISOString() || null,
    email.snippet,
    email.gmailUrl,
    new Date().toISOString()
  );
}

export function saveClassification(
  db: HedwigDb,
  runId: number,
  email: EmailMessage,
  classification: Classification,
  processedAs: ProcessingAction
): void {
  db.prepare(`
    insert into message_classifications (
      run_id, account_id, gmail_id, category, summary, importance, confidence, provider, reason, processed_as, processed_at, created_at
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    email.accountId,
    email.id,
    classification.category,
    classification.summary,
    classification.importance,
    classification.confidence,
    classification.provider,
    classification.reason || '',
    processedAs,
    new Date().toISOString(),
    new Date().toISOString()
  );
}

export function listProcessedDigestItems(
  db: HedwigDb,
  start: Date,
  end: Date
): DigestItem[] {
  const rows = db.prepare(`
    select
      m.account_id as accountId,
      m.account as accountEmail,
      m.gmail_id as id,
      m.sender as sender,
      m.subject as subject,
      m.gmail_url as gmailUrl,
      c.category as category,
      c.summary as summary,
      c.importance as importance,
      c.confidence as confidence,
      c.provider as provider,
      c.processed_as as processedAs,
      c.processed_at as processedAt
    from message_classifications c
    join messages m
      on m.account_id = c.account_id
      and m.gmail_id = c.gmail_id
    join (
      select account_id, gmail_id, max(id) as id
      from message_classifications
      where processed_at >= ? and processed_at < ?
      group by account_id, gmail_id
    ) latest
      on latest.account_id = c.account_id
      and latest.gmail_id = c.gmail_id
      and latest.id = c.id
    order by c.importance desc, c.processed_at desc
  `).all(start.toISOString(), end.toISOString()) as Array<{
    accountId: string;
    accountEmail: string;
    id: string;
    sender: string;
    subject: string;
    gmailUrl: string;
    category: Category;
    summary: string;
    importance: number;
    confidence: number;
    provider: string;
    processedAs: ProcessingAction;
  }>;

  return rows.map((row) => ({
    accountId: row.accountId,
    accountName: row.accountEmail,
    mailId: `${row.accountId}:${row.id}`,
    id: row.id,
    category: row.category,
    from: row.sender,
    subject: row.subject,
    summary: row.summary,
    importance: row.importance,
    confidence: row.confidence,
    provider: row.provider,
    processedAs: row.processedAs,
    gmailUrl: row.gmailUrl
  }));
}

function migrate(db: HedwigDb): void {
  const existingColumns = tableColumns(db, 'messages');
  if (existingColumns.includes('gmail_id') && !existingColumns.includes('account_id')) {
    migrateMessagesToAccountScopedKeys(db);
  }

  db.exec(`
    create table if not exists digest_runs (
      id integer primary key autoincrement,
      account_id text not null default 'primary',
      account text not null,
      started_at text not null,
      finished_at text,
      status text not null check (status in ('running', 'sent', 'failed')),
      total_messages integer not null default 0,
      error text
    );

    create table if not exists messages (
      account_id text not null default 'primary',
      gmail_id text not null,
      thread_id text not null,
      account text not null,
      sender text not null,
      subject text not null,
      message_date text,
      snippet text not null,
      gmail_url text not null,
      updated_at text not null,
      primary key (account_id, gmail_id)
    );

    create table if not exists message_classifications (
      id integer primary key autoincrement,
      run_id integer not null references digest_runs(id) on delete cascade,
      account_id text not null default 'primary',
      gmail_id text not null,
      category text not null check (category in ('action', 'fyi', 'course', 'admin', 'junk')),
      summary text not null,
      importance integer not null,
      confidence real not null,
      provider text not null,
      reason text not null default '',
      processed_as text not null default 'digest_only' check (processed_as in ('archive', 'digest_only', 'push_now')),
      processed_at text not null default CURRENT_TIMESTAMP,
      created_at text not null
    );

    create index if not exists idx_message_classifications_run_id
      on message_classifications(run_id);

    create index if not exists idx_message_classifications_gmail_id
      on message_classifications(account_id, gmail_id);
  `);

  addColumnIfMissing(db, 'digest_runs', 'account_id', "text not null default 'primary'");
  addColumnIfMissing(db, 'message_classifications', 'account_id', "text not null default 'primary'");
  addColumnIfMissing(db, 'message_classifications', 'processed_as', "text not null default 'digest_only'");
  addColumnIfMissing(db, 'message_classifications', 'processed_at', 'text');
  backfillProcessedAt(db);
}

function migrateMessagesToAccountScopedKeys(db: HedwigDb): void {
  db.pragma('foreign_keys = OFF');
  const hasClassifications = tableColumns(db, 'message_classifications').length > 0;
  try {
    db.exec(`
      begin;

      alter table messages rename to messages_legacy_single_account;

      create table messages (
        account_id text not null default 'primary',
        gmail_id text not null,
        thread_id text not null,
        account text not null,
        sender text not null,
        subject text not null,
        message_date text,
        snippet text not null,
        gmail_url text not null,
        updated_at text not null,
        primary key (account_id, gmail_id)
      );

      insert into messages (
        account_id, gmail_id, thread_id, account, sender, subject, message_date, snippet, gmail_url, updated_at
      )
      select 'primary', gmail_id, thread_id, account, sender, subject, message_date, snippet, gmail_url, updated_at
      from messages_legacy_single_account;

      drop table messages_legacy_single_account;
    `);
    if (hasClassifications) {
      db.exec(`
        alter table message_classifications rename to message_classifications_legacy_single_account;

        create table message_classifications (
          id integer primary key autoincrement,
          run_id integer not null references digest_runs(id) on delete cascade,
          account_id text not null default 'primary',
          gmail_id text not null,
          category text not null check (category in ('action', 'fyi', 'course', 'admin', 'junk')),
          summary text not null,
          importance integer not null,
          confidence real not null,
          provider text not null,
          reason text not null default '',
          processed_as text not null default 'digest_only' check (processed_as in ('archive', 'digest_only', 'push_now')),
          processed_at text not null default CURRENT_TIMESTAMP,
          created_at text not null
        );

        insert into message_classifications (
          id, run_id, account_id, gmail_id, category, summary, importance, confidence, provider, reason, processed_as, processed_at, created_at
        )
        select id, run_id, 'primary', gmail_id, category, summary, importance, confidence, provider, reason, 'digest_only', created_at, created_at
        from message_classifications_legacy_single_account;

        drop table message_classifications_legacy_single_account;
      `);
    }
    db.exec('commit;');
  } catch (error) {
    db.exec('rollback;');
    throw error;
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function addColumnIfMissing(db: HedwigDb, table: string, column: string, definition: string): void {
  if (tableColumns(db, table).includes(column)) return;
  db.exec(`alter table ${table} add column ${column} ${definition};`);
}

function backfillProcessedAt(db: HedwigDb): void {
  if (!tableColumns(db, 'message_classifications').includes('processed_at')) return;
  db.prepare(`
    update message_classifications
    set processed_at = created_at
    where processed_at is null or processed_at = ''
  `).run();
}

function tableColumns(db: HedwigDb, table: string): string[] {
  return db.prepare(`pragma table_info(${table})`).all()
    .map((row) => (row as { name: string }).name);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

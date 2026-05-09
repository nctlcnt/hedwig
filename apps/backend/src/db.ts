import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { AppConfig, Classification, EmailMessage } from './types.js';

export type HedwigDb = DatabaseType;

export function openDatabase(config: AppConfig): HedwigDb {
  mkdirSync(dirname(config.database.path), { recursive: true });
  const db = new Database(config.database.path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function createDigestRun(db: HedwigDb, account: string, startedAt: Date): number {
  const result = db.prepare(`
    insert into digest_runs (account, started_at, status)
    values (?, ?, 'running')
  `).run(account, startedAt.toISOString());
  return Number(result.lastInsertRowid);
}

export function finishDigestRun(db: HedwigDb, runId: number, total: number): void {
  db.prepare(`
    update digest_runs
    set finished_at = ?, total_messages = ?, status = 'sent'
    where id = ?
  `).run(new Date().toISOString(), total, runId);
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
      gmail_id, thread_id, account, sender, subject, message_date, snippet, gmail_url, updated_at
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(gmail_id) do update set
      thread_id = excluded.thread_id,
      account = excluded.account,
      sender = excluded.sender,
      subject = excluded.subject,
      message_date = excluded.message_date,
      snippet = excluded.snippet,
      gmail_url = excluded.gmail_url,
      updated_at = excluded.updated_at
  `).run(
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
  classification: Classification
): void {
  db.prepare(`
    insert into message_classifications (
      run_id, gmail_id, category, summary, importance, confidence, provider, reason, created_at
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    email.id,
    classification.category,
    classification.summary,
    classification.importance,
    classification.confidence,
    classification.provider,
    classification.reason || '',
    new Date().toISOString()
  );
}

function migrate(db: HedwigDb): void {
  db.exec(`
    create table if not exists digest_runs (
      id integer primary key autoincrement,
      account text not null,
      started_at text not null,
      finished_at text,
      status text not null check (status in ('running', 'sent', 'failed')),
      total_messages integer not null default 0,
      error text
    );

    create table if not exists messages (
      gmail_id text primary key,
      thread_id text not null,
      account text not null,
      sender text not null,
      subject text not null,
      message_date text,
      snippet text not null,
      gmail_url text not null,
      updated_at text not null
    );

    create table if not exists message_classifications (
      id integer primary key autoincrement,
      run_id integer not null references digest_runs(id) on delete cascade,
      gmail_id text not null references messages(gmail_id) on delete cascade,
      category text not null check (category in ('action', 'fyi', 'course', 'admin', 'junk')),
      summary text not null,
      importance integer not null,
      confidence real not null,
      provider text not null,
      reason text not null default '',
      created_at text not null
    );

    create index if not exists idx_message_classifications_run_id
      on message_classifications(run_id);

    create index if not exists idx_message_classifications_gmail_id
      on message_classifications(gmail_id);
  `);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

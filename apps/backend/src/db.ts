import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { buildGmailMessageUrl } from './gmail-url.js';
import type {
  AppConfig,
  CachedEmailPreview,
  Category,
  Classification,
  DigestItem,
  EmailMessage,
  ProcessingOutcome
} from './types.js';

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

export function saveEmailBodyCache(db: HedwigDb, email: EmailMessage): void {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  db.prepare(`
    insert into email_body_cache (
      account_id, gmail_id, body_text, links_json, created_at, expires_at
    )
    values (?, ?, ?, ?, ?, ?)
    on conflict(account_id, gmail_id) do update set
      body_text = excluded.body_text,
      links_json = excluded.links_json,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at
  `).run(
    email.accountId,
    email.id,
    email.text,
    JSON.stringify(extractUsefulLinks(email.text)),
    now.toISOString(),
    expiresAt.toISOString()
  );
}

export function saveClassification(
  db: HedwigDb,
  runId: number,
  email: EmailMessage,
  classification: Classification,
  processingOutcome: ProcessingOutcome
): void {
  db.prepare(`
    insert into message_classifications (
      run_id, account_id, gmail_id, category, summary, attention_points_json,
      suggested_actions_json, importance, confidence, provider, reason,
      processing_outcome, processed_at, created_at
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    email.accountId,
    email.id,
    classification.category,
    classification.summary,
    JSON.stringify(classification.attentionPoints),
    JSON.stringify(classification.suggestedActions),
    classification.importance,
    classification.confidence,
    classification.provider,
    classification.reason || '',
    processingOutcome,
    new Date().toISOString(),
    new Date().toISOString()
  );
}

function alertKey(signature: string): string {
  return signature.slice(0, 300);
}

// Read-only dedup check for operational alerts: true when this signature already
// fired within cooldownMs and should stay suppressed. It does NOT claim the slot
// — the caller records the send via recordAlertSent only after it succeeds, so a
// failed Discord post doesn't silence the alert for the whole window.
export function isAlertOnCooldown(db: HedwigDb, signature: string, cooldownMs: number, now: Date = new Date()): boolean {
  const row = db.prepare(`
    select last_sent_at as lastSentAt from alert_log where signature = ?
  `).get(alertKey(signature)) as { lastSentAt: string } | undefined;
  return Boolean(row && now.getTime() - new Date(row.lastSentAt).getTime() < cooldownMs);
}

// Stamps the last-sent time for a signature, starting a fresh cooldown window.
// Call this only after the alert was actually delivered.
export function recordAlertSent(db: HedwigDb, signature: string, now: Date = new Date()): void {
  db.prepare(`
    insert into alert_log (signature, last_sent_at)
    values (?, ?)
    on conflict(signature) do update set last_sent_at = excluded.last_sent_at
  `).run(alertKey(signature), now.toISOString());
}

const SUMMARY_LANGUAGE_SETTING = 'summary_language';

export function getSummaryLanguage(db: HedwigDb): string | null {
  const row = db.prepare(`
    select value from app_settings where key = ?
  `).get(SUMMARY_LANGUAGE_SETTING) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSummaryLanguage(db: HedwigDb, language: string): void {
  db.prepare(`
    insert into app_settings (key, value, updated_at)
    values (?, ?, ?)
    on conflict(key) do update set
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(SUMMARY_LANGUAGE_SETTING, language, new Date().toISOString());
}

// The per-account incremental-sync cursor (a Gmail historyId). This is how
// Hedwig discovers new inbox mail without depending on Gmail's read/star/label
// state. Null until the first run bootstraps it.
export function getSyncCursor(db: HedwigDb, accountId: string): string | null {
  const row = db.prepare(`
    select history_id as historyId from sync_state where account_id = ?
  `).get(accountId) as { historyId: string } | undefined;
  return row?.historyId ?? null;
}

export function setSyncCursor(db: HedwigDb, accountId: string, historyId: string): void {
  db.prepare(`
    insert into sync_state (account_id, history_id, updated_at)
    values (?, ?, ?)
    on conflict(account_id) do update set
      history_id = excluded.history_id,
      updated_at = excluded.updated_at
  `).run(accountId, historyId, new Date().toISOString());
}

// Returns which of the given Gmail ids have already been classified for this
// account. This is the dedup signal that replaces relying on Gmail's read flag,
// so processed mail can be left unread/in-inbox without being reprocessed (and
// re-pushed to Discord) on the next run.
export function findProcessedGmailIds(db: HedwigDb, accountId: string, gmailIds: string[]): Set<string> {
  if (gmailIds.length === 0) return new Set();
  const placeholders = gmailIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    select distinct gmail_id as gmailId
    from message_classifications
    where account_id = ? and gmail_id in (${placeholders})
  `).all(accountId, ...gmailIds) as Array<{ gmailId: string }>;
  return new Set(rows.map((row) => row.gmailId));
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
      m.thread_id as threadId,
      m.sender as sender,
      m.subject as subject,
      c.category as category,
      c.summary as summary,
      c.attention_points_json as attentionPointsJson,
      c.suggested_actions_json as suggestedActionsJson,
      c.importance as importance,
      c.confidence as confidence,
      c.provider as provider,
      c.processing_outcome as processingOutcome,
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
    where c.processing_outcome != 'suppress'
    order by c.importance desc, c.processed_at desc
  `).all(start.toISOString(), end.toISOString()) as Array<{
    accountId: string;
    accountEmail: string;
    id: string;
    threadId: string;
    sender: string;
    subject: string;
    category: Category;
    summary: string;
    attentionPointsJson: string;
    suggestedActionsJson: string;
    importance: number;
    confidence: number;
    provider: string;
    processingOutcome: ProcessingOutcome;
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
    attentionPoints: parseStringArray(row.attentionPointsJson),
    suggestedActions: parseStringArray(row.suggestedActionsJson),
    importance: row.importance,
    confidence: row.confidence,
    provider: row.provider,
    processingOutcome: row.processingOutcome,
    gmailUrl: buildGmailMessageUrl(row.accountEmail, row.threadId)
  }));
}

export function getCachedEmailPreview(db: HedwigDb, mailId: string): CachedEmailPreview | null {
  const parsed = parseMailId(mailId);
  if (!parsed) return null;
  deleteExpiredEmailBodyCache(db);

  const row = db.prepare(`
    select
      m.account_id as accountId,
      m.account as accountName,
      m.gmail_id as id,
      m.thread_id as threadId,
      m.sender as sender,
      m.subject as subject,
      c.summary as summary,
      c.attention_points_json as attentionPointsJson,
      c.suggested_actions_json as suggestedActionsJson,
      b.body_text as bodyText,
      b.links_json as linksJson,
      b.expires_at as expiresAt
    from messages m
    join email_body_cache b
      on b.account_id = m.account_id
      and b.gmail_id = m.gmail_id
    left join (
      select account_id, gmail_id, max(id) as id
      from message_classifications
      group by account_id, gmail_id
    ) latest
      on latest.account_id = m.account_id
      and latest.gmail_id = m.gmail_id
    left join message_classifications c
      on c.account_id = latest.account_id
      and c.gmail_id = latest.gmail_id
      and c.id = latest.id
    where m.account_id = ?
      and m.gmail_id = ?
      and b.expires_at > ?
    limit 1
  `).get(parsed.accountId, parsed.gmailId, new Date().toISOString()) as {
    accountId: string;
    accountName: string;
    id: string;
    threadId: string;
    sender: string;
    subject: string;
    summary: string | null;
    attentionPointsJson: string | null;
    suggestedActionsJson: string | null;
    bodyText: string;
    linksJson: string;
    expiresAt: string;
  } | undefined;

  if (!row) return null;

  return {
    accountId: row.accountId,
    accountName: row.accountName,
    mailId,
    id: row.id,
    from: row.sender,
    subject: row.subject,
    summary: row.summary || '',
    attentionPoints: parseStringArray(row.attentionPointsJson),
    suggestedActions: parseStringArray(row.suggestedActionsJson),
    bodyText: row.bodyText,
    links: parseLinks(row.linksJson),
    gmailUrl: buildGmailMessageUrl(row.accountName, row.threadId),
    expiresAt: row.expiresAt
  };
}

export function deleteExpiredEmailBodyCache(db: HedwigDb): number {
  const result = db.prepare(`
    delete from email_body_cache
    where expires_at <= ?
  `).run(new Date().toISOString());
  return result.changes;
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
      attention_points_json text not null default '[]',
      suggested_actions_json text not null default '[]',
      importance integer not null,
      confidence real not null,
      provider text not null,
      reason text not null default '',
      processing_outcome text not null default 'digest_only'
        check (processing_outcome in ('suppress', 'digest_only', 'push_now')),
      processed_at text not null default CURRENT_TIMESTAMP,
      created_at text not null
    );

    create table if not exists email_body_cache (
      account_id text not null,
      gmail_id text not null,
      body_text text not null,
      links_json text not null default '[]',
      created_at text not null,
      expires_at text not null,
      primary key (account_id, gmail_id),
      foreign key (account_id, gmail_id) references messages(account_id, gmail_id) on delete cascade
    );

    create table if not exists cleanup_log (
      account_id text not null,
      gmail_id text not null,
      category text not null,
      importance integer not null default 0,
      processed_at text,
      trashed_at text not null,
      reason text not null default '',
      primary key (account_id, gmail_id)
    );

    create table if not exists sync_state (
      account_id text not null primary key,
      history_id text not null,
      updated_at text not null
    );

    create table if not exists alert_log (
      signature text not null primary key,
      last_sent_at text not null
    );

    create table if not exists app_settings (
      key text not null primary key,
      value text not null,
      updated_at text not null
    );

    create index if not exists idx_message_classifications_run_id
      on message_classifications(run_id);

    create index if not exists idx_message_classifications_gmail_id
      on message_classifications(account_id, gmail_id);

    create index if not exists idx_email_body_cache_expires_at
      on email_body_cache(expires_at);
  `);

  addColumnIfMissing(db, 'digest_runs', 'account_id', "text not null default 'primary'");
  addColumnIfMissing(db, 'message_classifications', 'account_id', "text not null default 'primary'");
  addColumnIfMissing(db, 'message_classifications', 'processed_at', 'text');
  addColumnIfMissing(db, 'message_classifications', 'attention_points_json', "text not null default '[]'");
  addColumnIfMissing(db, 'message_classifications', 'suggested_actions_json', "text not null default '[]'");
  migrateProcessingOutcome(db);
  backfillProcessedAt(db);
  deleteExpiredEmailBodyCache(db);
}

function parseMailId(mailId: string): { accountId: string; gmailId: string } | null {
  const separator = mailId.indexOf(':');
  if (separator <= 0 || separator === mailId.length - 1) return null;
  return {
    accountId: mailId.slice(0, separator),
    gmailId: mailId.slice(separator + 1)
  };
}

function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

type ScoredLink = {
  url: string;
  label: string;
  score: number;
  index: number;
};

const LINK_CONTEXT_TERMS = [
  'apply',
  'appointment',
  'assignment',
  'book',
  'booking',
  'calendar',
  'class',
  'course',
  'deadline',
  'docs',
  'document',
  'enrol',
  'enroll',
  'event',
  'form',
  'homework',
  'invoice',
  'join',
  'login',
  'meet',
  'meeting',
  'pay',
  'portal',
  'receipt',
  'register',
  'schedule',
  'zoom',
  '会议',
  '作业',
  '发票',
  '报名',
  '支付',
  '文档',
  '日程',
  '申请',
  '课程',
  '链接',
  '预约'
];

const NOISY_LINK_TERMS = [
  'beacon',
  'email-preferences',
  'pixel',
  'preferences',
  'profile_center',
  'tracking',
  'unsubscribe',
  'view-in-browser',
  'webversion'
];

const STATIC_FILE_RE = /\.(?:avif|css|gif|ico|jpe?g|js|png|svg|webp)(?:[?#]|$)/i;
const REDIRECT_PARAMS = ['url', 'u', 'target', 'redirect', 'redirect_url', 'destination'];
const MIN_LINK_SCORE = 8;

function extractUsefulLinks(text: string): Array<{ url: string; label: string }> {
  const matches = Array.from(text.matchAll(/https?:\/\/[^\s<>"')\]]+/g));
  const seen = new Set<string>();
  const byDomain = new Map<string, number>();
  const scored: ScoredLink[] = [];

  for (const match of matches) {
    const url = cleanUrl(match[0]);
    const displayUrl = displayUrlFor(url);
    const parsed = parseUrl(displayUrl);
    if (!parsed) continue;
    if (seen.has(displayUrl)) continue;
    seen.add(displayUrl);

    const domain = displayDomain(parsed);
    const domainCount = byDomain.get(domain) || 0;
    const score = linkScore(url, displayUrl, parsed, text, match.index || 0, domainCount);
    if (score <= 0) continue;

    byDomain.set(domain, domainCount + 1);
    scored.push({
      url: displayUrl,
      label: linkLabel(parsed),
      score,
      index: match.index || 0
    });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .filter((link) => link.score >= MIN_LINK_SCORE)
    .slice(0, 5)
    .map(({ url, label }) => ({ url, label }));
}

function cleanUrl(raw: string): string {
  return raw.replace(/[.,;:!?]+$/g, '');
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function displayUrlFor(url: string): string {
  const parsed = parseUrl(url);
  if (!parsed) return url;
  for (const param of REDIRECT_PARAMS) {
    const value = parsed.searchParams.get(param);
    if (!value) continue;
    const nested = parseUrl(value);
    if (nested?.protocol === 'http:' || nested?.protocol === 'https:') {
      return nested.toString();
    }
  }
  return url;
}

function displayDomain(url: URL): string {
  return url.hostname.replace(/^www\./, '').toLowerCase();
}

function linkScore(
  originalUrl: string,
  displayUrl: string,
  parsed: URL,
  text: string,
  index: number,
  domainCount: number
): number {
  const haystack = `${originalUrl} ${displayUrl}`.toLowerCase();
  if (STATIC_FILE_RE.test(parsed.pathname)) return 0;
  if (isNoisyLink(haystack, parsed)) return 0;

  let score = 2;
  const domain = displayDomain(parsed);
  const context = text.slice(Math.max(0, index - 140), index + 220).toLowerCase();
  if (LINK_CONTEXT_TERMS.some((term) => context.includes(term))) score += 18;
  if (LINK_CONTEXT_TERMS.some((term) => haystack.includes(term))) score += 8;
  if (importantDomain(domain)) score += 12;
  if (parsed.searchParams.size > 6) score -= 5;
  if (originalUrl.length > 250) score -= 5;
  if (domainCount > 0) score -= domainCount * 8;
  return score;
}

function isNoisyLink(haystack: string, parsed: URL): boolean {
  if (NOISY_LINK_TERMS.some((term) => haystack.includes(term))) return true;
  if (/(^|\/)(click|open)(\/|$)/i.test(parsed.pathname)) return true;
  return parsed.searchParams.has('utm_medium')
    && parsed.searchParams.get('utm_medium')?.toLowerCase() === 'email'
    && parsed.searchParams.size > 5;
}

function importantDomain(domain: string): boolean {
  return [
    'calendly.com',
    'calendar.google.com',
    'docs.google.com',
    'drive.google.com',
    'forms.gle',
    'github.com',
    'meet.google.com',
    'notion.so',
    'stripe.com',
    'zoom.us'
  ].some((item) => domain === item || domain.endsWith(`.${item}`));
}

function linkLabel(url: URL): string {
  const domain = displayDomain(url);
  const path = url.pathname
    .split('/')
    .filter(Boolean)
    .slice(0, 2)
    .join('/');
  return path ? `打开 ${domain}/${path}` : `打开 ${domain}`;
}

function parseLinks(raw: string): Array<{ url: string; label?: string }> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        if (typeof item === 'string') return { url: item };
        if (item && typeof item === 'object' && 'url' in item && typeof item.url === 'string') {
          const label = 'label' in item && typeof item.label === 'string' ? item.label : undefined;
          return label ? { url: item.url, label } : { url: item.url };
        }
        return null;
      })
      .filter((item): item is { url: string; label?: string } => Boolean(item));
  } catch {
    return [];
  }
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
          attention_points_json text not null default '[]',
          suggested_actions_json text not null default '[]',
          importance integer not null,
          confidence real not null,
          provider text not null,
          reason text not null default '',
          processing_outcome text not null default 'digest_only'
            check (processing_outcome in ('suppress', 'digest_only', 'push_now')),
          processed_at text not null default CURRENT_TIMESTAMP,
          created_at text not null
        );

        insert into message_classifications (
          id, run_id, account_id, gmail_id, category, summary, attention_points_json,
          suggested_actions_json, importance, confidence, provider, reason,
          processing_outcome, processed_at, created_at
        )
        select id, run_id, 'primary', gmail_id, category, summary, '[]', '[]',
          importance, confidence, provider, reason, 'digest_only', created_at, created_at
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

function migrateProcessingOutcome(db: HedwigDb): void {
  const columns = tableColumns(db, 'message_classifications');
  if (columns.includes('processing_outcome')) return;
  if (!columns.includes('processed_as')) {
    addColumnIfMissing(
      db,
      'message_classifications',
      'processing_outcome',
      "text not null default 'digest_only'"
    );
    return;
  }

  db.pragma('foreign_keys = OFF');
  try {
    db.exec(`
      begin;

      alter table message_classifications rename to message_classifications_legacy_mailbox_actions;
      drop index if exists idx_message_classifications_run_id;
      drop index if exists idx_message_classifications_gmail_id;

      create table message_classifications (
        id integer primary key autoincrement,
        run_id integer not null references digest_runs(id) on delete cascade,
        account_id text not null default 'primary',
        gmail_id text not null,
        category text not null check (category in ('action', 'fyi', 'course', 'admin', 'junk')),
        summary text not null,
        attention_points_json text not null default '[]',
        suggested_actions_json text not null default '[]',
        importance integer not null,
        confidence real not null,
        provider text not null,
        reason text not null default '',
        processing_outcome text not null default 'digest_only'
          check (processing_outcome in ('suppress', 'digest_only', 'push_now')),
        processed_at text not null default CURRENT_TIMESTAMP,
        created_at text not null
      );

      insert into message_classifications (
        id, run_id, account_id, gmail_id, category, summary,
        attention_points_json, suggested_actions_json, importance, confidence,
        provider, reason, processing_outcome, processed_at, created_at
      )
      select
        id, run_id, account_id, gmail_id, category, summary,
        attention_points_json, suggested_actions_json, importance, confidence,
        provider, reason,
        case processed_as when 'archive' then 'suppress' else processed_as end,
        coalesce(processed_at, created_at), created_at
      from message_classifications_legacy_mailbox_actions;

      drop table message_classifications_legacy_mailbox_actions;

      create index if not exists idx_message_classifications_run_id
        on message_classifications(run_id);
      create index if not exists idx_message_classifications_gmail_id
        on message_classifications(account_id, gmail_id);

      commit;
    `);
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

import type { AppConfig, Category, ClassifierFailure, DigestItem, DigestReport, DigestSection } from './types.js';

const DISCORD_API = 'https://discord.com/api/v10';
const REPORT_CATEGORIES: Category[] = ['action', 'fyi', 'course', 'admin'];
const PREVIEW_BUTTON_PREFIX = 'email_preview:';
const SECTION_LABELS: Record<Category, string> = {
  action: 'Action 待处理',
  fyi: 'FYI 通知',
  course: 'Course 课程',
  admin: 'Admin 行政',
  junk: 'Junk 促销'
};
const DESCRIPTION_LIMIT = 4000;
const SECTION_DESCRIPTION_BUDGET = 3800;
const MAX_ACTION_ROWS = 5;
const MAX_BUTTONS_PER_MESSAGE = 25;
const THREAD_AUTO_ARCHIVE_MINUTES = 1440;

type CreatedMessage = { id: string };

export async function sendDiscordDigest(config: AppConfig, digest: DigestReport): Promise<void> {
  const root = await postMessage(config, config.discord.digestChannelId, summaryMessage(digest));
  if (digest.total === 0) return;

  const threadId = await startThread(config, config.discord.digestChannelId, root.id, threadName(digest));
  const numbers = reportedItemNumbers(digest);
  const failures: Error[] = [];
  for (const category of REPORT_CATEGORIES) {
    const section = digest.sections.find((entry) => entry.category === category);
    const items = section?.items || [];
    if (items.length === 0) continue;
    const chunks = chunkItems(section, items, numbers);
    for (let part = 0; part < chunks.length; part += 1) {
      const chunk = chunks[part];
      if (!chunk) continue;
      try {
        await postMessage(config, threadId, sectionMessage(category, section, items.length, chunk, numbers, part, chunks.length));
      } catch (error) {
        console.error(`Failed to post ${category} detail (part ${part + 1}/${chunks.length})`, error);
        failures.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `Failed to post ${failures.length} Discord digest detail message(s)`);
  }
}

export async function sendDiscordRealtime(config: AppConfig, item: DigestItem): Promise<void> {
  if (!config.discord.realtimeChannelId) {
    console.info(`Skipping realtime push for ${item.mailId}: DISCORD_REALTIME_CHANNEL_ID not set`);
    return;
  }
  await postMessage(config, config.discord.realtimeChannelId, withActionRows({
    content: null,
    embeds: [{
      title: '需要及时查看的邮件',
      description: [
        `**${escapeMarkdown(item.accountName)} / ${displaySender(item.from)}**`,
        escapeMarkdown(realtimeSummary(item)),
        `mail_id: \`${escapeMarkdown(item.mailId)}\``,
        `[打开 Gmail](${item.gmailUrl})`
      ].join('\n'),
      color: sectionColor('action'),
      timestamp: new Date().toISOString()
    }],
    allowed_mentions: { parse: [] }
  }, [item]));
}

const MAX_ALERT_ITEMS = 10;

export async function sendDiscordClassifierAlert(
  config: AppConfig,
  account: string,
  failures: ClassifierFailure[]
): Promise<void> {
  if (failures.length === 0) return;
  const channelId = config.discord.realtimeChannelId || config.discord.digestChannelId;
  if (!channelId) {
    console.info('Skipping classifier failure alert: no Discord channel configured');
    return;
  }

  const shown = failures.slice(0, MAX_ALERT_ITEMS);
  const lines = shown.map((failure) => (
    `• **${displaySender(failure.from)}** · ${escapeMarkdown(alertSubject(failure.subject))}\n  [打开 Gmail](${failure.gmailUrl})`
  ));
  const moreLine = failures.length > MAX_ALERT_ITEMS
    ? [`…还有 ${failures.length - MAX_ALERT_ITEMS} 封`]
    : [];
  const reasons = [...new Set(failures.map((failure) => failure.reason).filter(Boolean))].slice(0, 3);
  const reasonLine = reasons.length > 0 ? ['', `原因：${escapeMarkdown(reasons.join(' / ')).slice(0, 400)}`] : [];

  await postMessage(config, channelId, {
    content: null,
    embeds: [{
      title: `⚠️ ${failures.length} 封邮件 AI 分类失败（已用规则兜底）`,
      description: limitDescription([
        `账号 **${escapeMarkdown(account)}**：以下邮件的 AI 分类失败，已退回规则分类，可能不准确，请手动确认是否需要处理。`,
        '',
        ...lines,
        ...moreLine,
        ...reasonLine
      ].join('\n')),
      color: 0xf59e0b,
      timestamp: new Date().toISOString()
    }],
    allowed_mentions: { parse: [] }
  });
}

function alertSubject(subject: string): string {
  const raw = subject.replace(/\s+/g, ' ').trim();
  if (!raw) return '(no subject)';
  return raw.length > 90 ? `${raw.slice(0, 88)}…` : raw;
}

function authHeaders(config: AppConfig): Record<string, string> {
  return {
    Authorization: `Bot ${config.discord.botToken}`,
    'Content-Type': 'application/json'
  };
}

async function postMessage(config: AppConfig, channelId: string, body: unknown): Promise<CreatedMessage> {
  if (!channelId) {
    throw new Error('Discord channel id is required');
  }
  const response = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: authHeaders(config),
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Discord message failed: ${response.status} ${errorBody}`);
  }
  return await response.json() as CreatedMessage;
}

async function startThread(config: AppConfig, channelId: string, messageId: string, name: string): Promise<string> {
  const response = await fetch(`${DISCORD_API}/channels/${channelId}/messages/${messageId}/threads`, {
    method: 'POST',
    headers: authHeaders(config),
    body: JSON.stringify({ name, auto_archive_duration: THREAD_AUTO_ARCHIVE_MINUTES })
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Discord thread create failed: ${response.status} ${errorBody}`);
  }
  const thread = await response.json() as { id: string };
  return thread.id;
}

function threadName(digest: DigestReport): string {
  return `${digest.date} · 共 ${digest.total} 封`.slice(0, 100);
}

function summaryMessage(digest: DigestReport) {
  return {
    content: null,
    embeds: [summaryEmbed(digest), ...errorEmbeds(digest)],
    allowed_mentions: { parse: [] }
  };
}

function summaryEmbed(digest: DigestReport) {
  return {
    title: `[Daily Digest] ${digest.date} — 共 ${digest.total} 封`,
    description: limitDescription(summaryBody(digest)),
    color: pickColor(digest),
    footer: { text: 'Hedwig email digest · 明细见下方 thread' },
    timestamp: new Date().toISOString()
  };
}

function summaryBody(digest: DigestReport): string {
  if (digest.total === 0) {
    return '过去一个周期没有需要汇总的新邮件。';
  }
  const blocks = REPORT_CATEGORIES
    .map((category) => {
      const section = digest.sections.find((entry) => entry.category === category);
      const items = section?.items || [];
      if (items.length === 0) return '';
      const lead = section?.lead?.trim();
      const leadLine = lead ? `\n_${escapeMarkdown(lead)}_` : '';
      return `**${SECTION_LABELS[category]}（${items.length}）**${leadLine}`;
    })
    .filter(Boolean);
  return [summaryLine(digest), '', blocks.join('\n\n')].join('\n');
}

function summaryLine(digest: DigestReport): string {
  const c = digest.counts;
  return `今天 **${digest.total}** 封 · Action ${c.action} · FYI ${c.fyi} · Course ${c.course} · Admin ${c.admin} · Junk ${c.junk}`;
}

function sectionMessage(
  category: Category,
  section: DigestSection | undefined,
  total: number,
  items: DigestItem[],
  numbers: Map<string, number>,
  partIndex: number,
  partCount: number
) {
  const partSuffix = partCount > 1 ? ` · ${partIndex + 1}/${partCount}` : '';
  const lead = partIndex === 0 ? section?.lead?.trim() : '';
  const leadLine = lead ? [`_${escapeMarkdown(lead)}_`] : [];
  const lines = items.map((item) => formatLine(item, numbers.get(item.mailId)));
  return withActionRows({
    content: null,
    embeds: [{
      title: `${SECTION_LABELS[category]}（${total}）${partSuffix}`,
      description: limitDescription([...leadLine, ...lines].join('\n')),
      color: sectionColor(category)
    }],
    allowed_mentions: { parse: [] }
  }, items, numbers);
}

function chunkItems(
  section: DigestSection | undefined,
  items: DigestItem[],
  numbers: Map<string, number>
): DigestItem[][] {
  const chunks: DigestItem[][] = [];
  let current: DigestItem[] = [];
  let length = 0;
  let chunkIndex = 0;
  for (const item of items) {
    const lineLength = formatLine(item, numbers.get(item.mailId)).length + 1;
    const tooManyButtons = current.length >= MAX_BUTTONS_PER_MESSAGE;
    const tooLong = current.length > 0 && length + lineLength > SECTION_DESCRIPTION_BUDGET;
    if (tooManyButtons || tooLong) {
      chunks.push(current);
      current = [];
      length = 0;
      chunkIndex += 1;
    }
    if (current.length === 0) {
      length += firstChunkLeadLength(section, chunkIndex);
    }
    current.push(item);
    length += lineLength;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function firstChunkLeadLength(section: DigestSection | undefined, chunkIndex: number): number {
  if (chunkIndex !== 0) return 0;
  const lead = section?.lead?.trim();
  if (!lead) return 0;
  return `_${escapeMarkdown(lead)}_`.length + 1;
}

function formatLine(item: DigestItem, displayNumber: number | undefined): string {
  const sender = displaySender(item.from);
  const subject = escapeMarkdown(briefSubject(item));
  const summary = escapeMarkdown(digestSummary(item));
  const prefix = displayNumber ? `${displayNumber}. ` : '';
  return `• **${prefix}${sender}** · ${subject}\n  ${summary} · [打开 Gmail](${item.gmailUrl})`;
}

function briefSubject(item: DigestItem): string {
  const raw = item.subject.replace(/\s+/g, ' ').trim();
  if (!raw) return '(no subject)';
  if (/[㐀-鿿]/.test(raw)) {
    const chars = Array.from(raw);
    return chars.length > 28 ? `${chars.slice(0, 28).join('')}…` : chars.join('');
  }
  return raw.length > 90 ? `${raw.slice(0, 88)}…` : raw;
}

function digestSummary(item: DigestItem): string {
  const raw = (item.summary || item.subject || '').replace(/\s+/g, ' ').trim();
  if (!raw || raw === '无摘要') return '无摘要';
  if (/[㐀-鿿]/.test(raw)) {
    const chars = Array.from(raw);
    return chars.length > 90 ? `${chars.slice(0, 90).join('')}…` : chars.join('');
  }
  return raw.length > 240 ? `${raw.slice(0, 238)}…` : raw;
}

function realtimeSummary(item: DigestItem): string {
  const summary = item.summary.replace(/\s+/g, ' ').trim();
  if (summary && summary !== '无摘要') {
    return summary.slice(0, 180);
  }
  return item.subject.replace(/\s+/g, ' ').trim().slice(0, 180) || '无摘要';
}

function pickColor(digest: DigestReport): number {
  if (digest.accounts.some((account) => account.error)) return 0xf59e0b;
  if (digest.counts.action > 0) return 0xdc2626;
  return 0x2563eb;
}

function errorEmbeds(digest: DigestReport) {
  const errors = digest.accounts.filter((account) => account.error);
  if (errors.length === 0) return [];
  return [{
    title: '账号失败',
    description: errors.map((account) => {
      const message = escapeMarkdown(account.error || '').slice(0, 200);
      return `**${escapeMarkdown(account.accountName)}** (${escapeMarkdown(account.accountEmail)})：${message}`;
    }).join('\n'),
    color: 0xf59e0b
  }];
}

function reportedItemNumbers(digest: DigestReport): Map<string, number> {
  const items: DigestItem[] = [];
  for (const category of REPORT_CATEGORIES) {
    const section = digest.sections.find((entry) => entry.category === category);
    for (const item of section?.items || []) {
      items.push(item);
    }
  }
  return new Map(items.map((item, index) => [item.mailId, index + 1]));
}

function actionRows(items: DigestItem[], numbers?: Map<string, number>) {
  const buttons = items.slice(0, MAX_BUTTONS_PER_MESSAGE).map((item, index) => ({
    type: 2,
    style: 2,
    label: `查看内容 ${numbers?.get(item.mailId) ?? index + 1}`,
    custom_id: `${PREVIEW_BUTTON_PREFIX}${item.mailId}`
  }));
  const rows = [];
  for (let index = 0; index < buttons.length; index += MAX_ACTION_ROWS) {
    rows.push({
      type: 1,
      components: buttons.slice(index, index + MAX_ACTION_ROWS)
    });
  }
  return rows;
}

function withActionRows<T extends Record<string, unknown>>(
  body: T,
  items: DigestItem[],
  numbers?: Map<string, number>
): T & { components?: unknown[] } {
  const rows = actionRows(items, numbers);
  if (rows.length === 0) return body;
  return {
    ...body,
    components: rows
  };
}

function sectionColor(category: Category): number {
  const colors: Partial<Record<Category, number>> = {
    action: 0xdc2626,
    fyi: 0x2563eb,
    course: 0x16a34a,
    admin: 0xf59e0b
  };
  return colors[category] || 0x6b7280;
}

function limitDescription(description: string): string {
  if (description.length <= DESCRIPTION_LIMIT) return description;
  return `${description.slice(0, DESCRIPTION_LIMIT - 40).trimEnd()}\n…正文已截断`;
}

function displaySender(from: string): string {
  const match = from.match(/^"?([^"<]+)"?\s*</);
  const name = (match?.[1] || from).replace(/\s+/g, ' ').trim();
  return escapeMarkdown(name.slice(0, 60));
}

function escapeMarkdown(text: string): string {
  return text.replace(/([\\*_`~|])/g, '\\$1');
}

import type { AppConfig, Category, DigestItem, DigestReport } from './types.js';

const DISCORD_API = 'https://discord.com/api/v10';
const REPORT_CATEGORIES: Category[] = ['action', 'fyi', 'course', 'admin'];
const SECTION_LABELS: Record<Category, string> = {
  action: 'Action 待处理',
  fyi: 'FYI 通知',
  course: 'Course 课程',
  admin: 'Admin 行政',
  junk: 'Junk 促销'
};
const SECTION_ITEM_LIMIT = 15;
const DESCRIPTION_LIMIT = 4000;

export async function sendDiscordDigest(config: AppConfig, digest: DigestReport): Promise<void> {
  await sendDiscordMessage(config, config.discord.digestChannelId, buildMessage(digest));
}

export async function sendDiscordRealtime(config: AppConfig, item: DigestItem): Promise<void> {
  await sendDiscordMessage(config, config.discord.realtimeChannelId, {
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
  });
}

async function sendDiscordMessage(config: AppConfig, channelId: string, body: unknown): Promise<void> {
  if (!channelId) {
    throw new Error('Discord channel id is required');
  }
  const url = `${DISCORD_API}/channels/${channelId}/messages`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${config.discord.botToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Discord message failed: ${response.status} ${errorBody}`);
  }
}

function buildMessage(digest: DigestReport) {
  return {
    content: null,
    embeds: [reportEmbed(digest), ...errorEmbeds(digest)],
    allowed_mentions: { parse: [] }
  };
}

function reportEmbed(digest: DigestReport) {
  return {
    title: `[Daily Digest] ${digest.date} — 共 ${digest.total} 封`,
    description: limitDescription(reportBody(digest)),
    color: pickColor(digest),
    footer: { text: digest.account },
    timestamp: new Date().toISOString()
  };
}

function reportBody(digest: DigestReport): string {
  if (digest.total === 0) {
    return '过去一个周期没有需要汇总的新邮件。';
  }
  const sections = REPORT_CATEGORIES
    .map((category) => sectionBlock(digest, category))
    .filter(Boolean);
  return [summaryLine(digest), '', sections.join('\n\n')].join('\n');
}

function summaryLine(digest: DigestReport): string {
  const c = digest.counts;
  return `今天 **${digest.total}** 封 · Action ${c.action} · FYI ${c.fyi} · Course ${c.course} · Admin ${c.admin} · Junk ${c.junk}`;
}

function sectionBlock(digest: DigestReport, category: Category): string {
  const section = digest.sections.find((entry) => entry.category === category);
  const items = section?.items || [];
  if (items.length === 0) return '';
  const header = `**${SECTION_LABELS[category]}（${items.length}）**`;
  const lead = section?.lead?.trim();
  const leadLine = lead ? [`_${escapeMarkdown(lead)}_`] : [];
  const lines = items.slice(0, SECTION_ITEM_LIMIT).map(formatLine);
  const overflow = items.length > SECTION_ITEM_LIMIT
    ? [`• 另有 ${items.length - SECTION_ITEM_LIMIT} 封同类未列出`]
    : [];
  return [header, ...leadLine, ...lines, ...overflow].join('\n');
}

function formatLine(item: DigestItem): string {
  const sender = displaySender(item.from);
  const summary = escapeMarkdown(briefSummary(item));
  return `• ${sender} — ${summary} — [查看](${item.gmailUrl})`;
}

function briefSummary(item: DigestItem): string {
  const raw = (item.summary || item.subject || '').replace(/\s+/g, ' ').trim();
  if (!raw || raw === '无摘要') return '无摘要';
  if (/[㐀-鿿]/.test(raw)) {
    const chars = Array.from(raw);
    return chars.length > 12 ? `${chars.slice(0, 12).join('')}…` : chars.join('');
  }
  const words = raw.split(/\s+/);
  if (words.length > 8) return `${words.slice(0, 8).join(' ')}…`;
  return raw.length > 60 ? `${raw.slice(0, 58)}…` : raw;
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

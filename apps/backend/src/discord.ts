import type { AppConfig, Category, DigestItem, DigestReport } from './types.js';

const DISCORD_API = 'https://discord.com/api/v10';

export async function sendDiscordDigest(config: AppConfig, digest: DigestReport): Promise<void> {
  const url = `${DISCORD_API}/channels/${config.discord.digestChannelId}/messages`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${config.discord.botToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(buildMessage(digest))
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord message failed: ${response.status} ${body}`);
  }
}

function buildMessage(digest: DigestReport) {
  return {
    content: null,
    embeds: [summaryEmbed(digest), accountEmbed(digest), ...reportEmbeds(digest)],
    allowed_mentions: { parse: [] }
  };
}

function summaryEmbed(digest: DigestReport) {
  return {
    title: `邮件日报 - ${digest.date}`,
    description: dailyBrief(digest),
    color: digest.accounts.some((account) => account.error) ? 0xf59e0b : digest.counts.action > 0 ? 0xdc2626 : 0x2563eb,
    footer: { text: digest.account },
    timestamp: new Date().toISOString()
  };
}

function accountEmbed(digest: DigestReport) {
  return {
    title: '账号状态',
    description: digest.accounts.map((account) => {
      const status = account.error ? `失败：${escapeMarkdown(account.error).slice(0, 180)}` : '正常';
      return [
        `**${escapeMarkdown(account.accountName)}** (${escapeMarkdown(account.accountEmail)})`,
        `共 ${account.total} 封`,
        `待处理 ${account.counts.action}`,
        `课程 ${account.counts.course}`,
        `行政 ${account.counts.admin}`,
        `通知 ${account.counts.fyi}`,
        `促销 ${account.counts.junk}`,
        status
      ].join(' · ');
    }).join('\n'),
    color: digest.accounts.some((account) => account.error) ? 0xf59e0b : 0x6b7280
  };
}

function reportEmbeds(digest: DigestReport) {
  const embeds = [];
  const action = sectionItems(digest, 'action');
  const course = sectionItems(digest, 'course');
  const admin = sectionItems(digest, 'admin');
  const fyi = sectionItems(digest, 'fyi');

  if (action.length > 0) {
    embeds.push({
      title: `需要处理 (${action.length})`,
      description: formatPriorityReport(action, '今天最需要你看的是'),
      color: sectionColor('action')
    });
  }

  const operations = [
    formatCategoryParagraph('课程相关', course, '课程邮件主要涉及'),
    formatCategoryParagraph('行政与账号', admin, '行政或系统邮件主要涉及'),
    formatCategoryParagraph('一般通知', fyi, '其余通知主要涉及')
  ].filter(Boolean);

  if (operations.length > 0) {
    embeds.push({
      title: '信息概览',
      description: limitDescription(operations.join('\n\n')),
      color: digest.counts.course > 0 ? sectionColor('course') : sectionColor('fyi')
    });
  }

  if (digest.counts.junk > 0 || digest.total === 0) {
    embeds.push({
      title: '低优先级',
      description: lowPriorityBrief(digest),
      color: sectionColor('junk')
    });
  }

  return embeds;
}

function dailyBrief(digest: DigestReport): string {
  if (digest.total === 0) {
    return '过去一个周期没有需要汇总的新邮件。';
  }

  const parts = [
    `本次共处理 **${digest.total}** 封邮件，覆盖 **${digest.accounts.length}** 个账号。`,
    digest.counts.action > 0
      ? `其中 **${digest.counts.action}** 封需要处理，建议优先查看。`
      : '没有明显需要立即回复或确认的邮件。',
    digest.counts.course > 0 || digest.counts.admin > 0
      ? `课程相关 **${digest.counts.course}** 封，行政/账号类 **${digest.counts.admin}** 封。`
      : '',
    digest.counts.junk > 0
      ? `促销或低价值邮件 **${digest.counts.junk}** 封，已折叠为计数。`
      : ''
  ].filter(Boolean);

  return parts.join('\n');
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

function sectionItems(digest: DigestReport, category: Category): DigestItem[] {
  return digest.sections.find((section) => section.category === category)?.items || [];
}

function formatPriorityReport(items: DigestItem[], lead: string): string {
  const lines = [`${lead}：`];
  for (const [index, item] of items.slice(0, 8).entries()) {
    lines.push(`${index + 1}. ${formatReportItem(item)}`);
  }
  if (items.length > 8) {
    lines.push(`另外还有 ${items.length - 8} 封同类邮件，已按重要度排在后面。`);
  }
  return limitDescription(lines.join('\n'));
}

function formatCategoryParagraph(title: string, items: DigestItem[], lead: string): string {
  if (items.length === 0) return '';

  const topItems = items.slice(0, 5).map((item) => {
    const sender = displaySender(item.from);
    return `${sender}：${escapeMarkdown(compactSummary(item))}`;
  });
  const remainder = items.length > topItems.length ? `另有 ${items.length - topItems.length} 封未展开。` : '';
  return [
    `**${title}（${items.length}）**`,
    `${lead} ${topItems.join('；')}。${remainder}`
  ].filter(Boolean).join('\n');
}

function lowPriorityBrief(digest: DigestReport): string {
  if (digest.total === 0) {
    return '没有新邮件需要处理。';
  }
  if (digest.counts.junk === 0) {
    return '本次没有识别出促销或低价值邮件。';
  }
  return `促销、订阅或低价值邮件共 **${digest.counts.junk}** 封，仅保留计数，不在日报正文逐条展开。`;
}

function formatReportItem(item: DigestItem): string {
  const sender = displaySender(item.from);
  const account = escapeMarkdown(item.accountName);
  const summary = escapeMarkdown(compactSummary(item));
  return `**${account} / ${sender}**：${summary} [打开](${item.gmailUrl})`;
}

function compactSummary(item: DigestItem): string {
  const summary = item.summary.replace(/\s+/g, ' ').trim();
  if (summary && summary !== '无摘要') {
    return summary.slice(0, 180);
  }
  return item.subject.replace(/\s+/g, ' ').trim().slice(0, 180) || '无摘要';
}

function limitDescription(description: string): string {
  if (description.length <= 3900) return description;
  return `${description.slice(0, 3860).trimEnd()}\n...正文已截断`;
}

function displaySender(from: string): string {
  const match = from.match(/^"?([^"<]+)"?\s*</);
  const name = (match?.[1] || from).replace(/\s+/g, ' ').trim();
  return escapeMarkdown(name.slice(0, 60));
}

function escapeMarkdown(text: string): string {
  return text.replace(/([\\*_`~|])/g, '\\$1');
}

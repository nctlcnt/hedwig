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
  const summaryLines = [
    `Total: **${digest.total}**`,
    `Action: **${digest.counts.action}**`,
    `FYI: **${digest.counts.fyi}**`,
    `Course: **${digest.counts.course}**`,
    `Admin: **${digest.counts.admin}**`,
    `Junk: **${digest.counts.junk}**`,
    `Accounts: **${digest.accounts.length}**`
  ];

  return {
    content: null,
    embeds: [summaryEmbed(digest, summaryLines), accountEmbed(digest), ...sectionEmbeds(digest)],
    allowed_mentions: { parse: [] }
  };
}

function summaryEmbed(digest: DigestReport, summaryLines: string[]) {
  return {
    title: `Daily Gmail Digest - ${digest.date}`,
    description: summaryLines.join('  |  '),
    color: digest.accounts.some((account) => account.error) ? 0xf59e0b : digest.counts.action > 0 ? 0xdc2626 : 0x2563eb,
    footer: { text: digest.account },
    timestamp: new Date().toISOString()
  };
}

function accountEmbed(digest: DigestReport) {
  return {
    title: 'Accounts',
    description: digest.accounts.map((account) => {
      const status = account.error ? `failed: ${escapeMarkdown(account.error).slice(0, 180)}` : 'ok';
      return [
        `**${escapeMarkdown(account.accountName)}** (${escapeMarkdown(account.accountEmail)})`,
        `total ${account.total}`,
        `action ${account.counts.action}`,
        `fyi ${account.counts.fyi}`,
        `course ${account.counts.course}`,
        `admin ${account.counts.admin}`,
        `junk ${account.counts.junk}`,
        status
      ].join(' · ');
    }).join('\n'),
    color: digest.accounts.some((account) => account.error) ? 0xf59e0b : 0x6b7280
  };
}

function sectionEmbeds(digest: DigestReport) {
  return digest.sections
    .filter((section) => section.category !== 'junk')
    .filter((section) => section.items.length > 0)
    .map((section) => ({
      title: `${sectionTitle(section.category, section.title)} (${section.items.length})`,
      description: formatSectionItems(section.items),
      color: sectionColor(section.category)
    }));
}

function sectionTitle(category: Category, title: string): string {
  const names: Partial<Record<Category, string>> = {
    action: 'Action Required',
    fyi: 'FYI',
    course: 'Course',
    admin: 'Admin'
  };
  return names[category] || title;
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

function formatSectionItems(items: DigestItem[]): string {
  const lines = [];
  for (const [index, item] of items.entries()) {
    const next = `${index + 1}. ${formatItem(item)}`;
    if (lines.join('\n').length + next.length > 3900) {
      lines.push(`...and ${items.length - index} more`);
      break;
    }
    lines.push(next);
  }
  return lines.join('\n');
}

function formatItem(item: DigestItem): string {
  const sender = displaySender(item.from);
  const subject = item.subject.replace(/\s+/g, ' ').trim();
  const summary = item.summary.replace(/\s+/g, ' ').trim();
  return `**${escapeMarkdown(item.accountName)} / ${sender}** - ${escapeMarkdown(summary)}\n   [View in Gmail](${item.gmailUrl}) · ${escapeMarkdown(subject).slice(0, 120)}`;
}

function displaySender(from: string): string {
  const match = from.match(/^"?([^"<]+)"?\s*</);
  const name = (match?.[1] || from).replace(/\s+/g, ' ').trim();
  return escapeMarkdown(name.slice(0, 60));
}

function escapeMarkdown(text: string): string {
  return text.replace(/([\\*_`~|])/g, '\\$1');
}

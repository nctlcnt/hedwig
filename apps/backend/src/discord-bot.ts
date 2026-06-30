import { Client, EmbedBuilder, GatewayIntentBits, type InteractionReplyOptions } from 'discord.js';
import { getCachedEmailPreview, type HedwigDb } from './db.js';
import type { AppConfig, CachedEmailPreview } from './types.js';

const PREVIEW_BUTTON_PREFIX = 'email_preview:';

export function startDiscordBot(config: AppConfig, db: HedwigDb): Client {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds]
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith(PREVIEW_BUTTON_PREFIX)) return;

    const mailId = interaction.customId.slice(PREVIEW_BUTTON_PREFIX.length);
    await interaction.reply(previewReply(db, mailId));
  });

  client.once('clientReady', () => {
    console.log(`Discord bot interaction listener ready as ${client.user?.tag || client.user?.id || 'unknown user'}`);
  });

  client.login(config.discord.botToken).catch((error) => {
    console.error('Discord bot login failed', error);
  });

  return client;
}

function previewReply(db: HedwigDb, mailId: string): InteractionReplyOptions {
  const preview = getCachedEmailPreview(db, mailId);
  if (!preview) {
    return {
      ephemeral: true,
      content: `这封邮件的本地正文缓存已经过期或不存在。\nmail_id: \`${escapeMarkdown(mailId)}\``
    };
  }

  return {
    ephemeral: true,
    embeds: [previewEmbed(preview)]
  };
}

function previewEmbed(preview: CachedEmailPreview): EmbedBuilder {
  const description = [
    preview.summary ? `**摘要**\n${escapeMarkdown(preview.summary)}` : '',
    `**正文预览**\n${escapeMarkdown(bodyPreview(preview.bodyText))}`,
    linkBlock(preview),
    `[打开 Gmail](${preview.gmailUrl})`
  ].filter(Boolean).join('\n\n');

  return new EmbedBuilder()
    .setTitle(truncate(preview.subject || '(no subject)', 256))
    .setDescription(truncate(description, 4000))
    .setColor(0x2563eb)
    .setFooter({ text: `mail_id ${preview.mailId} · cache expires ${preview.expiresAt}` });
}

function bodyPreview(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '无正文预览';
  return truncate(normalized, 1200);
}

function linkBlock(preview: CachedEmailPreview): string {
  if (preview.links.length === 0) return '';
  const lines = preview.links.slice(0, 5).map((link, index) => {
    const label = truncate(link.label || fallbackLinkLabel(link.url), 80);
    return `${index + 1}. [${escapeMarkdown(label)}](${link.url})`;
  });
  return `**可能有用的链接**\n${lines.join('\n')}`;
}

function fallbackLinkLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const domain = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const path = parsed.pathname
      .split('/')
      .filter(Boolean)
      .slice(0, 2)
      .join('/');
    return path ? `打开 ${domain}/${path}` : `打开 ${domain}`;
  } catch {
    return url;
  }
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

function escapeMarkdown(text: string): string {
  return text.replace(/([\\*_`~|])/g, '\\$1');
}

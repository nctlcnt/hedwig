import {
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type InteractionReplyOptions
} from 'discord.js';
import { getCachedEmailPreview, setSummaryLanguage, type HedwigDb } from './db.js';
import { validateFollowupForumChannel } from './followup-config.js';
import { MAX_SUMMARY_LANGUAGE_LENGTH, normalizeSummaryLanguage } from './summary-language.js';
import type { AppConfig, CachedEmailPreview } from './types.js';

const PREVIEW_BUTTON_PREFIX = 'email_preview:';
const SUMMARY_LANGUAGE_COMMAND = 'summary-language';
const SUMMARY_LANGUAGE_OPTION = 'language';
const summaryLanguageCommand = new SlashCommandBuilder()
  .setName(SUMMARY_LANGUAGE_COMMAND)
  .setDescription('设置之后生成的邮件摘要语言')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption((option) => (
    option
      .setName(SUMMARY_LANGUAGE_OPTION)
      .setDescription('例如：中文、English、日本語')
      .setRequired(true)
      .setMaxLength(MAX_SUMMARY_LANGUAGE_LENGTH)
  ));

export async function startDiscordBot(config: AppConfig, db: HedwigDb): Promise<Client<true>> {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds]
  });

  client.on('interactionCreate', async (interaction) => {
    if (interaction.isChatInputCommand() && interaction.commandName === SUMMARY_LANGUAGE_COMMAND) {
      await handleSummaryLanguageCommand(interaction, db);
      return;
    }
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith(PREVIEW_BUTTON_PREFIX)) return;

    const mailId = interaction.customId.slice(PREVIEW_BUTTON_PREFIX.length);
    await interaction.reply(previewReply(db, mailId));
  });

  const ready = new Promise<Client<true>>((resolve) => {
    client.once('clientReady', resolve);
  });

  try {
    await client.login(config.discord.botToken);
    const readyClient = await ready;
    await validateFollowupForumChannel(
      config.followup,
      async (channelId) => {
        const channel = await readyClient.channels.fetch(channelId);
        return channel ? { type: channel.type } : null;
      }
    );
    if (config.followup.enabled) {
      console.log(`Validated Discord follow-up Forum channel ${config.followup.forumChannelId}`);
    } else {
      console.log('Follow-up feature disabled; skipped Discord Forum channel validation');
    }

    console.log(
      `Discord bot interaction listener ready as ${client.user?.tag || client.user?.id || 'unknown user'}`
    );
    try {
      await registerSummaryLanguageCommand(readyClient);
    } catch (error) {
      console.error('Failed to register summary-language command', error);
    }
    return readyClient;
  } catch (error) {
    client.destroy();
    throw error;
  }
}

async function registerSummaryLanguageCommand(client: Client<true>): Promise<void> {
  let registered = 0;
  for (const guild of client.guilds.cache.values()) {
    const commands = await guild.commands.fetch();
    const existing = commands.find((command) => command.name === SUMMARY_LANGUAGE_COMMAND);
    if (existing) {
      await guild.commands.edit(existing, summaryLanguageCommand);
    } else {
      await guild.commands.create(summaryLanguageCommand);
    }
    registered += 1;
  }
  console.log(`Registered /${SUMMARY_LANGUAGE_COMMAND} in ${registered} Discord guild(s)`);
}

async function handleSummaryLanguageCommand(
  interaction: ChatInputCommandInteraction,
  db: HedwigDb
): Promise<void> {
  try {
    const input = interaction.options.getString(SUMMARY_LANGUAGE_OPTION, true);
    const language = normalizeSummaryLanguage(input);
    setSummaryLanguage(db, language);
    await interaction.reply({
      ephemeral: true,
      content: `之后的新邮件摘要和每日概览会使用：**${escapeMarkdown(language)}**。\n已有历史摘要不会重写。`
    });
  } catch (error) {
    await interaction.reply({
      ephemeral: true,
      content: error instanceof Error ? error.message : '无法保存摘要语言'
    });
  }
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
    preview.summary ? `**一句话摘要**\n${escapeMarkdown(preview.summary)}` : '',
    detailList('注意点', preview.attentionPoints),
    detailList('建议操作', preview.suggestedActions),
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

function detailList(title: string, items: string[]): string {
  if (items.length === 0) return '';
  return `**${title}**\n${items.map((item) => `• ${escapeMarkdown(item)}`).join('\n')}`;
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

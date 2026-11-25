import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type InteractionReplyOptions
} from 'discord.js';
import { getCachedEmailPreview, setSummaryLanguage, type HedwigDb } from './db.js';
import { validateFollowupForumChannel } from './followup-config.js';
import {
  openFollowup,
  type FollowupForumDraft,
  type OpenFollowupResult
} from './followup-service.js';
import type { FollowupKind } from './followup-store.js';
import { MAX_SUMMARY_LANGUAGE_LENGTH, normalizeSummaryLanguage } from './summary-language.js';
import type { DiscordAppConfig, CachedEmailPreview } from './types.js';

const PREVIEW_BUTTON_PREFIX = 'email_preview:';
const FOLLOWUP_BUTTON_PREFIX = 'followup:create:';
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

export async function startDiscordBot(config: DiscordAppConfig, db: HedwigDb): Promise<Client<true>> {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds]
  });

  client.on('interactionCreate', async (interaction) => {
    if (interaction.isChatInputCommand() && interaction.commandName === SUMMARY_LANGUAGE_COMMAND) {
      await handleSummaryLanguageCommand(interaction, db);
      return;
    }
    if (!interaction.isButton()) return;
    if (interaction.customId.startsWith(PREVIEW_BUTTON_PREFIX)) {
      const mailId = interaction.customId.slice(PREVIEW_BUTTON_PREFIX.length);
      await interaction.reply(previewReply(config, db, mailId));
      return;
    }
    if (interaction.customId.startsWith(FOLLOWUP_BUTTON_PREFIX)) {
      await handleFollowupCreate(interaction, config, db);
    }
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

function previewReply(config: DiscordAppConfig, db: HedwigDb, mailId: string): InteractionReplyOptions {
  const preview = getCachedEmailPreview(db, mailId);
  if (!preview) {
    return {
      ephemeral: true,
      content: `这封邮件的本地正文缓存已经过期或不存在。\nmail_id: \`${escapeMarkdown(mailId)}\``
    };
  }

  return {
    ephemeral: true,
    embeds: [previewEmbed(preview)],
    components: config.followup.enabled ? followupTypeRows(mailId) : []
  };
}

async function handleFollowupCreate(
  interaction: ButtonInteraction,
  config: DiscordAppConfig,
  db: HedwigDb
): Promise<void> {
  if (!config.followup.enabled) {
    await interaction.reply({
      ephemeral: true,
      content: 'Follow-up is currently disabled.'
    });
    return;
  }

  const parsed = parseFollowupButton(interaction.customId);
  if (!parsed) {
    await interaction.reply({
      ephemeral: true,
      content: 'This follow-up action is invalid.'
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    const result = await openFollowup(
      db,
      parsed.source,
      parsed.kind,
      (draft) => publishFollowupForumPost(interaction, config, draft)
    );
    await interaction.editReply(followupResultMessage(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await interaction.editReply(`Could not create follow-up: ${message.slice(0, 1000)}`);
  }
}

function followupTypeRows(mailId: string): ActionRowBuilder<ButtonBuilder>[] {
  const buttons: Array<{ kind: FollowupKind; label: string; style: ButtonStyle }> = [
    { kind: 'conversation', label: 'Follow up', style: ButtonStyle.Primary },
    { kind: 'todo', label: 'Add todo', style: ButtonStyle.Secondary },
    { kind: 'read_later', label: 'Read it later', style: ButtonStyle.Secondary }
  ];
  const customIds = buttons.map((button) => `${FOLLOWUP_BUTTON_PREFIX}${button.kind}:${mailId}`);
  if (customIds.some((customId) => customId.length > 100)) return [];

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      buttons.map((button, index) => (
        new ButtonBuilder()
          .setCustomId(customIds[index] || '')
          .setLabel(button.label)
          .setStyle(button.style)
      ))
    )
  ];
}

function parseFollowupButton(customId: string): {
  kind: FollowupKind;
  source: { accountId: string; gmailId: string };
} | null {
  if (!customId.startsWith(FOLLOWUP_BUTTON_PREFIX)) return null;
  const payload = customId.slice(FOLLOWUP_BUTTON_PREFIX.length);
  const kindSeparator = payload.indexOf(':');
  if (kindSeparator <= 0) return null;
  const kind = payload.slice(0, kindSeparator);
  if (kind !== 'conversation' && kind !== 'todo' && kind !== 'read_later') return null;

  const mailId = payload.slice(kindSeparator + 1);
  const accountSeparator = mailId.indexOf(':');
  if (accountSeparator <= 0 || accountSeparator === mailId.length - 1) return null;
  return {
    kind,
    source: {
      accountId: mailId.slice(0, accountSeparator),
      gmailId: mailId.slice(accountSeparator + 1)
    }
  };
}

async function publishFollowupForumPost(
  interaction: ButtonInteraction,
  config: DiscordAppConfig,
  draft: FollowupForumDraft
): Promise<{ forumChannelId: string; threadId: string; messageId: string }> {
  const channel = await interaction.client.channels.fetch(config.followup.forumChannelId);
  if (!channel || channel.type !== ChannelType.GuildForum) {
    throw new Error('Configured follow-up channel is not an accessible Forum');
  }

  const thread = await channel.threads.create({
    name: followupThreadName(draft),
    message: {
      embeds: [followupForumEmbed(draft)],
      allowedMentions: { parse: [] }
    },
    reason: `Hedwig follow-up ${draft.followup.id}`
  });
  return {
    forumChannelId: channel.id,
    threadId: thread.id,
    // A Forum post's starter message shares the thread id.
    messageId: thread.id
  };
}

function followupThreadName(draft: FollowupForumDraft): string {
  const prefix: Record<FollowupKind, string> = {
    conversation: 'Follow up',
    todo: 'Todo',
    read_later: 'Read it later'
  };
  return `[${prefix[draft.followup.kind]}] ${draft.followup.title}`
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

function followupForumEmbed(draft: FollowupForumDraft): EmbedBuilder {
  const source = draft.source;
  const description = [
    `**Type**\n${followupKindLabel(draft.followup.kind)}`,
    source.summary ? `**Current summary**\n${escapeMarkdown(source.summary)}` : '',
    detailList('Attention', source.attentionPoints),
    detailList('Suggested actions', source.suggestedActions),
    followupLinkBlock(source.links),
    `[Open in Gmail](${source.gmailUrl})`
  ].filter(Boolean).join('\n\n');

  return new EmbedBuilder()
    .setTitle(truncate(draft.followup.title || '(no subject)', 256))
    .setDescription(truncate(description, 4000))
    .setColor(followupColor(draft.followup.kind))
    .setFooter({
      text: `followup ${draft.followup.id} · ${draft.followup.accountId}:${draft.followup.gmailThreadId}`
    });
}

function followupLinkBlock(links: Array<{ url: string; label?: string }>): string {
  if (links.length === 0) return '';
  return `**Useful links**\n${links.slice(0, 5).map((link, index) => (
    `${index + 1}. [${escapeMarkdown(followupLinkLabel(link.url))}](${link.url})`
  )).join('\n')}`;
}

function followupLinkLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const domain = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const path = parsed.pathname
      .split('/')
      .filter(Boolean)
      .slice(0, 2)
      .join('/');
    return path ? `Open ${domain}/${path}` : `Open ${domain}`;
  } catch {
    return url;
  }
}

function followupColor(kind: FollowupKind): number {
  if (kind === 'conversation') return 0x7c3aed;
  if (kind === 'todo') return 0xdc2626;
  return 0x2563eb;
}

function followupKindLabel(kind: FollowupKind): string {
  if (kind === 'conversation') return 'Conversation';
  if (kind === 'todo') return 'Todo';
  return 'Read it later';
}

function followupResultMessage(result: OpenFollowupResult): string {
  if (result.outcome === 'pending') {
    return `This email thread's follow-up is being created.\nfollowup: \`${result.followup.id}\``;
  }
  const thread = result.followup.discordThreadId
    ? `<#${result.followup.discordThreadId}>`
    : `followup \`${result.followup.id}\``;
  if (result.outcome === 'existing') {
    const state = result.followup.state === 'closed' ? 'is already complete' : 'already exists';
    return `This email thread's follow-up ${state}: ${thread}`;
  }
  return `Created ${followupKindLabel(result.followup.kind)}: ${thread}`;
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

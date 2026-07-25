import { ChannelType } from 'discord.js';
import type { FollowupConfig } from './types.js';

export type FollowupChannel = {
  type: number;
};

export type FollowupChannelFetcher = (
  channelId: string
) => Promise<FollowupChannel | null>;

export async function validateFollowupForumChannel(
  config: FollowupConfig,
  fetchChannel: FollowupChannelFetcher
): Promise<void> {
  if (!config.enabled) return;
  if (!config.forumChannelId.trim()) {
    throw new Error(
      'DISCORD_FOLLOWUP_FORUM_CHANNEL_ID is required when FOLLOWUP_ENABLED=true'
    );
  }

  let channel: FollowupChannel | null;
  try {
    channel = await fetchChannel(config.forumChannelId);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : '';
    throw new Error(
      `Unable to access Discord follow-up channel ${config.forumChannelId}${detail}`,
      { cause: error }
    );
  }

  if (!channel) {
    throw new Error(`Discord follow-up channel ${config.forumChannelId} was not found`);
  }
  if (channel.type !== ChannelType.GuildForum) {
    throw new Error(
      `Discord follow-up channel ${config.forumChannelId} must be a Forum channel`
    );
  }
}

import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { loadFollowupConfig } from './config.js';
import { validateFollowupForumChannel } from './followup-config.js';

assert.deepEqual(loadFollowupConfig({}), {
  enabled: false,
  forumChannelId: ''
});
assert.deepEqual(loadFollowupConfig({
  FOLLOWUP_ENABLED: 'false',
  DISCORD_FOLLOWUP_FORUM_CHANNEL_ID: 'not-validated-while-disabled'
}), {
  enabled: false,
  forumChannelId: ''
});
assert.throws(
  () => loadFollowupConfig({ FOLLOWUP_ENABLED: 'yes' }),
  /FOLLOWUP_ENABLED must be "true" or "false"/
);
assert.throws(
  () => loadFollowupConfig({ FOLLOWUP_ENABLED: 'true' }),
  /DISCORD_FOLLOWUP_FORUM_CHANNEL_ID/
);
assert.deepEqual(loadFollowupConfig({
  FOLLOWUP_ENABLED: ' TRUE ',
  DISCORD_FOLLOWUP_FORUM_CHANNEL_ID: ' 123456789012345678 '
}), {
  enabled: true,
  forumChannelId: '123456789012345678'
});

let disabledFetchCount = 0;
await validateFollowupForumChannel(
  { enabled: false, forumChannelId: '' },
  async () => {
    disabledFetchCount += 1;
    return null;
  }
);
assert.equal(disabledFetchCount, 0);

await validateFollowupForumChannel(
  { enabled: true, forumChannelId: 'forum-channel' },
  async (channelId) => {
    assert.equal(channelId, 'forum-channel');
    return { type: ChannelType.GuildForum };
  }
);

await assert.rejects(
  validateFollowupForumChannel(
    { enabled: true, forumChannelId: '' },
    async () => ({ type: ChannelType.GuildForum })
  ),
  /DISCORD_FOLLOWUP_FORUM_CHANNEL_ID is required/
);
await assert.rejects(
  validateFollowupForumChannel(
    { enabled: true, forumChannelId: 'missing-channel' },
    async () => null
  ),
  /was not found/
);
await assert.rejects(
  validateFollowupForumChannel(
    { enabled: true, forumChannelId: 'text-channel' },
    async () => ({ type: ChannelType.GuildText })
  ),
  /must be a Forum channel/
);
await assert.rejects(
  validateFollowupForumChannel(
    { enabled: true, forumChannelId: 'forbidden-channel' },
    async () => {
      throw new Error('Missing Access');
    }
  ),
  /Unable to access Discord follow-up channel forbidden-channel: Missing Access/
);

console.log('followup-config.test.ts: all assertions passed');

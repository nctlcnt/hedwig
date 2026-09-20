import type { Database } from 'better-sqlite3';
import {
  attachFollowupDiscordThread,
  claimFailedFollowupRetry,
  listFollowupMessages,
  recordFollowupFailure,
  reserveFollowup,
  type FollowupKind,
  type FollowupMessage,
  type FollowupRecord
} from './followup-store.js';

export type FollowupForumDraft = {
  followup: FollowupRecord;
  source: FollowupMessage;
};

export type FollowupForumPublisher = (
  draft: FollowupForumDraft
) => Promise<{
  forumChannelId: string;
  threadId: string;
  messageId: string;
}>;

export type OpenFollowupResult = {
  followup: FollowupRecord;
  outcome: 'created' | 'existing' | 'pending';
};

export async function openFollowup(
  db: Database,
  source: { accountId: string; gmailId: string },
  kind: FollowupKind,
  publishForumPost: FollowupForumPublisher,
  now: Date = new Date()
): Promise<OpenFollowupResult> {
  const reservation = reserveFollowup(db, source.accountId, source.gmailId, kind, now);
  if (!reservation) {
    throw new Error('The stored email is unavailable and cannot be tracked');
  }

  let followup = reservation.followup;
  if (!reservation.created) {
    if (followup.state === 'failed') {
      const claimed = claimFailedFollowupRetry(db, followup.id, now);
      if (!claimed) {
        return { followup, outcome: 'pending' };
      }
      followup = { ...followup, state: 'opening', lastError: null };
    } else if (followup.state === 'opening') {
      return { followup, outcome: 'pending' };
    } else {
      return { followup, outcome: 'existing' };
    }
  }

  const messages = listFollowupMessages(db, followup.id);
  const sourceMessage = messages.find((message) => message.gmailId === followup.sourceGmailId);
  if (!sourceMessage) {
    const error = new Error(`Follow-up ${followup.id} has no source message snapshot`);
    recordFollowupFailure(db, followup.id, error, now);
    throw error;
  }

  try {
    const discord = await publishForumPost({ followup, source: sourceMessage });
    const opened = attachFollowupDiscordThread(db, followup.id, discord, now);
    return { followup: opened, outcome: 'created' };
  } catch (error) {
    recordFollowupFailure(db, followup.id, error, now);
    throw error;
  }
}

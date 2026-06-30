import { shouldSendAlert } from './db.js';
import { sendDiscordDebug } from './discord.js';
import type { HedwigDb } from './db.js';
import type { AppConfig } from './types.js';

export type Problem = {
  // Stable identity used for dedup. The same signature is silenced for the
  // cooldown window after it fires; a different signature alerts immediately.
  signature: string;
  title: string;
  detail: string;
};

// Routes an operational problem to the Discord debug channel, deduped by
// signature over config.discord.debugCooldownMs. This function never throws and
// never re-reports its own failures, so alerting can neither break nor recurse
// into the pipeline it observes. A no-op when no debug channel is configured.
export async function reportProblem(config: AppConfig, db: HedwigDb, problem: Problem): Promise<void> {
  try {
    if (!config.discord.debugChannelId) return;
    if (!shouldSendAlert(db, problem.signature, config.discord.debugCooldownMs)) return;
    await sendDiscordDebug(config, problem.title, problem.detail);
  } catch (error) {
    console.error('Failed to report problem to debug channel', error);
  }
}

export function problemMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

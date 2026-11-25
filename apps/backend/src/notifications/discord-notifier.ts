import { planDiscordDigest, planDiscordRealtime, sendDiscordAlert, sendDiscordDelivery } from '../discord.js';
import type { DiscordAppConfig } from '../types.js';
import type { Notifier } from './notifier.js';

export function createDiscordNotifier(config: DiscordAppConfig): Notifier {
  return {
    platform: 'discord',
    digestDestination: config.discord.digestChannelId,
    realtimeDestination: config.discord.realtimeChannelId || null,
    alertCooldownMs: config.discord.debugChannelId ? config.discord.debugCooldownMs : null,
    planDigest: planDiscordDigest,
    planRealtime: planDiscordRealtime,
    deliver: (request) => sendDiscordDelivery(config, request),
    sendOperationalAlert: (alert) => sendDiscordAlert(config, alert)
  };
}

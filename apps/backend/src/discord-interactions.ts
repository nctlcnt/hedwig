import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { webcrypto } from 'node:crypto';
import { getCachedEmailPreview, type HedwigDb } from './db.js';
import type { AppConfig, CachedEmailPreview } from './types.js';

const PREVIEW_BUTTON_PREFIX = 'email_preview:';
const EPHEMERAL_FLAG = 1 << 6;

type DiscordInteraction = {
  type?: number;
  data?: {
    custom_id?: string;
  };
};

export function startDiscordInteractionServer(config: AppConfig, db: HedwigDb): Server | null {
  if (!config.discord.publicKey) {
    console.info('Skipping Discord interactions: DISCORD_PUBLIC_KEY is not set');
    return null;
  }

  const server = createServer((request, response) => {
    handleInteractionRequest(config, db, request, response).catch((error) => {
      console.error(error);
      sendJson(response, 500, {
        type: 4,
        data: {
          flags: EPHEMERAL_FLAG,
          content: 'Hedwig 处理这个按钮时出错了。'
        }
      });
    });
  });

  server.listen(config.discord.interactionsPort, () => {
    console.log(`Listening for Discord interactions on :${config.discord.interactionsPort}`);
  });

  return server;
}

async function handleInteractionRequest(
  config: AppConfig,
  db: HedwigDb,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'method not allowed' });
    return;
  }

  const body = await readBody(request);
  const valid = await verifyDiscordRequest(config, request, body);
  if (!valid) {
    sendJson(response, 401, { error: 'invalid request signature' });
    return;
  }

  const interaction = JSON.parse(body.toString('utf8')) as DiscordInteraction;
  if (interaction.type === 1) {
    sendJson(response, 200, { type: 1 });
    return;
  }

  const customId = interaction.data?.custom_id || '';
  if (customId.startsWith(PREVIEW_BUTTON_PREFIX)) {
    const mailId = customId.slice(PREVIEW_BUTTON_PREFIX.length);
    sendJson(response, 200, previewResponse(db, mailId));
    return;
  }

  sendJson(response, 200, {
    type: 4,
    data: {
      flags: EPHEMERAL_FLAG,
      content: 'Hedwig 不认识这个操作。'
    }
  });
}

function previewResponse(db: HedwigDb, mailId: string) {
  const preview = getCachedEmailPreview(db, mailId);
  if (!preview) {
    return {
      type: 4,
      data: {
        flags: EPHEMERAL_FLAG,
        content: `这封邮件的本地正文缓存已经过期或不存在。\nmail_id: \`${escapeMarkdown(mailId)}\``
      }
    };
  }

  return {
    type: 4,
    data: {
      flags: EPHEMERAL_FLAG,
      embeds: [previewEmbed(preview)]
    }
  };
}

function previewEmbed(preview: CachedEmailPreview) {
  return {
    title: truncate(preview.subject || '(no subject)', 256),
    description: truncate([
      preview.summary ? `**摘要**\n${escapeMarkdown(preview.summary)}` : '',
      `**正文预览**\n${escapeMarkdown(bodyPreview(preview.bodyText))}`,
      linkBlock(preview),
      `[打开 Gmail](${preview.gmailUrl})`
    ].filter(Boolean).join('\n\n'), 4000),
    color: 0x2563eb,
    footer: {
      text: `mail_id ${preview.mailId} · cache expires ${preview.expiresAt}`
    }
  };
}

function bodyPreview(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '无正文预览';
  return truncate(normalized, 1200);
}

function linkBlock(preview: CachedEmailPreview): string {
  if (preview.links.length === 0) return '';
  const lines = preview.links.slice(0, 8).map((link, index) => {
    const label = truncate(link.url, 80);
    return `${index + 1}. [${escapeMarkdown(label)}](${link.url})`;
  });
  return `**重要链接**\n${lines.join('\n')}`;
}

async function verifyDiscordRequest(
  config: AppConfig,
  request: IncomingMessage,
  body: Buffer
): Promise<boolean> {
  const signature = request.headers['x-signature-ed25519'];
  const timestamp = request.headers['x-signature-timestamp'];
  if (typeof signature !== 'string' || typeof timestamp !== 'string') return false;

  const publicKey = await webcrypto.subtle.importKey(
    'raw',
    Buffer.from(config.discord.publicKey, 'hex'),
    { name: 'Ed25519' },
    false,
    ['verify']
  );
  return webcrypto.subtle.verify(
    'Ed25519',
    publicKey,
    Buffer.from(signature, 'hex'),
    Buffer.concat([Buffer.from(timestamp), body])
  );
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

function escapeMarkdown(text: string): string {
  return text.replace(/([\\*_`~|])/g, '\\$1');
}

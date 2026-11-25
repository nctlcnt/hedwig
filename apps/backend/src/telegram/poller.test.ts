import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { Agent } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { GrammyError } from 'grammy';
import type { Chat, InlineKeyboardMarkup, Message, Update, UserFromGetMe } from 'grammy/types';
import { DateTime, Settings } from 'luxon';
import { createDigestRun, getSummaryLanguage, openDatabase, saveClassification, saveEmailBodyCache, saveMessage, setSyncCursor } from '../db.js';
import { queueTodayDigest } from '../digest.js';
import { DeliveryError } from '../notifications/notifier.js';
import { enqueueNotification } from '../notifications/outbox-store.js';
import { createOutboxDrain } from '../notifications/outbox-worker.js';
import { createTelegramNotifier } from '../notifications/telegram-notifier.js';
import type { DigestItem, EmailMessage, AppConfig } from '../types.js';
import { createTelegramApi, telegramRequest, validateTelegramDebugChat, type TelegramApi } from './api.js';
import { startTelegramPolling } from './poller.js';
import { isTelegramChatReady, telegramOffset } from './store.js';

const directory = mkdtempSync(join(tmpdir(), 'hedwig-telegram-'));
const config = {
  database: { path: join(directory, 'test.db') },
  digest: { timezone: 'Australia/Sydney' },
  google: { accounts: [
    { id: 'primary', displayName: '个人', refreshToken: 'synthetic' },
    { id: 'study', displayName: '学校', refreshToken: 'synthetic' }
  ] },
  telegram: { botToken: '123:synthetic', ownerUserId: 400, chatId: 500, debugChatId: -800, debugCooldownMs: 60_000 }
} as AppConfig;
const bot: UserFromGetMe = { id: 123, username: 'hedwig_test_bot', first_name: 'Hedwig', is_bot: true,
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false,
  can_manage_bots: false, supports_join_request_queries: false };
const options = {
  botUsername: bot.username, botId: bot.id, ownerUserId: 400, chatId: 500,
  timezone: config.digest.timezone, accounts: config.google.accounts,
  wakeOutbox() {
    assert.equal(db.inTransaction, false);
    outboxWakes += 1;
    commandDelivery = drainOutbox();
  }
};
const privateChat: Chat.PrivateChat = { id: 500, type: 'private', first_name: 'Owner' };
const group: Chat.GroupChat = { id: -800, type: 'group', title: 'Test private group' };
const owner = { id: 400, is_bot: false, first_name: 'Owner', username: 'owner' };
const otherUser = { ...owner, id: 401 };
const item: DigestItem = {
  accountId: 'primary', accountName: 'Test account', mailId: 'primary:private-mail-id', id: 'private-mail-id',
  category: 'action', from: 'Test sender', subject: 'Private synthetic subject', summary: 'Private synthetic summary',
  attentionPoints: ['Due Friday'], suggestedActions: ['Check the portal'], importance: 90, confidence: 1, provider: 'rule', processingOutcome: 'push_now',
  gmailUrl: 'https://mail.google.com/mail/#all/test-thread'
};

const offsets: (number | undefined)[] = [];
const replies: { id: string; text?: string }[] = [];
const sent: { chatId: number; text: string; options: Parameters<TelegramApi['sendMessage']>[2] }[] = [];
const edits: { chatId: number; messageId: number; text: string; options: Parameters<TelegramApi['editMessageText']>[3] }[] = [];
const batches: Update[][] = [];
let webhookUrl = '';
let pollingError: DeliveryError | undefined;
let editFailure: DeliveryError | undefined;
let delayedAnswer: Promise<void> | undefined;
let debugChat: Chat = group;
const api: TelegramApi = {
  async getMe() { return bot; },
  async getChat() { return debugChat as Awaited<ReturnType<TelegramApi['getChat']>>; },
  async getWebhookInfo() { return { url: webhookUrl, has_custom_certificate: false, pending_update_count: 0 }; },
  async getUpdates(payload, signal) {
    offsets.push(payload?.offset);
    if (pollingError) throw pollingError;
    const batch = batches.shift();
    if (batch) return batch;
    return new Promise((resolve) => {
      if (signal?.aborted) resolve([]);
      else signal?.addEventListener('abort', () => resolve([]), { once: true });
    });
  },
  async sendMessage(chatId, text, options) {
    sent.push({ chatId: Number(chatId), text, options });
    return { message_id: sent.length, date: 1, chat: privateChat, text };
  },
  async editMessageText(chatId, messageId, text, options) {
    assert.ok(typeof text === 'string');
    if (editFailure) throw editFailure;
    const previous = [...edits].reverse().find((edit) => edit.messageId === messageId);
    if (previous?.text === text && JSON.stringify(previous.options) === JSON.stringify(options)) {
      throw new GrammyError('editMessageText failed', {
        ok: false, error_code: 400, description: 'Bad Request: message is not modified'
      }, 'editMessageText', {});
    }
    edits.push({ chatId: Number(chatId), messageId, text, options });
    return { message_id: messageId, date: 1, edit_date: 1, chat: privateChat, text };
  },
  async answerCallbackQuery(id, callbackOptions) {
    replies.push({ id, text: callbackOptions?.text });
    if (id === 'valid') assert.equal(edits.length, 0);
    if (id === 'slow-answer') {
      await delayedAnswer;
      throw new DeliveryError('network');
    }
    return true;
  }
};

let db = openDatabase(config);
let notifier = createTelegramNotifier(db, config, bot.id, api);
let drainOutbox = createOutboxDrain(db, notifier);
let commandDelivery = Promise.resolve();
let outboxWakes = 0;
let active: Awaited<ReturnType<typeof startTelegramPolling>> | undefined;
try {
  await validateTelegramDebugChat(api, group.id);
  debugChat = { id: -900, type: 'channel', title: 'A channel' };
  await assert.rejects(validateTelegramDebugChat(api, -900), /must refer to a private Telegram group/);
  debugChat = { id: -901, type: 'supergroup', title: 'Public group', username: 'public_group' };
  await assert.rejects(validateTelegramDebugChat(api, -901), /must refer to a private Telegram group/);

  storeEmail();
  enqueueNotification(db, notifier, 'realtime', item.mailId, [notifier.planRealtime(item)]);
  await drainOutbox();
  assert.equal(sent.length, 0);

  webhookUrl = 'https://example.test/sensitive-hook-path';
  await assert.rejects(startTelegramPolling(db, api, notifier, options), {
    message: 'Telegram bot has an active webhook. Remove it before enabling long polling.'
  });
  assert.deepEqual(offsets, []);
  webhookUrl = '';

  batches.push([start(10, privateChat, otherUser), start(11, group, owner), start(12, { ...privateChat, id: 501 }, owner)]);
  await runBatch();
  assert.deepEqual(offsets.splice(0), [undefined, 13]);
  assert.equal(isTelegramChatReady(db, options), false);
  assert.equal(outboxWakes, 0);
  assert.equal(sent.length, 0);

  batches.push([start(13, privateChat, owner)]);
  await runBatch();
  assert.deepEqual(offsets.splice(0), [13, 14]);
  assert.equal(isTelegramChatReady(db, options), true);
  assert.equal(outboxWakes, 1);
  await commandDelivery;
  assert.deepEqual(sent.map((message) => message.chatId), [500, 500]);
  const keyboard = sent[0]?.options?.reply_markup;
  assert.ok(keyboard && 'inline_keyboard' in keyboard);
  const button = keyboard.inline_keyboard[0]?.[0];
  assert.ok(button && 'callback_data' in button);
  const data = button.callback_data;
  assert.match(data, /^view:[A-Za-z0-9_-]{22}$/);
  assert.ok(!data.includes(item.id));
  assert.equal(sent[0]?.options?.link_preview_options?.is_disabled, true);
  assert.equal(sent[0]?.options?.parse_mode, undefined);

  const expired = 'E'.repeat(22);
  const missing = 'M'.repeat(22);
  const legacy = db.prepare(`
    insert into telegram_preview_tokens (token, bot_id, owner_user_id, chat_id, mail_id, expires_at)
    values (?, ?, ?, ?, ?, ?)
  `);
  legacy.run(expired, bot.id, owner.id, privateChat.id, item.mailId, 0);
  legacy.run(missing, bot.id, owner.id, privateChat.id, 'primary:missing', Date.now() + 60_000);
  db.exec('alter table notification_outbox drop column sent_at');
  db.close();
  db = openDatabase(config);
  notifier = createTelegramNotifier(db, config, bot.id, api);
  drainOutbox = createOutboxDrain(db, notifier);
  batches.push([
    start(13, privateChat, owner),
    click(14, 'wrong-user', privateChat, otherUser, data),
    click(15, 'group', group, owner, data),
    click(16, 'wrong-chat', { ...privateChat, id: 501 }, owner, data),
    click(17, 'wrong-bot', privateChat, owner, data, otherUser),
    click(18, 'forged', privateChat, owner, `mail:${'A'.repeat(22)}`),
    click(19, 'expired', privateChat, owner, `mail:${expired}`),
    click(20, 'valid', privateChat, owner, data),
    click(21, 'duplicate', privateChat, owner, data),
    click(22, 'missing', privateChat, owner, `mail:${missing}`, bot, 2)
  ]);
  await runBatch();
  assert.deepEqual(offsets.splice(0), [14, 23]);
  assert.deepEqual(replies.map(({ text }) => text), [
    '此操作不可用。', '此操作不可用。', '此操作不可用。', '此操作不可用。', '按钮已过期或无效。', '按钮已过期或无效。',
    undefined, undefined, undefined
  ]);
  assert.equal(outboxWakes, 1);
  assert.equal(sent.length, 2);
  assert.deepEqual(edits.map(({ chatId, messageId }) => [chatId, messageId]), [[500, 1], [500, 2]]);
  assert.match(edits[0]!.text, /Private synthetic summary/);
  assert.match(edits[0]!.text, /Due Friday/);
  assert.match(edits[0]!.text, /Check the portal/);
  assert.doesNotMatch(edits[0]!.text, /Private synthetic body/);
  assert.match(edits[1]!.text, /邮件正文缓存已过期/);
  assert.equal(edits[0]!.options?.parse_mode, undefined);
  assert.equal(telegramOffset(db, bot.id, Date.now() + 8 * 24 * 60 * 60_000), undefined);

  await verifyDigestCommands();
  pollingError = new DeliveryError(409);
  const currentOffset = telegramOffset(db, bot.id);
  active = await startTelegramPolling(db, api, notifier, options);
  await assert.rejects(active.done, /another receiver is active/);
  active = undefined;
  assert.deepEqual(offsets.splice(0), [currentOffset]);

  await notifier.sendOperationalAlert({
    kind: 'account-failure', signature: 'sig', accountName: 'private account', accountEmail: 'private email', detail: 'private secret'
  });
  assert.equal(sent.at(-1)?.chatId, -800);
  assert.doesNotMatch(sent.at(-1)!.text, /private/);

  await assert.rejects(telegramRequest('sendMessage', async () => {
    throw new GrammyError('token / email excerpt', {
      ok: false, error_code: 429, description: 'private email', parameters: { retry_after: 33 }
    }, 'sendMessage', { text: 'private email' });
  }), { message: 'HTTP 429', retryAfterMs: 33_000 });

  const agent = createTelegramApi(config.telegram.botToken).options?.baseFetchConfig?.agent;
  assert.ok(agent instanceof Agent);
  assert.equal(agent.options.family, 4);
  assert.equal(agent.options.keepAlive, true);
} finally {
  active?.stop();
  await active?.done.catch(() => {});
  if (db.open) db.close();
  rmSync(directory, { recursive: true, force: true });
}

console.log('telegram/poller.test.ts: all assertions passed');

async function runBatch(checkWhilePolling?: () => void): Promise<void> {
  active = await startTelegramPolling(db, api, notifier, options);
  await setImmediate();
  if (checkWhilePolling) {
    checkWhilePolling();
    await setImmediate();
  }
  await assert.rejects(startTelegramPolling(db, api, notifier, options), /Another Telegram poller/);
  active.stop();
  await active.done;
  active = undefined;
}

async function verifyDigestCommands(): Promise<void> {
  let updateId = 23;
  const previousClock = Settings.now;
  const day = DateTime.fromISO('2026-11-18T19:00:00', { zone: options.timezone });
  const useDigestDay = db.prepare('update message_classifications set processed_at = ?');
  const digestDayUtc = day.toUTC().toISO();
  useDigestDay.run(digestDayUtc);
  Settings.now = () => day.toMillis();
  try {
    const upcoming = await sendCommand('/today@hedwig_test_bot');
    assert.match(upcoming.text, /邮件摘要 · 1 封/);
    assert.match(upcoming.text, /个人、学校/);
    assert.equal(countJobs('digest'), 0);

    for (let index = 0; index < 4; index += 1) {
      const id = `message-${index}`;
      storeEmail({ ...item, id, mailId: `primary:${id}`, subject: `Synthetic ${index}`, importance: 99 - index });
    }
    const body = '甲'.repeat(3299) + '😀<script> & [raw]</script>\nRegister https://portal.example.test/apply\n' + '乙'.repeat(4000);
    storeEmail({
      ...item, accountId: 'study', mailId: `study:${item.id}`, subject: '学校邮件 <主题> 😀',
      summary: '固定历史摘要', importance: 70
    }, body);
    useDigestDay.run(digestDayUtc);

    await queueTodayDigest(config, db, notifier);
    await queueTodayDigest(config, db, notifier);
    assert.equal(countJobs('digest'), 1);
    await drainOutbox();
    const daily = sent.at(-1)!;
    const dailyMessageId = sent.length;
    assert.match(daily.text, /邮件摘要 · 6 封/);
    const category = callbackButton(daily.options?.reply_markup, '待处理 · 6');

    await dispatch([
      command(updateId++, '/summary_language French', group),
      command(updateId++, '/today', privateChat, otherUser),
      command(updateId++, '/status@other_bot')
    ]);
    assert.equal(getSummaryLanguage(db), null);
    assert.equal(sent.length, dailyMessageId);
    assert.match((await sendCommand('/summary_language')).text, /语言不能为空/);
    assert.match((await sendCommand('/summary_language aaaaaaaaaaaaa')).text, /不能超过 12/);
    assert.match((await sendCommand('/summary_language   English')).text, /English/);
    assert.equal(getSummaryLanguage(db), 'English');

    // New mail after the scheduled snapshot does not rewrite the original or /today.
    storeEmail({ ...item, id: 'later', mailId: 'primary:later', subject: 'Later mail' });
    useDigestDay.run(digestDayUtc);
    const today = await sendCommand('/today');
    assert.equal(today.text, daily.text);
    assert.equal(callbackButton(today.options?.reply_markup, '待处理 · 6'), category);
    await queueTodayDigest(config, db, notifier);
    assert.equal(countJobs('digest'), 1);

    setSyncCursor(db, 'primary', 'synthetic-cursor');
    const status = await sendCommand('/status');
    assert.match(status.text, /最近同步：\d{4}-\d{2}-\d{2}/);
    assert.match(status.text, /最近成功投递：\d{4}-\d{2}-\d{2}/);
    assert.match(status.text, /待投递或重试：0 条/);
    assert.doesNotMatch(status.text, /Private|synthetic-cursor|@example/);

    const sendCount = sent.length;
    editFailure = new DeliveryError(429, 5_000);
    await dispatch([click(updateId, 'edit-retry', privateChat, owner, category, bot, dailyMessageId)]);
    assert.equal(telegramOffset(db, bot.id), updateId);
    editFailure = undefined;
    const section = await followWhileAckPending(category);
    assert.match(section.text, /待处理 · 1\/2 页/);
    assert.doesNotMatch(section.text, /Later mail/);
    const sectionPageTwo = await follow(callbackButton(section.options?.reply_markup, '下一页'));
    assert.match(sectionPageTwo.text, /2\/2 页[\s\S]+学校邮件 <主题> 😀[\s\S]+固定历史摘要/);
    const mail = await follow(callbackButton(sectionPageTwo.options?.reply_markup, '查看第 6 封'));
    assert.match(mail.text, /study@example\.test/);
    assert.match(mail.text, /建议操作/);
    assert.ok(urlButtons(mail.options?.reply_markup).includes('https://portal.example.test/apply'));
    assert.ok(urlButtons(mail.options?.reply_markup).some((url) => url.includes('study%40example.test')));
    assert.doesNotMatch(mail.text, /<script>/);

    const bodyAction = callbackButton(mail.options?.reply_markup, '查看正文');
    let page = await follow(bodyAction);
    const chunks = [page.text.split('\n\n')[1]!];
    assert.match(page.text, /正文 · 1\/3 页/);
    for (let pageIndex = 2; pageIndex <= 3; pageIndex += 1) {
      page = await follow(callbackButton(page.options?.reply_markup, '下一页'));
      assert.match(page.text, new RegExp(`正文 · ${pageIndex}/3 页`));
      assert.ok(page.text.length < 4096);
      assert.ok(!/[\uD800-\uDBFF]$/.test(page.text));
      assert.equal(page.options?.parse_mode, undefined);
      assert.equal(page.options?.link_preview_options?.is_disabled, true);
      chunks.push(page.text.split('\n\n')[1]!);
    }
    assert.equal(chunks.join(''), body);
    const backToMail = await follow(callbackButton(page.options?.reply_markup, '返回邮件详情'));
    assert.equal(backToMail.text, mail.text);
    const backToList = await follow(callbackButton(backToMail.options?.reply_markup, '返回分类'));
    assert.equal(backToList.text, sectionPageTwo.text);
    const overview = await follow(callbackButton(backToList.options?.reply_markup, '返回总览'));
    assert.equal(overview.text, daily.text);
    assert.equal(sent.length, sendCount);

    Settings.now = () => day.plus({ days: 1 }).toMillis();
    const nextDay = await sendCommand('/today');
    assert.match(nextDay.text, /邮件摘要 · 0 封/);
    assert.match(nextDay.text, /今天暂无邮件摘要/);
    const historical = await follow(category);
    assert.ok(historical.text.startsWith(day.toISODate()!));
    db.prepare('update email_body_cache set expires_at = ? where account_id = ?').run(new Date(0).toISOString(), 'study');
    const expiredBody = await follow(bodyAction);
    assert.match(expiredBody.text, /缓存已过期/);
    assert.ok(urlButtons(expiredBody.options?.reply_markup).some((url) => url.includes('study%40example.test')));
    assert.equal(countJobs('digest'), 1);
    assert.equal((db.prepare('select count(*) as count from message_classifications').get() as { count: number }).count, 7);
    assert.equal((db.prepare('select count(*) as count from notification_outbox where payload_json like ?').get('%<script>%') as { count: number }).count, 0);

    db.prepare('update telegram_digest_snapshots set expires_at = 0 where scheduled = 1').run();
    db.prepare('update telegram_view_tokens set expires_at = 0 where token = ?').run(category.slice('view:'.length));
    const editCount = edits.length;
    await dispatch([click(updateId++, 'expired-snapshot', privateChat, owner, category, bot, dailyMessageId)]);
    assert.equal(replies.at(-1)?.text, '按钮已过期或无效。');
    assert.equal(edits.length, editCount);

    async function follow(data: string): Promise<(typeof edits)[number]> {
      await dispatch([click(updateId++, 'navigate', privateChat, owner, data, bot, dailyMessageId)]);
      const reply = edits.at(-1)!;
      assert.equal(reply.messageId, dailyMessageId);
      return reply;
    }

    async function followWhileAckPending(data: string): Promise<(typeof edits)[number]> {
      const before = edits.length;
      let releaseAnswer!: () => void;
      delayedAnswer = new Promise<void>((resolve) => { releaseAnswer = resolve; });
      const callbackOffset = updateId++;
      batches.push([click(callbackOffset, 'slow-answer', privateChat, owner, data, bot, dailyMessageId)]);
      try {
        await runBatch(() => {
          try {
            assert.equal(edits.length, before + 1);
            assert.equal(edits.at(-1)?.messageId, dailyMessageId);
            assert.equal(telegramOffset(db, bot.id), callbackOffset + 1);
          } finally {
            releaseAnswer();
          }
        });
        assert.equal(telegramOffset(db, bot.id), callbackOffset + 1);
        return edits.at(-1)!;
      } finally {
        releaseAnswer();
        delayedAnswer = undefined;
        offsets.length = 0;
      }
    }
  } finally {
    Settings.now = previousClock;
  }

  async function sendCommand(text: string): Promise<(typeof sent)[number]> {
    const before = sent.length;
    await dispatch([command(updateId++, text)]);
    assert.equal(sent.length, before + 1);
    return sent.at(-1)!;
  }

  async function dispatch(updates: Update[]): Promise<void> {
    batches.push(updates);
    await runBatch();
    offsets.length = 0;
    await commandDelivery;
  }
}

function countJobs(kind: string): number {
  return (db.prepare('select count(*) as count from notification_outbox where kind = ?').get(kind) as { count: number }).count;
}

function callbackButton(keyboard: unknown, label: string): string {
  const button = (keyboard as InlineKeyboardMarkup | undefined)?.inline_keyboard.flat().find(({ text }) => text === label);
  assert.ok(button && 'callback_data' in button, `expected callback button ${label}`);
  return button.callback_data;
}

function urlButtons(keyboard: InlineKeyboardMarkup | undefined): string[] {
  return keyboard?.inline_keyboard.flat().flatMap((button) => 'url' in button ? [button.url] : []) ?? [];
}

function start(updateId: number, chat: Chat.PrivateChat | Chat.GroupChat, from: typeof owner): Update {
  return command(updateId, '/start@hedwig_test_bot', chat, from);
}

function command(updateId: number, text: string, chat = privateChat as Chat.PrivateChat | Chat.GroupChat, from = owner): Update {
  return { update_id: updateId, message: { message_id: updateId, date: 1, chat, text, from } };
}

function click(updateId: number, id: string, chat: Chat, from: typeof owner, data: string, sender: typeof bot | typeof owner = bot, messageId = 1): Update {
  const message: Message.TextMessage = { message_id: messageId, date: 1, chat, from: sender, text: 'Hedwig' };
  return { update_id: updateId, callback_query: { id, from, message, chat_instance: 'test', data } };
}

function storeEmail(entry: DigestItem = item, body = 'Private synthetic body'): void {
  const account = `${entry.accountId}@example.test`;
  const email: EmailMessage = {
    id: entry.id, accountId: entry.accountId, accountEmail: account, threadId: `thread-${entry.id}`, labelIds: [], headers: [],
    subject: entry.subject, from: entry.from, date: null, snippet: 'synthetic snippet', text: body, gmailUrl: entry.gmailUrl
  };
  const run = createDigestRun(db, entry.accountId, account, new Date());
  saveMessage(db, account, email);
  saveEmailBodyCache(db, email);
  saveClassification(db, run, email, entry, entry.processingOutcome);
}

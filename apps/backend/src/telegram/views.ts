import type { InlineKeyboardButton, InlineKeyboardMarkup } from 'grammy/types';
import { getCachedEmailPreview, getStoredGmailUrl, type HedwigDb } from '../db.js';
import type { DeliveryPart } from '../notifications/notifier.js';
import type { Category, DigestReport, GmailAccountConfig } from '../types.js';
import {
  findTelegramDigestSnapshot,
  pruneTelegramViews,
  saveTelegramDigestSnapshot,
  telegramViewToken,
  type TelegramListPage,
  type TelegramMailView,
  type TelegramPrivateChat,
  type TelegramView
} from './store.js';

export type TelegramMessage = { text: string; keyboard?: InlineKeyboardMarkup };

const SECTION_LABELS: Partial<Record<Category, string>> = { action: '待处理', fyi: '通知', course: '课程', admin: '行政' };
const ITEMS_PER_PAGE = 5;
const BODY_PAGE_LENGTH = 3300;

export function telegramDigestOverview(
  db: HedwigDb,
  chat: TelegramPrivateChat,
  digest: DigestReport,
  accounts: ReadonlyArray<Pick<GmailAccountConfig, 'id' | 'displayName'>>,
  scheduled: boolean
): TelegramMessage {
  pruneTelegramViews(db);
  const saved = findTelegramDigestSnapshot(db, chat, { scheduledDate: digest.date });
  if (saved) return digestOverview(db, chat, saved);

  const accountNames = accounts.map(({ displayName }) => displayName).filter(Boolean).join('、');
  const sections = digest.sections.flatMap(({ category, items }) => {
    const title = SECTION_LABELS[category];
    if (!title) return [];
    return [{
      category,
      title,
      items: items.map(({ mailId, accountId, accountName, subject, summary }) => ({
        mailId,
        accountName: accounts.find(({ id }) => id === accountId)?.displayName || accountName,
        subject,
        summary
      }))
    }];
  });
  const overview = [
    `${digest.date} 邮件摘要 · ${digest.total} 封`,
    accountNames ? `账号：${limitTelegramText(accountNames, 500)}` : '',
    sections.map(({ title, items }) => `${title} ${items.length}`).join(' · '),
    digest.total === 0 ? '今天暂无邮件摘要。' : ''
  ].filter(Boolean).join('\n');

  return digestOverview(db, chat, saveTelegramDigestSnapshot(db, chat, { date: digest.date, overview, sections }, scheduled));
}

export function renderTelegramView(db: HedwigDb, chat: TelegramPrivateChat, view: TelegramView): TelegramMessage | undefined {
  if (view.kind === 'overview' || view.kind === 'section') {
    const snapshotId = view.kind === 'overview' ? view.snapshotId : view.list.snapshotId;
    const snapshot = findTelegramDigestSnapshot(db, chat, { id: snapshotId });
    if (!snapshot) return undefined;
    return view.kind === 'overview' ? digestOverview(db, chat, snapshot) : renderSection(db, chat, snapshot, view.list);
  }
  return renderMail(db, chat, view.mail, view.kind === 'body' ? view.page : undefined);
}

type Snapshot = NonNullable<ReturnType<typeof findTelegramDigestSnapshot>>;

function digestOverview(db: HedwigDb, chat: TelegramPrivateChat, snapshot: Snapshot): TelegramMessage {
  const buttons = snapshot.sections.flatMap(({ title, items }, section) => items.length ? [
    viewButton(db, chat, `${title} · ${items.length}`, {
      kind: 'section', list: { snapshotId: snapshot.id, section, page: 0 }
    }, snapshot.expiresAt)
  ] : []);
  if (!buttons.length) return { text: snapshot.overview };
  const rows = buttons.length <= 2 ? [buttons] : [buttons.slice(0, 2), buttons.slice(2)];
  return { text: snapshot.overview, keyboard: { inline_keyboard: rows } };
}

function renderSection(db: HedwigDb, chat: TelegramPrivateChat, snapshot: Snapshot, list: TelegramListPage): TelegramMessage | undefined {
  const section = snapshot.sections[list.section];
  if (!section?.items.length) return undefined;
  const totalPages = Math.ceil(section.items.length / ITEMS_PER_PAGE);
  const page = Math.min(list.page, totalPages - 1);
  const start = page * ITEMS_PER_PAGE;
  const items = section.items.slice(start, start + ITEMS_PER_PAGE);
  const text = [
    `${snapshot.date} · ${section.title} · ${page + 1}/${totalPages} 页`,
    ...items.map(({ accountName, subject, summary }, index) => [
      `${start + index + 1}. ${limitTelegramText(subject || '无标题', 240)}`,
      limitTelegramText(accountName, 120),
      limitTelegramText(summary, 200)
    ].filter(Boolean).join('\n'))
  ].join('\n\n');
  const buttons = items.map(({ mailId }, index) => [viewButton(db, chat, `查看第 ${start + index + 1} 封`, {
    kind: 'mail', mail: { mailId, list }
  }, snapshot.expiresAt)]);
  const pageButtons = navigationButtons(page, totalPages, (target, label) => viewButton(db, chat, label, {
    kind: 'section', list: { ...list, page: target }
  }, snapshot.expiresAt));
  if (pageButtons.length) buttons.push(pageButtons);
  buttons.push([viewButton(db, chat, '返回总览', { kind: 'overview', snapshotId: snapshot.id }, snapshot.expiresAt)]);
  return { text, keyboard: { inline_keyboard: buttons } };
}

function renderMail(
  db: HedwigDb,
  chat: TelegramPrivateChat,
  mail: TelegramMailView,
  bodyPage?: number
): TelegramMessage | undefined {
  const snapshot = mail.list && findTelegramDigestSnapshot(db, chat, { id: mail.list.snapshotId });
  if (mail.list && !snapshot) return undefined;
  const button = (label: string, view: TelegramView) => viewButton(db, chat, label, view, snapshot?.expiresAt);
  const details: TelegramView = { kind: 'mail', mail };
  const back = bodyPage !== undefined ? button('返回邮件详情', details)
    : mail.list ? button('返回分类', { kind: 'section', list: mail.list }) : undefined;
  const preview = getCachedEmailPreview(db, mail.mailId);
  const gmail = gmailButton(preview?.gmailUrl || getStoredGmailUrl(db, mail.mailId));
  const footer: InlineKeyboardButton[][] = [back, gmail].filter((item) => item !== undefined).map((item) => [item]);
  if (!preview) {
    return { text: '邮件正文缓存已过期。', keyboard: { inline_keyboard: footer } };
  }
  const title = limitTelegramText(preview.subject || '无标题', 250);
  if (bodyPage !== undefined) {
    const pages = splitBody(preview.bodyText);
    const page = Math.min(bodyPage, pages.length - 1);
    const arrows = navigationButtons(page, pages.length, (target, label) => button(label, { kind: 'body', mail, page: target }));
    return {
      text: `${title}\n正文 · ${page + 1}/${pages.length} 页\n\n${pages[page]}`,
      keyboard: { inline_keyboard: arrows.length ? [arrows, ...footer] : footer }
    };
  }

  const text = [
    `账号：${limitTelegramText(preview.accountName, 150)}`,
    `发件人：${limitTelegramText(preview.from, 250)}`,
    `标题：${title}`,
    preview.summary && `摘要：${limitTelegramText(preview.summary, 900)}`,
    bulletBlock('注意点', preview.attentionPoints),
    bulletBlock('建议操作', preview.suggestedActions)
  ].filter(Boolean).join('\n\n');
  const links = preview.links.slice(0, 3).flatMap(({ url, label }) => {
    const safe = webUrl(url);
    return safe ? [[{ text: limitTelegramText(label || safe.hostname, 56), url: safe.href }]] : [];
  });
  return {
    text,
    keyboard: { inline_keyboard: [[button('查看正文', { kind: 'body', mail, page: 0 })], ...links, ...footer] }
  };
}

function bulletBlock(title: string, items: string[]): string {
  return items.length ? [title, ...items.slice(0, 3).map((item) => `• ${limitTelegramText(item, 230)}`)].join('\n') : '';
}

function splitBody(text: string): string[] {
  if (!text.trim()) return ['邮件没有可显示的正文。'];
  const pages: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + BODY_PAGE_LENGTH, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end - 1) + 1;
      if (newline > start + BODY_PAGE_LENGTH / 2) end = newline;
      if (/[\uD800-\uDBFF]/.test(text[end - 1]!)) end -= 1;
    }
    pages.push(text.slice(start, end));
    start = end;
  }
  return pages;
}

function navigationButtons(
  page: number,
  pages: number,
  button: (page: number, label: string) => InlineKeyboardButton.CallbackButton
): InlineKeyboardButton.CallbackButton[] {
  const buttons: InlineKeyboardButton.CallbackButton[] = [];
  if (page > 0) buttons.push(button(page - 1, '上一页'));
  if (page + 1 < pages) buttons.push(button(page + 1, '下一页'));
  return buttons;
}

export function viewButton(
  db: HedwigDb,
  chat: TelegramPrivateChat,
  label: string,
  view: TelegramView,
  expiresAt?: number
): InlineKeyboardButton.CallbackButton {
  return { text: label, callback_data: `view:${telegramViewToken(db, chat, view, expiresAt)}` };
}

export function gmailButton(url?: string): InlineKeyboardButton.UrlButton | undefined {
  const parsed = url && webUrl(url);
  if (parsed && parsed.origin === 'https://mail.google.com') return { text: '打开 Gmail', url: parsed.href };
  return undefined;
}

function webUrl(url: string): URL | undefined {
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  if (parsed.username || parsed.password || !['http:', 'https:'].includes(parsed.protocol) || parsed.href.length > 2048) return undefined;
  return parsed;
}

export function telegramMessagePart(message: TelegramMessage): DeliveryPart {
  return { key: 'message', payload: { ...message, text: limitTelegramText(message.text, 4000) } };
}

export function limitTelegramText(text: string, length: number): string {
  if (text.length <= length) return text;
  return `${text.slice(0, length - 1).replace(/[\uD800-\uDBFF]$/, '')}…`;
}

import type { Category, Classification, EmailMessage } from './types.js';

const CATEGORIES = {
  action: {
    title: 'Action'
  },
  fyi: {
    title: 'FYI'
  },
  course: {
    title: 'Course'
  },
  admin: {
    title: 'Admin'
  },
  junk: {
    title: 'Junk'
  }
} satisfies Record<Category, { title: string }>;

const CATEGORY_ORDER: Category[] = ['action', 'fyi', 'course', 'admin', 'junk'];

const marketingDomains = [
  'mailchimp',
  'sendgrid',
  'sendinblue',
  'klaviyo',
  'campaignmonitor',
  'constantcontact',
  'emarsys',
  'braze',
  'iterable',
  'mailgun',
  'mandrill',
  'sparkpost'
];

const actionTerms = [
  'action required',
  'please respond',
  'please reply',
  'reply by',
  'requires your response',
  'approval required',
  'decision required',
  'confirm',
  'rsvp',
  '需要回复',
  '请回复',
  '需要确认',
  '请确认',
  '需要决定'
];

const courseTerms = [
  'lecture',
  'tutorial',
  'seminar',
  'course',
  'class',
  'reading',
  'slides',
  'assignment',
  'moodle',
  'canvas',
  'blackboard',
  '讲义',
  '阅读',
  '课程',
  '作业',
  '参考资料'
];

const adminTerms = [
  'invoice',
  'receipt',
  'statement',
  'payment',
  'registration',
  'enrolment',
  'enrollment',
  'security alert',
  'verification code',
  'password reset',
  'system notification',
  '账单',
  '收据',
  '付款',
  '注册',
  '系统通知',
  '验证码'
];

const verificationCodeTerms = [
  'verification code',
  'one-time password',
  'one time password',
  'one-time passcode',
  'passcode',
  'security code',
  'login code',
  'sign-in code',
  'sign in code',
  'authentication code',
  '2fa code',
  'otp',
  'is your code',
  'your code is',
  '验证码',
  '校验码',
  '动态码',
  '登录码',
  '安全码',
  '一次性密码'
];

const promoTerms = [
  'sale',
  'discount',
  'offer',
  'promotion',
  'promo',
  'newsletter',
  'subscribe',
  'deal',
  'coupon',
  '营销',
  '促销',
  '优惠',
  '订阅'
];

function includesAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function headerValue(headers: EmailMessage['headers'], name: string): string {
  const found = headers.find((header) => header.name?.toLowerCase() === name.toLowerCase());
  return found?.value || '';
}

function normalize(text: string): string {
  return text.toLowerCase();
}

export function isVerificationCode(email: EmailMessage): boolean {
  // Match only on subject + snippet (not the full body) so an unrelated email
  // that merely mentions a code in its footer is not swept up. These one-time
  // codes are disposable: classify as junk so they are never pushed or digested.
  const haystack = normalize(`${email.subject} ${email.snippet}`);
  return includesAny(haystack, verificationCodeTerms);
}

export function hasJunkEvidence(email: EmailMessage): boolean {
  const haystack = normalize(`${email.from} ${email.subject} ${email.snippet} ${email.text}`);
  const listUnsubscribe = headerValue(email.headers, 'List-Unsubscribe');
  const from = normalize(email.from);
  const hasUnsubscribe = Boolean(listUnsubscribe) || haystack.includes('unsubscribe');
  const hasMarketingDomain = marketingDomains.some((domain) => from.includes(domain) || haystack.includes(domain));
  const hasPromoLanguage = includesAny(haystack, promoTerms);

  return hasUnsubscribe && (hasMarketingDomain || hasPromoLanguage);
}

function importanceScore(category: Category, email: EmailMessage, haystack: string): number {
  let score = 0;
  if (category === 'action') score += 80;
  if (category === 'course') score += 50;
  if (category === 'admin') score += 40;
  if (category === 'fyi') score += 20;
  if (category === 'junk') score += 1;
  if (includesAny(haystack, ['urgent', '重要', 'asap', 'deadline', 'due'])) score += 15;
  if (email.date) score += Math.min(10, Math.max(0, Date.now() - email.date.getTime()) / -36e5 + 10);
  return Math.round(score);
}

export function classifyEmail(email: EmailMessage): Classification {
  const haystack = normalize(`${email.from} ${email.subject} ${email.snippet} ${email.text}`);

  let category: Category = 'fyi';
  if (hasJunkEvidence(email) || isVerificationCode(email)) {
    category = 'junk';
  } else if (includesAny(haystack, actionTerms)) {
    category = 'action';
  } else if (includesAny(haystack, courseTerms) || email.from.toLowerCase().includes('.edu')) {
    category = 'course';
  } else if (includesAny(haystack, adminTerms)) {
    category = 'admin';
  }

  return {
    category,
    importance: importanceScore(category, email, haystack),
    summary: summarize(email),
    attentionPoints: [],
    suggestedActions: [],
    confidence: 0.55,
    provider: 'rule'
  };
}

export function normalizeClassification(
  email: EmailMessage,
  classification: Partial<Classification>,
  provider = 'unknown'
): Classification {
  const allowed = new Set(CATEGORY_ORDER);
  let category: Category = classification.category && allowed.has(classification.category)
    ? classification.category
    : 'fyi';
  if (category === 'junk' && !hasJunkEvidence(email) && !isVerificationCode(email)) {
    category = 'fyi';
  }

  const haystack = normalize(`${email.from} ${email.subject} ${email.snippet} ${email.text}`);
  const summary = typeof classification.summary === 'string' && classification.summary.trim()
    ? classification.summary.trim().slice(0, 320)
    : summarize(email);
  const importance = typeof classification.importance === 'number' && Number.isFinite(classification.importance)
    ? clamp(Math.round(classification.importance), 0, 100)
    : importanceScore(category, email, haystack);
  const confidence = typeof classification.confidence === 'number' && Number.isFinite(classification.confidence)
    ? clamp(classification.confidence, 0, 1)
    : 0.5;

  return {
    category,
    importance,
    summary,
    attentionPoints: normalizeDetailList(classification.attentionPoints),
    suggestedActions: normalizeDetailList(classification.suggestedActions),
    confidence,
    reason: typeof classification.reason === 'string' ? classification.reason.slice(0, 240) : '',
    provider
  };
}

function normalizeDetailList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const normalized = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((item) => Array.from(item).slice(0, 160).join(''));
  return [...new Set(normalized)].slice(0, 3);
}

export function categories(): typeof CATEGORIES {
  return CATEGORIES;
}

export function categoryOrder(): Category[] {
  return CATEGORY_ORDER;
}

export function summarize(email: EmailMessage): string {
  const source = (email.snippet || email.subject || '').replace(/\s+/g, ' ').trim();
  if (!source) return '无摘要';
  if (/[\u3400-\u9fff]/.test(source)) {
    const chars = Array.from(source);
    return chars.length > 80 ? `${chars.slice(0, 80).join('')}…` : chars.join('');
  }
  return source.length > 220 ? `${source.slice(0, 218)}…` : source;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

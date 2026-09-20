import type { gmail_v1 } from 'googleapis';
import type { EmailMessage } from './types.js';

// Same field set buildUserContent (llm/openai-compatible-classifier.ts) sends
// for a single email; batch mode wraps an array of these in EMAILS_JSON. Kept
// here (not in llm/) so both the batch builder's token estimate and the LLM
// classifier's actual request body are built from one payload shape.
export type EmailPayload = {
  from: string;
  subject: string;
  date: string | null;
  headers: { name: string; value?: string | null }[];
  snippet: string;
  text: string;
};

export function buildEmailPayload(email: EmailMessage): EmailPayload {
  return {
    from: email.from,
    subject: email.subject,
    date: email.date?.toISOString?.() || null,
    headers: pickHeaders(email.headers),
    snippet: email.snippet,
    text: email.text.slice(0, 6000)
  };
}

export function pickHeaders(headers: gmail_v1.Schema$MessagePartHeader[]) {
  const keep = new Set(['From', 'Subject', 'Date', 'List-Unsubscribe', 'Precedence', 'Auto-Submitted']);
  return headers
    .filter((header): header is gmail_v1.Schema$MessagePartHeader & { name: string } => (
      typeof header.name === 'string' && keep.has(header.name)
    ))
    .map((header) => ({ name: header.name, value: header.value }));
}

// Rough token estimate for a budget check, not an exact tokenizer. CJK text
// runs close to 1 char per token; Latin text closer to 4 chars per token.
// Counting CJK separately and rounding up keeps the estimate on the safe
// (over-, not under-) side of the real count. The range covers CJK radicals,
// symbols/punctuation, and unified ideographs (U+2E80-U+9FFF) plus halfwidth/
// fullwidth forms (U+FF00-U+FFEF, e.g. full-width brackets and commas) —
// wider than just the ideograph block, since Chinese subject lines routinely
// mix in full-width punctuation that is not 4-chars-per-token like Latin text.
export function estimateTokens(text: string): number {
  const cjkCount = text.match(/[⺀-鿿＀-￯]/g)?.length ?? 0;
  const otherCount = text.length - cjkCount;
  return Math.ceil(cjkCount + otherCount / 4);
}

// Estimated on the same payload actually sent to the model (see
// buildEmailPayload), not on the raw email — email.text is truncated before
// it ever reaches the request, and estimating off the untruncated body would
// wrongly flag long-but-truncated emails as oversized.
export function estimateEmailTokens(email: EmailMessage): number {
  return estimateTokens(JSON.stringify(buildEmailPayload(email)));
}

export const DEFAULT_MAX_BATCH_ITEMS = 10;
export const DEFAULT_MAX_BATCH_INPUT_TOKENS = 24000;

export type ClassificationBatchConfig = {
  maxItems: number;
  maxInputTokens: number;
};

export type ClassificationBatchPlan = {
  batches: EmailMessage[][];
  // Emails whose own estimated tokens exceed maxInputTokens; per docs/micro-batch.md
  // section 7 these are excluded from batching entirely and must fall back to
  // single-email classification instead of stalling the batch builder.
  oversized: EmailMessage[];
};

const DEFAULT_CONFIG: ClassificationBatchConfig = {
  maxItems: DEFAULT_MAX_BATCH_ITEMS,
  maxInputTokens: DEFAULT_MAX_BATCH_INPUT_TOKENS
};

export function buildClassificationBatches(
  emails: EmailMessage[],
  config: ClassificationBatchConfig = DEFAULT_CONFIG
): ClassificationBatchPlan {
  const batches: EmailMessage[][] = [];
  const oversized: EmailMessage[] = [];

  let current: EmailMessage[] = [];
  let currentTokens = 0;

  for (const email of emails) {
    const tokens = estimateEmailTokens(email);

    if (tokens > config.maxInputTokens) {
      oversized.push(email);
      continue;
    }

    const wouldExceedItems = current.length + 1 > config.maxItems;
    const wouldExceedTokens = currentTokens + tokens > config.maxInputTokens;
    if (current.length > 0 && (wouldExceedItems || wouldExceedTokens)) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }

    current.push(email);
    currentTokens += tokens;
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return { batches, oversized };
}

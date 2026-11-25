import { categoryOrder, normalizeClassification } from './classifier.js';
import type { BatchClassificationResult, EmailMessage } from './types.js';

export type BatchItemProblem = {
  // null when the raw item carries no usable string emailId.
  emailId: string | null;
  reason: string;
};

export type BatchValidation =
  | {
    // docs/micro-batch.md section 12.1: a duplicate emailId (or a response that
    // is not an array at all) makes the whole batch untrustworthy, so nothing is
    // accepted and the caller treats it like a schema parse failure.
    ok: false;
    reason: 'results-not-array' | 'duplicate-email-id';
    duplicateEmailIds: string[];
  }
  | {
    ok: true;
    // Results that passed every check, already normalized, in input order.
    valid: BatchClassificationResult[];
    // Input emails with no valid result (missing or invalid), in input order.
    // Section 13: these get a single-email retry; the batch itself is not failed.
    retry: EmailMessage[];
    // One entry per rejected result or missing input, for logging.
    problems: BatchItemProblem[];
  };

// Reconciles the raw "results" array a model returned against the emails sent
// in the batch (docs/micro-batch.md section 12). Association is by emailId only;
// array order is never trusted.
export function validateBatchResults(
  inputEmails: EmailMessage[],
  rawResults: unknown,
  provider: string
): BatchValidation {
  if (!Array.isArray(rawResults)) {
    return { ok: false, reason: 'results-not-array', duplicateEmailIds: [] };
  }

  const duplicateEmailIds = findDuplicateEmailIds(rawResults);
  if (duplicateEmailIds.length > 0) {
    return { ok: false, reason: 'duplicate-email-id', duplicateEmailIds };
  }

  const inputById = new Map(inputEmails.map((email) => [email.id, email]));
  const validById = new Map<string, BatchClassificationResult>();
  const problems: BatchItemProblem[] = [];

  for (const raw of rawResults) {
    const emailId = readEmailId(raw);
    if (emailId === null) {
      problems.push({ emailId: null, reason: 'result has no string emailId' });
      continue;
    }

    const email = inputById.get(emailId);
    if (!email) {
      problems.push({ emailId, reason: 'unknown emailId (not in the input batch)' });
      continue;
    }

    const schemaError = findSchemaError(raw as Record<string, unknown>);
    if (schemaError) {
      problems.push({ emailId, reason: `invalid schema: ${schemaError}` });
      continue;
    }

    validById.set(emailId, {
      emailId,
      classification: normalizeClassification(email, raw as Record<string, unknown>, provider)
    });
  }

  const valid: BatchClassificationResult[] = [];
  const retry: EmailMessage[] = [];
  for (const email of inputEmails) {
    const result = validById.get(email.id);
    if (result) {
      valid.push(result);
      continue;
    }
    retry.push(email);
    if (!problems.some((problem) => problem.emailId === email.id)) {
      problems.push({ emailId: email.id, reason: 'missing from the model response' });
    }
  }

  return { ok: true, valid, retry, problems };
}

function readEmailId(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const emailId = (raw as Record<string, unknown>).emailId;
  return typeof emailId === 'string' && emailId ? emailId : null;
}

function findDuplicateEmailIds(rawResults: unknown[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const raw of rawResults) {
    const emailId = readEmailId(raw);
    if (emailId === null) continue;
    if (seen.has(emailId)) duplicates.add(emailId);
    seen.add(emailId);
  }
  return [...duplicates];
}

// Stricter than normalizeClassification, which silently defaults a bad
// category/summary/importance. In a batch an item that gets those wrong is
// rejected instead so it can be retried on its own; confidence, reason and the
// detail lists stay lenient and are cleaned up by normalizeClassification.
function findSchemaError(item: Record<string, unknown>): string | null {
  if (typeof item.category !== 'string' || !categoryOrder().includes(item.category as never)) {
    return 'category is missing or not one of the allowed values';
  }
  if (typeof item.summary !== 'string' || !item.summary.trim()) {
    return 'summary is missing or empty';
  }
  if (typeof item.importance !== 'number' || !Number.isFinite(item.importance)) {
    return 'importance is missing or not a finite number';
  }
  for (const field of ['attentionPoints', 'suggestedActions'] as const) {
    if (item[field] !== undefined && !Array.isArray(item[field])) {
      return `${field} is not an array`;
    }
  }
  return null;
}

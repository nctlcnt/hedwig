import { existsSync, readFileSync } from 'node:fs';
import OpenAI from 'openai';
import type { ChatCompletion } from 'openai/resources/chat/completions';
import { buildEmailPayload } from '../classification-batch.js';
import { validateBatchResults, type BatchItemProblem } from '../classification-batch-validation.js';
import { classifyEmail } from '../classifier.js';
import { summaryLanguageInstruction } from '../summary-language.js';
import type {
  AppConfig,
  BatchClassificationResult,
  Classification,
  EmailClassifier,
  EmailMessage,
  LlmClassifierConfig
} from '../types.js';

const prompt = readFileSync(new URL('../../prompts/email-classifier.md', import.meta.url), 'utf8');

// Prompt pieces docs/micro-batch.md section 9 specifies for a batch request.
// Single-email classification is a batch of one and uses the same prompt, so
// there is only one schema and one response parser to keep in sync.
const BATCH_MODE_INSTRUCTIONS = `You will classify multiple independent emails in a single request. Each email in EMAILS_JSON below carries its own "emailId".

These emails are independent classification tasks:
- Analyze and classify each email using only that email's own content.
- Never let the content of one email change the classification of another email.
- Return exactly one result per input emailId in "results"; the array order does not need to match the input order.
- Do not invent an emailId that was not in the input, and do not omit, merge, or split any input email.`;

const BATCH_SCHEMA_HINT = `Return a JSON object with this exact shape:
{
  "results": [
    {
      "emailId": "must exactly match one of the input emailId values",
      "category": "action" | "fyi" | "course" | "admin" | "junk",
      "summary": "exactly one compact sentence with concrete context",
      "attentionPoints": ["zero to three concise factual points worth noticing"],
      "suggestedActions": ["zero to three concise actions justified by the email"],
      "importance": integer 0-100,
      "confidence": number 0-1,
      "reason": "short factual reason"
    }
  ]
}`;

export function createOpenAICompatibleClassifier(
  config: AppConfig,
  summaryLanguage: string | null = null
): EmailClassifier {
  if (!config.classifier.llm.apiKey) {
    throw new Error('CLASSIFIER_API_KEY is required when CLASSIFIER_PROVIDER=openai-compatible');
  }

  const systemPrompt = buildBatchSystemPrompt(config.classifier.rulesPath, summaryLanguage);
  const clientOptions = {
    maxRetries: config.classifier.maxRetries,
    timeout: config.classifier.requestTimeoutMs
  };
  const tiers: BatchTier[] = [createLlmBatchTier(config.classifier.llm, systemPrompt, clientOptions)];
  if (config.classifier.fallbackLlm) {
    tiers.push(createLlmBatchTier(config.classifier.fallbackLlm, systemPrompt, clientOptions));
  }

  // Degradation chain, per email: primary LLM -> fallback LLM -> rule classifier.
  // A tier that fails outright hands the whole remaining set to the next tier;
  // a tier that answers only part of a batch (missing/invalid items,
  // docs/micro-batch.md section 13) gets one single-email retry for each of
  // those items before they move on to the next tier.
  async function classifyBatch(emails: EmailMessage[]): Promise<BatchClassificationResult[]> {
    const resolved = new Map<string, Classification>();
    const failures = new Map<string, string[]>();
    const noteFailure = (email: EmailMessage, message: string) => {
      failures.set(email.id, [...(failures.get(email.id) ?? []), message]);
    };

    let pending = emails;
    for (const [index, tier] of tiers.entries()) {
      if (pending.length === 0) break;
      const outcome = await classifyWithTier(tier, pending);
      for (const result of outcome.valid) resolved.set(result.emailId, result.classification);
      for (const [email, message] of outcome.failures) noteFailure(email, message);
      pending = outcome.remaining;
      if (pending.length > 0) {
        console.warn(
          `${tier.providerName} left ${pending.length}/${emails.length} email(s) unclassified; ` +
          `${index + 1 < tiers.length ? 'trying fallback classifier' : 'falling back to rules'}`
        );
      }
    }

    return emails.map((email) => {
      const classification = resolved.get(email.id);
      if (classification) return { emailId: email.id, classification };
      return {
        emailId: email.id,
        classification: {
          ...classifyEmail(email),
          provider: 'rule-fallback',
          reason: (failures.get(email.id) ?? []).join(' | ')
        }
      };
    });
  }

  return {
    async classify(email: EmailMessage): Promise<Classification> {
      const [result] = await classifyBatch([email]);
      if (!result) throw new Error('classifyBatch returned no result for a single email');
      return result.classification;
    },
    classifyBatch
  };
}

type BatchTier = {
  providerName: string;
  // One LLM request for the whole array. Throws when the request (after the
  // SDK's own retries) fails or the response is unusable as a batch; otherwise
  // returns the validated results plus the emails that still need a result.
  requestBatch(emails: EmailMessage[]): Promise<{
    valid: BatchClassificationResult[];
    retry: EmailMessage[];
    problems: BatchItemProblem[];
  }>;
};

type TierOutcome = {
  valid: BatchClassificationResult[];
  remaining: EmailMessage[];
  failures: [EmailMessage, string][];
};

async function classifyWithTier(tier: BatchTier, emails: EmailMessage[]): Promise<TierOutcome> {
  const valid: BatchClassificationResult[] = [];
  const remaining: EmailMessage[] = [];
  const failures: [EmailMessage, string][] = [];

  let first;
  try {
    first = await tier.requestBatch(emails);
  } catch (error) {
    const message = `${tier.providerName} failed: ${errorMessage(error)}`;
    console.warn(message);
    return { valid, remaining: emails, failures: emails.map((email) => [email, message]) };
  }

  valid.push(...first.valid);
  if (first.problems.length > 0) {
    console.warn(`${tier.providerName} batch of ${emails.length} had ${first.problems.length} problem(s): ${
      first.problems.map((problem) => `${problem.emailId ?? '?'}: ${problem.reason}`).join('; ')
    }`);
  }

  for (const email of first.retry) {
    // A batch of one that failed validation has nothing smaller to retry with.
    if (emails.length === 1) {
      remaining.push(email);
      failures.push([email, `${tier.providerName} returned no valid result: ${reasonFor(first.problems, email)}`]);
      continue;
    }
    try {
      const retried = await tier.requestBatch([email]);
      valid.push(...retried.valid);
      for (const stillFailing of retried.retry) {
        remaining.push(stillFailing);
        failures.push([stillFailing, `${tier.providerName} returned no valid result: ${reasonFor(retried.problems, stillFailing)}`]);
      }
    } catch (error) {
      remaining.push(email);
      failures.push([email, `${tier.providerName} failed: ${errorMessage(error)}`]);
    }
  }

  return { valid, remaining, failures };
}

function reasonFor(problems: BatchItemProblem[], email: EmailMessage): string {
  return problems.find((problem) => problem.emailId === email.id)?.reason ?? 'unknown problem';
}

function createLlmBatchTier(
  llm: LlmClassifierConfig,
  systemPrompt: string,
  clientOptions: { maxRetries: number; timeout: number }
): BatchTier {
  // maxRetries/timeout drive the SDK's exponential backoff with jitter, which
  // honors Retry-After on 429s and also retries timeouts/5xx/connection errors.
  const client = new OpenAI({
    baseURL: llm.baseUrl,
    apiKey: llm.apiKey,
    maxRetries: clientOptions.maxRetries,
    timeout: clientOptions.timeout
  });

  return {
    providerName: llm.providerName,
    async requestBatch(emails) {
      const completion = (await client.chat.completions.create({
        model: llm.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: buildBatchUserContent(emails) }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        stream: false
      } as Parameters<typeof client.chat.completions.create>[0])) as ChatCompletion;

      const text = completion.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(text) as { results?: unknown };
      const validation = validateBatchResults(emails, parsed?.results, llm.providerName);
      if (!validation.ok) {
        const detail = validation.duplicateEmailIds.length > 0 ? ` (${validation.duplicateEmailIds.join(', ')})` : '';
        throw new Error(`invalid batch response: ${validation.reason}${detail}`);
      }
      return validation;
    }
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildSystemPrompt(
  rulesPath: string,
  summaryLanguage: string | null,
  schemaHint: string,
  modeInstructions: string
): string {
  const languageInstruction = summaryLanguageInstruction(summaryLanguage);
  const base = [prompt, modeInstructions, schemaHint, languageInstruction].filter(Boolean).join('\n\n');
  const rules = loadUserRules(rulesPath);
  if (!rules) return base;

  return `${base}\n\nUSER RULES (highest priority — when these conflict with the general guidance above, follow the user rules). These are written by the inbox owner in natural language:\n${rules}`;
}

// Exported so the batch prompt shape can be unit tested.
export function buildBatchSystemPrompt(rulesPath: string, summaryLanguage: string | null): string {
  return buildSystemPrompt(rulesPath, summaryLanguage, BATCH_SCHEMA_HINT, BATCH_MODE_INSTRUCTIONS);
}

function loadUserRules(rulesPath: string): string {
  if (!rulesPath || !existsSync(rulesPath)) return '';
  return readFileSync(rulesPath, 'utf8').trim();
}

export function buildBatchUserContent(emails: EmailMessage[]): string {
  const payloads = emails.map((email) => ({ emailId: email.id, ...buildEmailPayload(email) }));
  return `EMAILS_JSON:\n${JSON.stringify(payloads, null, 2)}`;
}

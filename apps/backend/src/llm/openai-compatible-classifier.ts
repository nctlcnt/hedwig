import { existsSync, readFileSync } from 'node:fs';
import OpenAI from 'openai';
import type { ChatCompletion } from 'openai/resources/chat/completions';
import type { gmail_v1 } from 'googleapis';
import { classifyEmail, normalizeClassification } from '../classifier.js';
import type { AppConfig, EmailClassifier, EmailMessage, LlmClassifierConfig } from '../types.js';

const prompt = readFileSync(new URL('../../prompts/email-classifier.md', import.meta.url), 'utf8');

const SCHEMA_HINT = `Return a JSON object with this exact shape:
{
  "category": "action" | "fyi" | "course" | "admin" | "junk",
  "summary": "one or two compact sentences with concrete context in the email's natural language",
  "importance": integer 0-100,
  "confidence": number 0-1,
  "reason": "short factual reason"
}`;

export function createOpenAICompatibleClassifier(config: AppConfig): EmailClassifier {
  if (!config.classifier.llm.apiKey) {
    throw new Error('CLASSIFIER_API_KEY is required when CLASSIFIER_PROVIDER=openai-compatible');
  }

  const systemPrompt = buildSystemPrompt(config.classifier.rulesPath);
  const primary = createSingleLlmClassifier(config.classifier.llm, systemPrompt);
  const fallback = config.classifier.fallbackLlm
    ? createSingleLlmClassifier(config.classifier.fallbackLlm, systemPrompt)
    : null;

  return {
    async classify(email: EmailMessage) {
      const failures: string[] = [];
      try {
        return await primary.classify(email);
      } catch (error) {
        const message = `${config.classifier.llm.providerName} failed: ${errorMessage(error)}`;
        failures.push(message);
        console.warn(`${message}; ${fallback ? 'trying fallback classifier' : 'falling back to rules'}`);
      }

      if (fallback && config.classifier.fallbackLlm) {
        try {
          return await fallback.classify(email);
        } catch (error) {
          const message = `${config.classifier.fallbackLlm.providerName} failed: ${errorMessage(error)}`;
          failures.push(message);
          console.warn(`${message}; falling back to rules`);
        }
      }

      const ruled = classifyEmail(email);
      return {
        ...ruled,
        provider: 'rule-fallback',
        reason: failures.join(' | ')
      };
    }
  };
}

function createSingleLlmClassifier(llm: LlmClassifierConfig, systemPrompt: string): EmailClassifier {
  const client = new OpenAI({ baseURL: llm.baseUrl, apiKey: llm.apiKey });

  return {
    async classify(email: EmailMessage) {
      const completion = (await client.chat.completions.create({
        model: llm.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: buildUserContent(email) }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        stream: false
      } as Parameters<typeof client.chat.completions.create>[0])) as ChatCompletion;

      const text = completion.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(text);
      return normalizeClassification(email, parsed, llm.providerName);
    }
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildSystemPrompt(rulesPath: string): string {
  const base = `${prompt}\n\n${SCHEMA_HINT}`;
  const rules = loadUserRules(rulesPath);
  if (!rules) return base;

  return `${base}\n\nUSER RULES (highest priority — when these conflict with the general guidance above, follow the user rules). These are written by the inbox owner in natural language:\n${rules}`;
}

function loadUserRules(rulesPath: string): string {
  if (!rulesPath || !existsSync(rulesPath)) return '';
  return readFileSync(rulesPath, 'utf8').trim();
}

function buildUserContent(email: EmailMessage): string {
  const payload = {
    from: email.from,
    subject: email.subject,
    date: email.date?.toISOString?.() || null,
    headers: pickHeaders(email.headers),
    snippet: email.snippet,
    text: email.text.slice(0, 6000)
  };

  return `EMAIL_JSON:\n${JSON.stringify(payload, null, 2)}`;
}

function pickHeaders(headers: gmail_v1.Schema$MessagePartHeader[]) {
  const keep = new Set(['From', 'Subject', 'Date', 'List-Unsubscribe', 'Precedence', 'Auto-Submitted']);
  return headers
    .filter((header): header is gmail_v1.Schema$MessagePartHeader & { name: string } => (
      typeof header.name === 'string' && keep.has(header.name)
    ))
    .map((header) => ({ name: header.name, value: header.value }));
}

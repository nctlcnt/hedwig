import { readFileSync } from 'node:fs';
import OpenAI from 'openai';
import type { ChatCompletion } from 'openai/resources/chat/completions';
import type { gmail_v1 } from 'googleapis';
import { classifyEmail, normalizeClassification } from '../classifier.js';
import type { AppConfig, EmailClassifier, EmailMessage } from '../types.js';

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

  const client = new OpenAI({
    baseURL: config.classifier.llm.baseUrl,
    apiKey: config.classifier.llm.apiKey
  });

  return {
    async classify(email: EmailMessage) {
      try {
        const completion = (await client.chat.completions.create({
          model: config.classifier.llm.model,
          messages: [
            { role: 'system', content: `${prompt}\n\n${SCHEMA_HINT}` },
            { role: 'user', content: buildUserContent(email) }
          ],
          response_format: { type: 'json_object' },
          temperature: 0.2,
          stream: false
        } as Parameters<typeof client.chat.completions.create>[0])) as ChatCompletion;

        const text = completion.choices[0]?.message?.content || '{}';
        const parsed = JSON.parse(text);
        return normalizeClassification(email, parsed, config.classifier.llm.providerName);
      } catch (error) {
        console.warn(`${config.classifier.llm.providerName} classification failed; falling back to rules: ${error instanceof Error ? error.message : String(error)}`);
        const fallback = classifyEmail(email);
        return {
          ...fallback,
          provider: 'rule-fallback',
          reason: `${config.classifier.llm.providerName} failed: ${error instanceof Error ? error.message : String(error)}`
        };
      }
    }
  };
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

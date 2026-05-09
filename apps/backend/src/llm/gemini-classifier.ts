import { readFileSync } from 'node:fs';
import { GoogleGenAI } from '@google/genai';
import type { gmail_v1 } from 'googleapis';
import { classifyEmail, normalizeClassification } from '../classifier.js';
import type { AppConfig, EmailClassifier, EmailMessage } from '../types.js';

const prompt = readFileSync(new URL('../../prompts/email-classifier.md', import.meta.url), 'utf8');

const responseSchema = {
  type: 'object',
  properties: {
    category: {
      type: 'string',
      enum: ['action', 'fyi', 'course', 'admin', 'junk']
    },
    summary: {
      type: 'string',
      description: 'A concise 8-12 word English or Chinese summary.'
    },
    importance: {
      type: 'number',
      description: 'Integer-like score from 0 to 100.'
    },
    confidence: {
      type: 'number',
      description: 'Confidence from 0 to 1.'
    },
    reason: {
      type: 'string',
      description: 'Short reason for the category.'
    }
  },
  required: ['category', 'summary', 'importance', 'confidence', 'reason']
};

export function createGeminiClassifier(config: AppConfig): EmailClassifier {
  if (!config.classifier.gemini.apiKey) {
    throw new Error('GEMINI_API_KEY is required when CLASSIFIER_PROVIDER=gemini');
  }

  const ai = new GoogleGenAI({ apiKey: config.classifier.gemini.apiKey });

  return {
    async classify(email: EmailMessage) {
      try {
        const response = await ai.models.generateContent({
          model: config.classifier.gemini.model,
          contents: buildPrompt(email),
          config: {
            responseMimeType: 'application/json',
            responseSchema,
            temperature: 0.2
          }
        });
        const parsed = JSON.parse(response.text || '{}');
        return normalizeClassification(email, parsed, 'gemini');
      } catch (error) {
        console.warn(`Gemini classification failed; falling back to rules: ${error instanceof Error ? error.message : String(error)}`);
        const fallback = classifyEmail(email);
        return {
          ...fallback,
          provider: 'rule-fallback',
          reason: `Gemini failed: ${error instanceof Error ? error.message : String(error)}`
        };
      }
    }
  };
}

function buildPrompt(email: EmailMessage): string {
  const payload = {
    from: email.from,
    subject: email.subject,
    date: email.date?.toISOString?.() || null,
    headers: pickHeaders(email.headers),
    snippet: email.snippet,
    text: email.text.slice(0, 6000)
  };

  return `${prompt}\n\nEMAIL_JSON:\n${JSON.stringify(payload, null, 2)}`;
}

function pickHeaders(headers: gmail_v1.Schema$MessagePartHeader[]) {
  const keep = new Set(['From', 'Subject', 'Date', 'List-Unsubscribe', 'Precedence', 'Auto-Submitted']);
  return headers
    .filter((header): header is gmail_v1.Schema$MessagePartHeader & { name: string } => (
      typeof header.name === 'string' && keep.has(header.name)
    ))
    .map((header) => ({ name: header.name, value: header.value }));
}

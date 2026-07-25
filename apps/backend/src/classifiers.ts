import { classifyEmail } from './classifier.js';
import { createOpenAICompatibleClassifier } from './llm/openai-compatible-classifier.js';
import type { AppConfig, EmailClassifier } from './types.js';

export function createClassifier(config: AppConfig, summaryLanguage: string | null = null): EmailClassifier {
  if (config.classifier.provider === 'openai-compatible') {
    return createOpenAICompatibleClassifier(config, summaryLanguage);
  }

  if (config.classifier.provider !== 'rule') {
    throw new Error(`Unknown CLASSIFIER_PROVIDER: ${config.classifier.provider}`);
  }

  return {
    async classify(email) {
      return classifyEmail(email);
    }
  };
}

import { classifyEmail } from './classifier.js';
import { createOpenAICompatibleClassifier } from './llm/openai-compatible-classifier.js';
import type { AppConfig, EmailClassifier } from './types.js';

export function createClassifier(config: AppConfig): EmailClassifier {
  if (config.classifier.provider === 'openai-compatible') {
    return createOpenAICompatibleClassifier(config);
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

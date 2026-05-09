import { classifyEmail } from './classifier.js';
import { createGeminiClassifier } from './llm/gemini-classifier.js';
import type { AppConfig, EmailClassifier } from './types.js';

export function createClassifier(config: AppConfig): EmailClassifier {
  if (config.classifier.provider === 'gemini') {
    return createGeminiClassifier(config);
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

import { classifyEmail } from './classifier.js';
import { createDeepseekClassifier } from './llm/deepseek-classifier.js';
import type { AppConfig, EmailClassifier } from './types.js';

export function createClassifier(config: AppConfig): EmailClassifier {
  if (config.classifier.provider === 'deepseek') {
    return createDeepseekClassifier(config);
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

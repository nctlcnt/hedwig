import type { ClassifierFailure, DigestItem, DigestReport } from '../types.js';

export type OperationalAlert = { signature: string } & (
  | { kind: 'job-failure'; title: string; detail: string }
  | { kind: 'account-failure'; accountName: string; accountEmail: string; detail: string }
  | { kind: 'classifier-fallback'; account: string; failures: ClassifierFailure[]; reasons: string[] }
);

export type DeliveryPart = {
  key: string;
  after?: string;
  payload: object;
};

export type DeliveryRequest = {
  destination: string;
  parentMessageId: string | null;
  payload: object;
};

export class DeliveryError extends Error {
  constructor(
    readonly status: number | 'network' | 'invalid-response',
    readonly retryAfterMs = 0
  ) {
    super(typeof status === 'number' ? `HTTP ${status}` : status);
  }

  get retryable(): boolean {
    const { status } = this;
    return status === 'network' || status === 'invalid-response' || status === 408 || status === 429
      || (typeof status === 'number' && status >= 500 && status <= 599);
  }
}

export interface Notifier {
  readonly platform: string;
  readonly digestDestination: string;
  readonly realtimeDestination: string | null;
  // Null disables operational alerts for this destination.
  readonly alertCooldownMs: number | null;
  canDeliver?(): boolean;
  planDigest(digest: DigestReport): DeliveryPart[];
  planRealtime(item: DigestItem): DeliveryPart;
  deliver(request: DeliveryRequest): Promise<string>;
  sendOperationalAlert(alert: OperationalAlert): Promise<void>;
}

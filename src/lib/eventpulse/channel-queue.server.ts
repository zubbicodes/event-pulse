// Rate-aware delivery queues for chat channels (Telegram, Discord).
//
// A ticket drop on several targets at once can exceed Telegram's group limit (20 messages/minute)
// or Discord's webhook limit (~30 messages/minute). Each destination therefore gets one queue that
// paces requests below the provider limit and honours 429 retry_after. Rich ticket alerts (HTML,
// embeds, buttons) are always sent as their own message; plain operational notes that queued up
// while waiting are packed into as few messages as the length limit allows. Alerts are never
// dropped for being over the rate limit; they arrive in the next allowed message instead.

const MAX_RATE_LIMIT_RETRIES = 5;
const MAX_OUTAGE_RETRIES = 1;
const MAX_RETRY_AFTER_MS = 60_000;
const ITEM_SEPARATOR = "\n\n━━━━━━━━━━\n\n";

export type ChannelSendResult = {
  ok: boolean;
  status: number;
  retryAfterMs: number | null;
  detail: string;
};

// `rich` carries a provider-specific payload (Telegram HTML + button, Discord embed). The queue
// never merges rich messages; `text` is the plain fallback used for batching.
export type QueueMessage<Rich> = { text: string; rich?: Rich };

type ChannelQueueOptions<Rich> = {
  label: string;
  minIntervalMs: number;
  maxLength: number;
  header?: string;
  send: (message: QueueMessage<Rich>) => Promise<ChannelSendResult>;
};

type QueueItem<Rich> = {
  message: QueueMessage<Rich>;
  resolve: (sent: boolean) => void;
  errors: string[];
};

export class ChannelQueue<Rich = never> {
  private readonly items: QueueItem<Rich>[] = [];
  private nextAllowedAt = 0;
  private pumping = false;
  private readonly options: ChannelQueueOptions<Rich>;

  constructor(options: ChannelQueueOptions<Rich>) {
    this.options = options;
  }

  // Resolves true once the message is delivered, false if delivery failed.
  enqueue(message: string | QueueMessage<Rich>, errors: string[]) {
    const item: QueueMessage<Rich> = typeof message === "string" ? { text: message } : message;
    return new Promise<boolean>((resolve) => {
      this.items.push({ message: { ...item, text: this.fitItem(item.text) }, resolve, errors });
      void this.pump();
    });
  }

  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.items.length > 0) {
        const wait = this.nextAllowedAt - Date.now();
        if (wait > 0) await sleep(wait);

        const batch = this.takeBatch();
        await this.sendBatch(batch);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async sendBatch(batch: QueueItem<Rich>[]) {
    const first = batch[0]!.message;
    const message: QueueMessage<Rich> =
      first.rich !== undefined
        ? first
        : {
            text:
              (this.options.header ?? "") +
              batch.map((item) => item.message.text).join(ITEM_SEPARATOR),
          };

    for (let attempt = 0; ; attempt += 1) {
      let result: ChannelSendResult;
      try {
        result = await this.options.send(message);
      } catch (error) {
        result = {
          ok: false,
          status: 0,
          retryAfterMs: null,
          detail: error instanceof Error ? error.message : "Request failed.",
        };
      }
      this.nextAllowedAt = Date.now() + this.options.minIntervalMs;

      if (result.ok) {
        for (const item of batch) item.resolve(true);
        return;
      }

      // Rate limits are expected under load and always clear; outages get a short retry only, so
      // a provider being down cannot hold the monitor pass open.
      const retryLimit =
        result.status === 429
          ? MAX_RATE_LIMIT_RETRIES
          : result.status === 0 || result.status >= 500
            ? MAX_OUTAGE_RETRIES
            : 0;
      if (attempt < retryLimit) {
        const backoff = result.retryAfterMs ?? this.options.minIntervalMs * (attempt + 1);
        this.nextAllowedAt = Date.now() + Math.min(backoff, MAX_RETRY_AFTER_MS);
        await sleep(this.nextAllowedAt - Date.now());
        continue;
      }

      const failure = `${this.options.label} failed (${result.status || "network"}): ${result.detail}`;
      console.error(failure);
      for (const item of batch) {
        item.errors.push(failure);
        item.resolve(false);
      }
      return;
    }
  }

  private takeBatch() {
    const budget = this.options.maxLength - (this.options.header?.length ?? 0);
    const batch: QueueItem<Rich>[] = [this.items.shift()!];
    if (batch[0]!.message.rich !== undefined) return batch;
    let length = batch[0]!.message.text.length;
    while (this.items.length > 0) {
      const next = this.items[0]!.message;
      if (next.rich !== undefined) break;
      const nextLength = length + ITEM_SEPARATOR.length + next.text.length;
      if (nextLength > budget) break;
      batch.push(this.items.shift()!);
      length = nextLength;
    }
    return batch;
  }

  private fitItem(text: string) {
    const budget = this.options.maxLength - (this.options.header?.length ?? 0);
    return text.length <= budget ? text : `${text.slice(0, budget - 1)}…`;
  }
}

export function parseRetryAfterMs(response: Response, body: unknown) {
  const fromBody = readRetryAfterSeconds(body);
  if (fromBody != null) return Math.ceil(fromBody * 1000);
  const header = Number(response.headers.get("retry-after"));
  return Number.isFinite(header) && header > 0 ? Math.ceil(header * 1000) : null;
}

function readRetryAfterSeconds(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const record = body as { retry_after?: unknown; parameters?: { retry_after?: unknown } };
  // Telegram: { parameters: { retry_after } }, Discord: { retry_after } (seconds, may be float).
  const value = record.parameters?.retry_after ?? record.retry_after;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(ms, 0)));
}

import type { Platform, ProviderAdapter, ProviderPost, ProviderRequest } from "./domain.js";

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter?: string,
    readonly code = `PROVIDER_${status}`,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface FakeScenario {
  response?: ProviderPost[];
  error?: ProviderError;
  timeout?: boolean;
  delayMs?: number;
}

export class FakeProvider implements ProviderAdapter {
  private readonly scenarios: FakeScenario[];
  private requests = 0;
  readonly requestsByPlatform = new Map<Platform, number>();

  constructor(scenarios: FakeScenario[] = []) {
    this.scenarios = [...scenarios];
  }

  enqueue(...scenarios: FakeScenario[]): void {
    this.scenarios.push(...scenarios);
  }

  get requestCount(): number {
    return this.requests;
  }

  async fetchPosts({ connection, signal, window }: ProviderRequest): Promise<ProviderPost[]> {
    this.requests += 1;
    this.requestsByPlatform.set(connection.platform, (this.requestsByPlatform.get(connection.platform) ?? 0) + 1);
    const scenario = this.scenarios.shift() ?? { response: [] };

    if (scenario.timeout) {
      return await new Promise<ProviderPost[]>((_resolve, reject) => {
        const abort = () => reject(new DOMException("Provider request aborted", "AbortError"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    }
    if (scenario.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, scenario.delayMs);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("Provider request aborted", "AbortError"));
        }, { once: true });
      });
    }
    if (scenario.error) throw scenario.error;
    return (scenario.response ?? []).filter((post) => {
      const publishedAt = Date.parse(post.publishedAt);
      return publishedAt >= Date.parse(window.start) && publishedAt < Date.parse(window.end);
    });
  }
}

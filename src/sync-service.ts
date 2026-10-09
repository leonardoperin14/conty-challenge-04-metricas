import { z } from "zod";
import type { Clock } from "./clock.js";
import type { ProviderAdapter, ProviderPost, RetryPolicy, SyncRun, SyncWindow } from "./domain.js";
import { isRetryable, RequestTimeoutError, RetryAfterExceedsLimitError, RetryAfterUnrepresentableError, waitBeforeRetry } from "./retry.js";
import { Repository } from "./repository.js";

const providerPostSchema = z.object({
  externalPostId: z.string().min(1),
  publishedAt: z.string().datetime({ offset: true }),
  providerObservedAt: z.string().datetime({ offset: true }),
  views: z.number().int().safe().nonnegative(),
  likes: z.number().int().safe().nonnegative(),
  comments: z.number().int().safe().nonnegative(),
});

class InvalidProviderResponseError extends Error {
  readonly code = "INVALID_PROVIDER_RESPONSE";

  constructor() {
    super("Provider returned invalid metric data");
  }
}

export class SyncService {
  constructor(
    private readonly repository: Repository,
    private readonly provider: ProviderAdapter,
    private readonly clock: Clock,
    private readonly policy: RetryPolicy,
  ) {
    if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) throw new RangeError("maxAttempts must be a positive integer");
    if (![policy.baseDelayMs, policy.maxRetryDelayMs, policy.requestTimeoutMs].every(Number.isFinite)
      || policy.baseDelayMs < 0 || policy.maxRetryDelayMs < 0 || policy.requestTimeoutMs < 1) {
      throw new RangeError("Retry delays must be finite and non-negative, and timeout must be positive");
    }
  }

  async sync(connectionId: string, window: SyncWindow): Promise<SyncRun> {
    const connection = this.repository.getConnection(connectionId);
    if (!connection) throw new Error("CONNECTION_NOT_FOUND");

    const run = this.repository.createSyncRun(connectionId, window.start, window.end, this.clock.now().toISOString());
    let posts: ProviderPost[] | null = null;

    for (let attempt = 1; attempt <= this.policy.maxAttempts; attempt += 1) {
      this.repository.recordAttempt(run.id, attempt);
      try {
        const result = await this.fetchWithTimeout(connection, window);
        const parsed = z.array(providerPostSchema).safeParse(result);
        if (!parsed.success) throw new InvalidProviderResponseError();
        posts = parsed.data.map((post) => ({
          ...post,
          publishedAt: new Date(post.publishedAt).toISOString(),
          providerObservedAt: new Date(post.providerObservedAt).toISOString(),
        }));
        break;
      } catch (error) {
        if (!isRetryable(error)) {
          return this.finishFailed(run.id, error instanceof Error ? errorMessage(error) : "PROVIDER_ERROR");
        }
        if (attempt >= this.policy.maxAttempts) return this.finishFailed(run.id, "RETRIES_EXHAUSTED");
        try {
          await waitBeforeRetry(error, attempt, this.policy, this.clock);
        } catch (waitError) {
          if (waitError instanceof RetryAfterExceedsLimitError) {
            this.repository.finishRun(run.id, {
              status: "rate_limited",
              finishedAt: this.clock.now().toISOString(),
              errorCode: waitError.code,
              retryNotBefore: waitError.retryNotBefore,
            });
            return this.repository.getSyncRun(run.id)!;
          }
          if (waitError instanceof RetryAfterUnrepresentableError) return this.finishFailed(run.id, waitError.code);
          throw waitError;
        }
      }
    }

    try {
      const fetchedAt = this.clock.now().toISOString();
      this.repository.saveSyncResults(run.id, connectionId, posts ?? [], fetchedAt);
    } catch (error) {
      const code = error instanceof Error && error.message === "SNAPSHOT_IDENTITY_CONFLICT"
        ? "SNAPSHOT_IDENTITY_CONFLICT"
        : "PERSISTENCE_FAILED";
      return this.finishFailed(run.id, code);
    }
    return this.repository.getSyncRun(run.id)!;
  }

  private async fetchWithTimeout(connection: NonNullable<ReturnType<Repository["getConnection"]>>, window: SyncWindow): Promise<ProviderPost[]> {
    const controller = new AbortController();
    const timeoutWait = this.clock.schedule(this.policy.requestTimeoutMs);
    let timedOut = false;
    const timeout = timeoutWait.promise.then(() => {
      timedOut = true;
      controller.abort();
      throw new RequestTimeoutError();
    });
    const request = Promise.resolve().then(() => this.provider.fetchPosts({ connection, window, signal: controller.signal }));

    try {
      return await Promise.race([request, timeout]);
    } catch (error) {
      if (timedOut) throw new RequestTimeoutError();
      throw error;
    } finally {
      timeoutWait.cancel();
    }
  }

  private finishFailed(runId: string, errorCode: string): SyncRun {
    this.repository.finishRun(runId, {
      status: "failed",
      finishedAt: this.clock.now().toISOString(),
      errorCode,
    });
    return this.repository.getSyncRun(runId)!;
  }
}

function errorMessage(error: Error): string {
  if ("code" in error && typeof error.code === "string") return error.code;
  return "PROVIDER_ERROR";
}

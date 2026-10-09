import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FakeClock } from "../src/clock.js";
import type { ProviderPost, RetryPolicy } from "../src/domain.js";
import { FakeProvider, ProviderError, type FakeScenario } from "../src/provider.js";
import { Repository } from "../src/repository.js";
import { SyncService } from "../src/sync-service.js";

const window = {
  windowStart: "2026-09-01T00:00:00.000Z",
  windowEnd: "2026-10-01T00:00:00.000Z",
};

const defaults: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxRetryDelayMs: 5000,
  requestTimeoutMs: 3000,
};

function post(overrides: Partial<ProviderPost> = {}): ProviderPost {
  return {
    externalPostId: "video-123",
    publishedAt: "2026-09-25T10:00:00.000Z",
    providerObservedAt: "2026-09-30T12:00:00.000Z",
    views: 10000,
    likes: 700,
    comments: 50,
    ...overrides,
  };
}

function setup(scenarios: FakeScenario[], policy: Partial<RetryPolicy> = {}) {
  const repository = new Repository(":memory:");
  const clock = new FakeClock("2026-10-01T12:00:00.000Z");
  const provider = new FakeProvider(scenarios);
  const app = createApp(repository, new SyncService(repository, provider, clock, { ...defaults, ...policy }));
  return { repository, clock, provider, app };
}

async function createConnection(app: ReturnType<typeof createApp>): Promise<string> {
  const response = await app.request("/connections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform: "tiktok", externalAccountId: "creator-1", token: "secret-token" }),
  });
  expect(response.status).toBe(201);
  const body = await response.json() as { connection: { id: string; token?: string } };
  expect(body.connection.token).toBeUndefined();
  return body.connection.id;
}

async function syncRequest(app: ReturnType<typeof createApp>, connectionId: string, input = window): Promise<Response> {
  return await app.request(`/connections/${connectionId}/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Condition was not reached while driving the fake clock");
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("metric synchronization", () => {
  it("persists a first sync and exposes fetchedAt through the posts API", async () => {
    const { app, provider, repository } = setup([{ response: [post()] }]);
    const connectionId = await createConnection(app);

    const sync = await syncRequest(app, connectionId);
    expect(sync.status).toBe(200);
    const run = (await sync.json() as { syncRun: { status: string; attempts: number } }).syncRun;
    expect(run).toMatchObject({ status: "succeeded", attempts: 1, postsProcessed: 1 });

    const response = await app.request(`/connections/${connectionId}/posts`);
    const result = await response.json() as { posts: Array<{ metrics: ProviderPost & { fetchedAt: string } | null }>; totals: { views: number } };
    expect(result.totals.views).toBe(10000);
    expect(result.posts[0]?.metrics?.fetchedAt).toBe("2026-10-01T12:00:00.000Z");
    expect(provider.requestCount).toBe(1);
    repository.close();
  });

  it("deduplicates repeated posts and snapshots across overlapping windows without summing them", async () => {
    const repeated = post();
    const { app, repository } = setup([{ response: [repeated, repeated] }, { response: [repeated] }]);
    const connectionId = await createConnection(app);
    expect((await syncRequest(app, connectionId)).status).toBe(200);
    expect((await syncRequest(app, connectionId, {
      windowStart: "2026-09-20T00:00:00.000Z",
      windowEnd: "2026-10-01T00:00:00.000Z",
    })).status).toBe(200);

    const result = await (await app.request(`/connections/${connectionId}/posts`)).json() as {
      posts: unknown[];
      totals: { views: number; likes: number; comments: number };
    };
    expect(result.posts).toHaveLength(1);
    expect(result.totals).toEqual({ views: 10000, likes: 700, comments: 50 });
    repository.close();
  });

  it("uses the newest provider observation even when an older response arrives later", async () => {
    const newer = post({ providerObservedAt: "2026-09-30T12:00:00.000Z", views: 12000 });
    const older = post({ providerObservedAt: "2026-09-29T12:00:00.000Z", views: 9000 });
    const { app, repository } = setup([{ response: [newer] }, { response: [older] }]);
    const connectionId = await createConnection(app);
    await syncRequest(app, connectionId);
    await syncRequest(app, connectionId);
    const result = await (await app.request(`/connections/${connectionId}/posts`)).json() as {
      posts: Array<{ metrics: { views: number; providerObservedAt: string } }>;
    };
    expect(result.posts[0]?.metrics).toMatchObject({ views: 12000, providerObservedAt: newer.providerObservedAt });
    repository.close();
  });

  it("retries a timed out request and discards its late response", async () => {
    const { app, clock, provider, repository } = setup([{ timeout: true }, { response: [post()] }], {
      maxAttempts: 2,
      baseDelayMs: 500,
      requestTimeoutMs: 1000,
    });
    const connectionId = await createConnection(app);
    const responsePromise = syncRequest(app, connectionId);
    await waitUntil(() => provider.requestCount === 1 && clock.pendingWaits === 1);
    clock.advanceBy(1000);
    await waitUntil(() => clock.pendingWaits === 1);
    clock.advanceBy(500);

    const response = await responsePromise;
    const run = (await response.json() as { syncRun: { attempts: number; status: string } }).syncRun;
    expect(run).toMatchObject({ attempts: 2, status: "succeeded" });
    expect(provider.requestCount).toBe(2);
    repository.close();
  });

  it("stops at maxAttempts after transient failures", async () => {
    const { app, clock, provider, repository } = setup([
      { error: new ProviderError("unavailable", 503) },
      { error: new ProviderError("unavailable", 503) },
      { error: new ProviderError("unavailable", 503) },
    ], { maxAttempts: 3 });
    const connectionId = await createConnection(app);
    const responsePromise = syncRequest(app, connectionId);

    for (const [count, delay] of [[1, 500], [2, 1000]] as const) {
      await waitUntil(() => provider.requestCount === count && clock.pendingWaits === 1);
      clock.advanceBy(delay);
    }
    const response = await responsePromise;
    const run = (await response.json() as { syncRun: { attempts: number; status: string; errorCode: string } }).syncRun;
    expect(response.status).toBe(502);
    expect(run).toMatchObject({ attempts: 3, status: "failed", errorCode: "RETRIES_EXHAUSTED" });
    expect(provider.requestCount).toBe(3);
    repository.close();
  });

  it("waits the Retry-After duration before retrying a 429", async () => {
    const { app, clock, provider, repository } = setup([
      { error: new ProviderError("rate limited", 429, "3") },
      { response: [post()] },
    ]);
    const connectionId = await createConnection(app);
    const responsePromise = syncRequest(app, connectionId);
    await waitUntil(() => provider.requestCount === 1 && clock.pendingWaits === 1);

    clock.advanceBy(2999);
    await Promise.resolve();
    expect(provider.requestCount).toBe(1);
    clock.advanceBy(1);
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(provider.requestCount).toBe(2);
    expect(clock.now().toISOString()).toBe("2026-10-01T12:00:03.000Z");
    repository.close();
  });

  it("accepts Retry-After as an HTTP date using the injected clock", async () => {
    const { app, clock, provider, repository } = setup([
      { error: new ProviderError("rate limited", 429, "Thu, 01 Oct 2026 12:00:02 GMT") },
      { response: [post()] },
    ]);
    const connectionId = await createConnection(app);
    const responsePromise = syncRequest(app, connectionId);
    await waitUntil(() => provider.requestCount === 1 && clock.pendingWaits === 1);
    clock.advanceBy(2000);
    expect((await responsePromise).status).toBe(200);
    expect(provider.requestCount).toBe(2);
    repository.close();
  });

  it.each([
    ["IMF-fixdate", "Thu, 01 Oct 2026 12:00:02 GMT"],
    ["RFC 850 date", "Thursday, 01-Oct-26 12:00:02 GMT"],
    ["asctime date", "Thu Oct  1 12:00:02 2026"],
  ])("respects valid Retry-After HTTP-date format: %s", async (_format, retryAfter) => {
    const { app, clock, provider, repository } = setup([
      { error: new ProviderError("rate limited", 429, retryAfter) },
      { response: [post()] },
    ]);
    const connectionId = await createConnection(app);
    const startedAt = clock.now().getTime();
    const responsePromise = syncRequest(app, connectionId);
    await waitUntil(() => provider.requestCount === 1 && clock.pendingWaits === 1);

    clock.advanceBy(1999);
    await flushAsyncWork();
    const retriedBeforeDeadline = provider.requestCount > 1;
    if (provider.requestCount === 1) clock.advanceBy(1);
    await flushAsyncWork();
    if (provider.requestCount === 1) clock.advanceBy(4 * 60 * 60 * 1000);

    const response = await responsePromise;
    const run = (await response.json() as { syncRun: { attempts: number; status: string } }).syncRun;
    expect({
      retriedBeforeDeadline,
      elapsedMs: clock.now().getTime() - startedAt,
      run: { attempts: run.attempts, status: run.status },
      requestCount: provider.requestCount,
    }).toEqual({
      retriedBeforeDeadline: false,
      elapsedMs: 2000,
      run: { attempts: 2, status: "succeeded" },
      requestCount: 2,
    });
    repository.close();
  });

  it("interprets an RFC 850 two-digit year within 50 years using the injected clock", async () => {
    const retryAfter = "Wednesday, 30-Sep-76 12:00:02 GMT";
    const retryNotBefore = new Date(Date.parse("2076-09-30T12:00:02.000Z")).toISOString();
    const { app, clock, provider, repository } = setup([
      { error: new ProviderError("rate limited", 429, retryAfter) },
      { response: [post()] },
    ]);
    const connectionId = await createConnection(app);
    const response = await syncRequest(app, connectionId);
    const run = (await response.json() as { syncRun: { attempts: number; retryNotBefore: string; status: string } }).syncRun;

    expect(response.status).toBe(429);
    expect(run).toMatchObject({ attempts: 1, retryNotBefore, status: "rate_limited" });
    expect(provider.requestCount).toBe(1);
    expect(clock.pendingWaits).toBe(0);
    repository.close();
  });

  it.each([
    "-1",
    "2026-10-01T12:00:02Z",
    "October 1, 2026 12:00:02 GMT",
  ])("uses the backoff for invalid Retry-After syntax: %s", async (retryAfter) => {
    const { app, clock, provider, repository } = setup([
      { error: new ProviderError("rate limited", 429, retryAfter) },
      { response: [post()] },
    ]);
    const connectionId = await createConnection(app);
    const startedAt = clock.now().getTime();
    const responsePromise = syncRequest(app, connectionId);
    await waitUntil(() => provider.requestCount === 1 && clock.pendingWaits === 1);

    clock.advanceBy(499);
    await flushAsyncWork();
    const retriedBeforeBackoff = provider.requestCount > 1;
    if (provider.requestCount === 1) clock.advanceBy(1);
    await flushAsyncWork();
    if (provider.requestCount === 1) clock.advanceBy(1500);

    const response = await responsePromise;
    const run = (await response.json() as { syncRun: { attempts: number; status: string } }).syncRun;
    expect({
      retriedBeforeBackoff,
      elapsedMs: clock.now().getTime() - startedAt,
      run: { attempts: run.attempts, status: run.status },
      requestCount: provider.requestCount,
    }).toEqual({
      retriedBeforeBackoff: false,
      elapsedMs: 500,
      run: { attempts: 2, status: "succeeded" },
      requestCount: 2,
    });
    repository.close();
  });

  it("does not retry early when Retry-After exceeds the configured wait cap", async () => {
    const { app, clock, provider, repository } = setup([
      { error: new ProviderError("rate limited", 429, "10") },
      { response: [post()] },
    ], { maxRetryDelayMs: 5000 });
    const connectionId = await createConnection(app);
    const response = await syncRequest(app, connectionId);
    const run = (await response.json() as { syncRun: { status: string; retryNotBefore: string; attempts: number } }).syncRun;
    expect(response.status).toBe(429);
    expect(run).toMatchObject({ status: "rate_limited", attempts: 1, retryNotBefore: "2026-10-01T12:00:10.000Z" });
    expect(provider.requestCount).toBe(1);
    expect(clock.now().toISOString()).toBe("2026-10-01T12:00:00.000Z");
    repository.close();
  });

  it("keeps a representable long Retry-After as rate limited with its exact deadline", async () => {
    const retryAfterSeconds = 30 * 24 * 60 * 60;
    const retryNotBefore = new Date(Date.parse("2026-10-01T12:00:00.000Z") + retryAfterSeconds * 1000).toISOString();
    const { app, clock, provider, repository } = setup([
      { error: new ProviderError("rate limited", 429, String(retryAfterSeconds)) },
      { response: [post()] },
    ], { maxRetryDelayMs: 5000 });
    const connectionId = await createConnection(app);
    const response = await syncRequest(app, connectionId);
    const run = (await response.json() as { syncRun: { attempts: number; retryNotBefore: string; status: string } }).syncRun;

    expect(response.status).toBe(429);
    expect(run).toMatchObject({
      attempts: 1,
      retryNotBefore,
      status: "rate_limited",
    });
    expect(provider.requestCount).toBe(1);
    expect(clock.pendingWaits).toBe(0);
    expect(clock.now().toISOString()).toBe("2026-10-01T12:00:00.000Z");
    repository.close();
  });

  it("retries when Retry-After equals the configured wait limit", async () => {
    const { app, clock, provider, repository } = setup([
      { error: new ProviderError("rate limited", 429, "5") },
      { response: [post()] },
    ], { maxRetryDelayMs: 5000 });
    const connectionId = await createConnection(app);
    const startedAt = clock.now().getTime();
    const responsePromise = syncRequest(app, connectionId);
    await waitUntil(() => provider.requestCount === 1 && clock.pendingWaits === 1);

    clock.advanceBy(4999);
    await flushAsyncWork();
    expect(provider.requestCount).toBe(1);
    clock.advanceBy(1);
    const response = await responsePromise;
    const run = (await response.json() as { syncRun: { attempts: number; status: string } }).syncRun;

    expect(response.status).toBe(200);
    expect(run).toMatchObject({ attempts: 2, status: "succeeded" });
    expect(provider.requestCount).toBe(2);
    expect(clock.now().getTime() - startedAt).toBe(5000);
    repository.close();
  });

  it.each([
    ["30 digits with a finite Number", "9".repeat(30)],
    ["digits that overflow Number", "9".repeat(400)],
  ])("finishes with an explicit failure for Retry-After outside the Date range (%s)", async (_description, retryAfter) => {
    const { app, clock, provider, repository } = setup([
      { error: new ProviderError("rate limited", 429, retryAfter) },
      { response: [post()] },
    ]);
    const connectionId = await createConnection(app);
    const response = await syncRequest(app, connectionId);
    const runId = (repository.db.prepare("SELECT id FROM sync_runs LIMIT 1").get() as { id: string } | undefined)?.id;
    const run = runId ? repository.getSyncRun(runId) : null;

    expect({
      httpStatus: response.status,
      run: run && {
        attempts: run.attempts,
        errorCode: run.errorCode,
        finishedAt: run.finishedAt,
        retryNotBefore: run.retryNotBefore,
        startedAt: run.startedAt,
        status: run.status,
      },
      requestCount: provider.requestCount,
      pendingWaits: clock.pendingWaits,
    }).toEqual({
      httpStatus: 502,
      run: {
        attempts: 1,
        errorCode: "RETRY_AFTER_UNREPRESENTABLE",
        finishedAt: "2026-10-01T12:00:00.000Z",
        retryNotBefore: null,
        startedAt: "2026-10-01T12:00:00.000Z",
        status: "failed",
      },
      requestCount: 1,
      pendingWaits: 0,
    });
    repository.close();
  });

  it("accepts the largest whole-second Retry-After that still has a representable date", async () => {
    const startedAt = Date.parse("2026-10-01T12:00:00.000Z");
    const maxDateMs = 8.64e15;
    const retryAfterSeconds = Math.floor((maxDateMs - startedAt) / 1000);
    const retryNotBefore = new Date(startedAt + retryAfterSeconds * 1000).toISOString();
    const { app, clock, provider, repository } = setup([
      { error: new ProviderError("rate limited", 429, String(retryAfterSeconds)) },
      { response: [post()] },
    ], { maxRetryDelayMs: 5000 });
    const connectionId = await createConnection(app);
    const response = await syncRequest(app, connectionId);
    const run = (await response.json() as { syncRun: { attempts: number; retryNotBefore: string; status: string } }).syncRun;

    expect(response.status).toBe(429);
    expect(run).toMatchObject({ attempts: 1, retryNotBefore, status: "rate_limited" });
    expect(provider.requestCount).toBe(1);
    expect(clock.pendingWaits).toBe(0);
    expect(clock.now().toISOString()).toBe("2026-10-01T12:00:00.000Z");
    repository.close();
  });

  it("does not retry permanent provider errors", async () => {
    const { app, provider, repository } = setup([{ error: new ProviderError("invalid request", 400) }]);
    const connectionId = await createConnection(app);
    const response = await syncRequest(app, connectionId);
    const run = (await response.json() as { syncRun: { attempts: number; status: string; errorCode: string } }).syncRun;
    expect(response.status).toBe(502);
    expect(run).toMatchObject({ attempts: 1, status: "failed", errorCode: "PROVIDER_400" });
    expect(provider.requestCount).toBe(1);
    repository.close();
  });

  it("does not retry or persist an invalid provider response", async () => {
    const { app, provider, repository } = setup([{ response: [post({ views: -1 })] }]);
    const connectionId = await createConnection(app);
    const response = await syncRequest(app, connectionId);
    const run = (await response.json() as { syncRun: { status: string; errorCode: string } }).syncRun;
    const posts = await (await app.request(`/connections/${connectionId}/posts`)).json() as { posts: unknown[] };
    expect(run).toMatchObject({ status: "failed", errorCode: "INVALID_PROVIDER_RESPONSE" });
    expect(posts.posts).toHaveLength(0);
    expect(provider.requestCount).toBe(1);
    repository.close();
  });

  it("keeps concurrent overlapping syncs idempotent", async () => {
    const { app, provider, repository } = setup([{ response: [post()] }, { response: [post()] }]);
    const connectionId = await createConnection(app);
    const responses = await Promise.all([
      syncRequest(app, connectionId),
      syncRequest(app, connectionId, { windowStart: "2026-09-20T00:00:00.000Z", windowEnd: window.windowEnd }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const result = await (await app.request(`/connections/${connectionId}/posts`)).json() as {
      posts: unknown[];
      totals: { views: number };
    };
    expect(result.posts).toHaveLength(1);
    expect(result.totals.views).toBe(10000);
    expect(provider.requestCount).toBe(2);
    repository.close();
  });

  it("rejects invalid windows before calling the provider", async () => {
    const { app, provider, repository } = setup([]);
    const connectionId = await createConnection(app);
    const response = await syncRequest(app, connectionId, {
      windowStart: "2026-10-01T00:00:00.000Z",
      windowEnd: "2026-09-01T00:00:00.000Z",
    });
    expect(response.status).toBe(400);
    expect(provider.requestCount).toBe(0);
    repository.close();
  });
});

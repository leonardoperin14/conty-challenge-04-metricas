import type { RetryPolicy } from "./domain.js";
import { SystemClock } from "./clock.js";
import { createDemoProvider } from "./demo-fixtures.js";
import { createApp } from "./app.js";
import { Repository } from "./repository.js";
import { SyncService } from "./sync-service.js";

const repository = new Repository(":memory:");
const provider = createDemoProvider(process.argv[2] ?? "rate-limit");
const policy: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxRetryDelayMs: 5000,
  requestTimeoutMs: 3000,
};
const app = createApp(repository, new SyncService(repository, provider, new SystemClock(), policy));

try {
  const created = await app.request("/connections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform: "instagram", externalAccountId: "creator-demo", token: "fake-token" }),
  });
  const { connection } = await created.json() as { connection: { id: string } };
  const synced = await app.request(`/connections/${connection.id}/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ windowStart: "2026-09-01T00:00:00.000Z", windowEnd: "2026-11-01T00:00:00.000Z" }),
  });
  console.log(`Sync response: HTTP ${synced.status}`);
  console.log(JSON.stringify(await synced.json(), null, 2));
  const listed = await app.request(`/connections/${connection.id}/posts`);
  console.log("Current posts and metrics:");
  console.log(JSON.stringify(await listed.json(), null, 2));
} finally {
  repository.close();
}

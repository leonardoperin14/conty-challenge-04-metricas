import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { serve } from "@hono/node-server";
import type { RetryPolicy } from "./domain.js";
import { SystemClock } from "./clock.js";
import { Repository } from "./repository.js";
import { SyncService } from "./sync-service.js";
import { createApp } from "./app.js";
import { createDemoProvider } from "./demo-fixtures.js";

const databasePath = process.env.DB_PATH ?? "data/conty.sqlite";
mkdirSync(dirname(databasePath), { recursive: true });

const repository = new Repository(databasePath);
const provider = createDemoProvider(process.env.FAKE_PROVIDER_SCENARIO);
const clock = new SystemClock();
const policy: RetryPolicy = {
  maxAttempts: Number(process.env.MAX_ATTEMPTS ?? 3),
  baseDelayMs: Number(process.env.BASE_DELAY_MS ?? 500),
  maxRetryDelayMs: Number(process.env.MAX_RETRY_DELAY_MS ?? 5000),
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS ?? 3000),
};
const app = createApp(repository, new SyncService(repository, provider, clock, policy));
const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Metrics API listening on http://localhost:${info.port}`);
});

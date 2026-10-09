import { Hono } from "hono";
import { z } from "zod";
import { platforms } from "./domain.js";
import { Repository } from "./repository.js";
import { SyncService } from "./sync-service.js";

const connectionInput = z.object({
  platform: z.enum(platforms),
  externalAccountId: z.string().trim().min(1),
  token: z.string().min(1),
}).strict();

const windowInput = z.object({
  windowStart: z.string().datetime({ offset: true }),
  windowEnd: z.string().datetime({ offset: true }),
}).strict();

export function createApp(repository: Repository, syncService: SyncService) {
  const app = new Hono();

  app.post("/connections", async (context) => {
    const body: unknown = await context.req.json().catch(() => null);
    const parsed = connectionInput.safeParse(body);
    if (!parsed.success) return context.json({ error: "INVALID_REQUEST", details: parsed.error.issues.map((issue) => issue.path.join(".")) }, 400);

    try {
      const connection = repository.createConnection({ ...parsed.data, createdAt: new Date().toISOString() });
      return context.json({
        connection: {
          id: connection.id,
          platform: connection.platform,
          externalAccountId: connection.externalAccountId,
          createdAt: connection.createdAt,
        },
      }, 201);
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed: connections.platform")) {
        return context.json({ error: "CONNECTION_ALREADY_EXISTS" }, 409);
      }
      return context.json({ error: "PERSISTENCE_FAILED" }, 500);
    }
  });

  app.post("/connections/:id/sync", async (context) => {
    const body: unknown = await context.req.json().catch(() => null);
    const parsed = windowInput.safeParse(body);
    if (!parsed.success) return context.json({ error: "INVALID_REQUEST" }, 400);
    const start = Date.parse(parsed.data.windowStart);
    const end = Date.parse(parsed.data.windowEnd);
    if (start >= end) return context.json({ error: "INVALID_WINDOW" }, 400);

    const connectionId = context.req.param("id");
    if (!repository.getConnection(connectionId)) return context.json({ error: "CONNECTION_NOT_FOUND" }, 404);
    const syncRun = await syncService.sync(connectionId, {
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
    });
    const status = syncRun.status === "succeeded" ? 200 : syncRun.status === "rate_limited" ? 429 : 502;
    return context.json({ syncRun }, status);
  });

  app.get("/connections/:id/posts", (context) => {
    const connectionId = context.req.param("id");
    if (!repository.getConnection(connectionId)) return context.json({ error: "CONNECTION_NOT_FOUND" }, 404);
    const posts = repository.listPosts(connectionId);
    const totals = posts.reduce((sum, post) => {
      if (!post.metrics) return sum;
      sum.views += post.metrics.views;
      sum.likes += post.metrics.likes;
      sum.comments += post.metrics.comments;
      return sum;
    }, { views: 0, likes: 0, comments: 0 });
    return context.json({ posts, totals });
  });

  app.get("/sync-runs/:id", (context) => {
    const syncRun = repository.getSyncRun(context.req.param("id"));
    return syncRun ? context.json({ syncRun }) : context.json({ error: "SYNC_RUN_NOT_FOUND" }, 404);
  });

  return app;
}

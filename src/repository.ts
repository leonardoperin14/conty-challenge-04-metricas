import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Connection, Platform, ProviderPost, StoredPost, SyncRun, SyncStatus } from "./domain.js";

type SqlRow = Record<string, string | number | null>;

export class Repository {
  readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        external_account_id TEXT NOT NULL,
        token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(platform, external_account_id)
      );
      CREATE TABLE IF NOT EXISTS posts (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        external_post_id TEXT NOT NULL,
        published_at TEXT NOT NULL,
        UNIQUE(connection_id, external_post_id)
      );
      CREATE TABLE IF NOT EXISTS sync_runs (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES connections(id),
        window_start TEXT NOT NULL,
        window_end TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        retry_not_before TEXT,
        error_code TEXT,
        posts_processed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS metric_snapshots (
        id TEXT PRIMARY KEY,
        post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        provider_observed_at TEXT NOT NULL,
        views INTEGER NOT NULL CHECK(views >= 0),
        likes INTEGER NOT NULL CHECK(likes >= 0),
        comments INTEGER NOT NULL CHECK(comments >= 0),
        fetched_at TEXT NOT NULL,
        sync_run_id TEXT NOT NULL REFERENCES sync_runs(id),
        UNIQUE(post_id, provider_observed_at)
      );
      CREATE INDEX IF NOT EXISTS posts_connection_idx ON posts(connection_id);
      CREATE INDEX IF NOT EXISTS snapshots_current_idx ON metric_snapshots(post_id, provider_observed_at DESC);
    `);
  }

  createConnection(input: { platform: Platform; externalAccountId: string; token: string; createdAt: string }): Connection {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO connections (id, platform, external_account_id, token, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(id, input.platform, input.externalAccountId, input.token, input.createdAt);
    return { id, ...input };
  }

  getConnection(id: string): Connection | null {
    const row = this.db.prepare("SELECT * FROM connections WHERE id = ?").get(id) as SqlRow | undefined;
    return row ? connectionFrom(row) : null;
  }

  createSyncRun(connectionId: string, windowStart: string, windowEnd: string, startedAt: string): SyncRun {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO sync_runs (id, connection_id, window_start, window_end, status, started_at)
      VALUES (?, ?, ?, ?, 'running', ?)`).run(id, connectionId, windowStart, windowEnd, startedAt);
    return this.getSyncRun(id)!;
  }

  recordAttempt(id: string, attempts: number): void {
    this.db.prepare("UPDATE sync_runs SET attempts = ? WHERE id = ?").run(attempts, id);
  }

  finishRun(id: string, data: { status: Exclude<SyncStatus, "running">; finishedAt: string; errorCode?: string; retryNotBefore?: string; postsProcessed?: number }): void {
    this.db.prepare(`UPDATE sync_runs SET status = ?, finished_at = ?, error_code = ?,
      retry_not_before = ?, posts_processed = ? WHERE id = ?`).run(
      data.status,
      data.finishedAt,
      data.errorCode ?? null,
      data.retryNotBefore ?? null,
      data.postsProcessed ?? 0,
      id,
    );
  }

  getSyncRun(id: string): SyncRun | null {
    const row = this.db.prepare("SELECT * FROM sync_runs WHERE id = ?").get(id) as SqlRow | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      connectionId: String(row.connection_id),
      windowStart: String(row.window_start),
      windowEnd: String(row.window_end),
      status: String(row.status) as SyncStatus,
      attempts: Number(row.attempts),
      startedAt: String(row.started_at),
      finishedAt: row.finished_at === null ? null : String(row.finished_at),
      retryNotBefore: row.retry_not_before === null ? null : String(row.retry_not_before),
      errorCode: row.error_code === null ? null : String(row.error_code),
      postsProcessed: Number(row.posts_processed),
    };
  }

  saveSyncResults(runId: string, connectionId: string, posts: ProviderPost[], fetchedAt: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const findPost = this.db.prepare("SELECT id, published_at FROM posts WHERE connection_id = ? AND external_post_id = ?");
      const insertPost = this.db.prepare("INSERT INTO posts (id, connection_id, external_post_id, published_at) VALUES (?, ?, ?, ?)");
      const findSnapshot = this.db.prepare(`SELECT views, likes, comments FROM metric_snapshots
        WHERE post_id = ? AND provider_observed_at = ?`);
      const insertSnapshot = this.db.prepare(`INSERT INTO metric_snapshots
        (id, post_id, provider_observed_at, views, likes, comments, fetched_at, sync_run_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertRunUpdate = this.db.prepare("UPDATE sync_runs SET status = 'succeeded', finished_at = ?, posts_processed = ? WHERE id = ?");

      for (const post of posts) {
        const existingPost = findPost.get(connectionId, post.externalPostId) as SqlRow | undefined;
        const postId = existingPost ? String(existingPost.id) : randomUUID();
        if (!existingPost) insertPost.run(postId, connectionId, post.externalPostId, post.publishedAt);

        const existingSnapshot = findSnapshot.get(postId, post.providerObservedAt) as SqlRow | undefined;
        if (existingSnapshot) {
          const same = Number(existingSnapshot.views) === post.views
            && Number(existingSnapshot.likes) === post.likes
            && Number(existingSnapshot.comments) === post.comments;
          if (!same) throw new Error("SNAPSHOT_IDENTITY_CONFLICT");
          continue;
        }
        insertSnapshot.run(randomUUID(), postId, post.providerObservedAt, post.views, post.likes, post.comments, fetchedAt, runId);
      }

      insertRunUpdate.run(fetchedAt, new Set(posts.map((post) => post.externalPostId)).size, runId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listPosts(connectionId: string): StoredPost[] {
    const rows = this.db.prepare(`SELECT p.id, p.connection_id, p.external_post_id, p.published_at,
      s.views, s.likes, s.comments, s.provider_observed_at, s.fetched_at
      FROM posts p LEFT JOIN metric_snapshots s ON s.id = (
        SELECT latest.id FROM metric_snapshots latest
        WHERE latest.post_id = p.id ORDER BY latest.provider_observed_at DESC LIMIT 1
      ) WHERE p.connection_id = ? ORDER BY p.published_at, p.external_post_id`).all(connectionId) as SqlRow[];

    return rows.map((row) => ({
      id: String(row.id),
      connectionId: String(row.connection_id),
      externalPostId: String(row.external_post_id),
      publishedAt: String(row.published_at),
      metrics: row.provider_observed_at === null ? null : {
        views: Number(row.views),
        likes: Number(row.likes),
        comments: Number(row.comments),
        providerObservedAt: String(row.provider_observed_at),
        fetchedAt: String(row.fetched_at),
      },
    }));
  }

  close(): void {
    this.db.close();
  }
}

function connectionFrom(row: SqlRow): Connection {
  return {
    id: String(row.id),
    platform: String(row.platform) as Platform,
    externalAccountId: String(row.external_account_id),
    token: String(row.token),
    createdAt: String(row.created_at),
  };
}

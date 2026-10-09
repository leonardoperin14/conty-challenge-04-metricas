export const platforms = ["instagram", "tiktok", "youtube", "x"] as const;
export type Platform = (typeof platforms)[number];

export interface Connection {
  id: string;
  platform: Platform;
  externalAccountId: string;
  token: string;
  createdAt: string;
}

export interface ProviderPost {
  externalPostId: string;
  publishedAt: string;
  providerObservedAt: string;
  views: number;
  likes: number;
  comments: number;
}

export interface StoredPost {
  id: string;
  connectionId: string;
  externalPostId: string;
  publishedAt: string;
  metrics: {
    views: number;
    likes: number;
    comments: number;
    providerObservedAt: string;
    fetchedAt: string;
  } | null;
}

export type SyncStatus = "running" | "succeeded" | "failed" | "rate_limited";

export interface SyncRun {
  id: string;
  connectionId: string;
  windowStart: string;
  windowEnd: string;
  status: SyncStatus;
  attempts: number;
  startedAt: string;
  finishedAt: string | null;
  retryNotBefore: string | null;
  errorCode: string | null;
  postsProcessed: number;
}

export interface SyncWindow {
  start: string;
  end: string;
}

export interface ProviderRequest {
  connection: Connection;
  window: SyncWindow;
  signal: AbortSignal;
}

export interface ProviderAdapter {
  fetchPosts(request: ProviderRequest): Promise<ProviderPost[]>;
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxRetryDelayMs: number;
  requestTimeoutMs: number;
}


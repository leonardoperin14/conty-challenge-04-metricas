import { FakeProvider, ProviderError } from "./provider.js";
import type { ProviderPost } from "./domain.js";

export function samplePosts(observedAt = "2026-10-01T12:00:00.000Z"): ProviderPost[] {
  return [
    {
      externalPostId: "post-001",
      publishedAt: "2026-09-25T10:00:00.000Z",
      providerObservedAt: observedAt,
      views: 12500,
      likes: 840,
      comments: 73,
    },
    {
      externalPostId: "post-002",
      publishedAt: "2026-09-28T15:30:00.000Z",
      providerObservedAt: observedAt,
      views: 8200,
      likes: 530,
      comments: 41,
    },
  ];
}

export function createDemoProvider(scenario: string | undefined): FakeProvider {
  const posts = samplePosts();
  const success = { response: [...posts, posts[0]!] };
  switch (scenario ?? "success") {
    case "success":
      return new FakeProvider([success]);
    case "timeout-recovery":
      return new FakeProvider([{ timeout: true }, success]);
    case "transient-recovery":
      return new FakeProvider([{ error: new ProviderError("Temporary provider failure", 503) }, success]);
    case "rate-limit":
      return new FakeProvider([{ error: new ProviderError("Rate limited", 429, "2") }, success]);
    default:
      throw new Error(`Unknown FAKE_PROVIDER_SCENARIO: ${scenario}`);
  }
}

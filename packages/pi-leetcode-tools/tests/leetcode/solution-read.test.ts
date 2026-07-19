import { describe, expect, it } from "vitest";

import type { LeetCodeFetch } from "../../src/leetcode/read-adapter.js";
import { createLeetCodeReadAdapter } from "../../src/leetcode/read-adapter.js";

interface CapturedRequest {
  input: RequestInfo | URL;
  init: RequestInit | undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function fakeFetch(...responses: Response[]): {
  fetch: LeetCodeFetch;
  requests: CapturedRequest[];
} {
  const queue = [...responses];
  const requests: CapturedRequest[] = [];
  return {
    requests,
    fetch: async (input, init) => {
      requests.push({ input, init });
      const response = queue.shift();
      if (response === undefined) {
        throw new Error("Unexpected request");
      }
      return response;
    }
  };
}

function requestBody(request: CapturedRequest): Record<string, unknown> {
  if (typeof request.init?.body !== "string") {
    throw new Error("Expected a JSON request body");
  }
  return JSON.parse(request.init.body) as Record<string, unknown>;
}

describe("solution read adapter", () => {
  it("lists Global solution metadata with the correct MOST_RECENT enum", async () => {
    const transport = fakeFetch(
      jsonResponse({
        data: {
          ugcArticleSolutionArticles: {
            totalNum: 8,
            pageInfo: { hasNextPage: true },
            edges: [
              {
                node: {
                  title: "Hash map in one pass",
                  topicId: "12345",
                  summary: "  Store the complement while scanning.  ",
                  slug: "hash-map-in-one-pass",
                  canSee: true,
                  hasVideoArticle: false
                }
              },
              {
                node: {
                  title: "Hidden premium answer",
                  topicId: "99999",
                  slug: "hidden-premium-answer",
                  canSee: false,
                  hasVideoArticle: false
                }
              }
            ]
          }
        }
      })
    );
    const adapter = createLeetCodeReadAdapter("global", {
      fetch: transport.fetch
    });

    const result = await adapter.searchSolutions({
      region: "global",
      titleSlug: " Two-Sum ",
      limit: 2,
      offset: 1,
      orderBy: "MOST_RECENT",
      query: "  hash map  ",
      tags: ["C++", "Hash-Table"]
    });

    expect(result).toEqual({
      titleSlug: "two-sum",
      items: [
        {
          topicId: "12345",
          slug: "hash-map-in-one-pass",
          title: "Hash map in one pass",
          summary: "Store the complement while scanning.",
          canSee: true,
          hasVideoArticle: false
        }
      ],
      page: {
        offset: 1,
        limit: 2,
        totalKind: "exact",
        total: 8,
        hasMore: true
      }
    });
    expect(requestBody(transport.requests[0]!)).toMatchObject({
      operationName: "ugcArticleSolutionArticles",
      variables: {
        questionSlug: "two-sum",
        first: 2,
        skip: 1,
        orderBy: "MOST_RECENT",
        userInput: "hash map",
        tagSlugs: ["c++", "hash-table"]
      }
    });
    expect(
      (requestBody(transport.requests[0]!).variables as Record<string, unknown>)
        .orderBy
    ).not.toBe(" MOST_RECENT");
    const headers = new Headers(transport.requests[0]?.init?.headers);
    expect(headers.has("cookie")).toBe(false);
    expect(transport.requests[0]?.init?.cache).toBe("no-store");
  });

  it("lists CN solution metadata and derives hasMore without pageInfo", async () => {
    const transport = fakeFetch(
      jsonResponse({
        data: {
          questionSolutionArticles: {
            totalNum: 3,
            edges: [
              {
                node: {
                  slug: "liang-shu-zhi-he-ha-xi-biao",
                  canSee: true,
                  topic: { id: "67890" },
                  videosInfo: {
                    coverUrl: "https://pic.leetcode.cn/cover.png"
                  }
                }
              }
            ]
          }
        }
      })
    );
    const adapter = createLeetCodeReadAdapter("cn", { fetch: transport.fetch });

    const result = await adapter.searchSolutions({
      region: "cn",
      titleSlug: "two-sum"
    });

    expect(result).toEqual({
      titleSlug: "two-sum",
      items: [
        {
          topicId: "67890",
          slug: "liang-shu-zhi-he-ha-xi-biao",
          canSee: true,
          coverUrl: "https://pic.leetcode.cn/cover.png"
        }
      ],
      page: {
        offset: 0,
        limit: 10,
        totalKind: "exact",
        total: 3,
        hasMore: true
      }
    });
    const body = requestBody(transport.requests[0]!);
    expect(body).toMatchObject({
      operationName: "questionTopicsList",
      variables: {
        questionSlug: "two-sum",
        first: 10,
        skip: 0,
        orderBy: "DEFAULT",
        tagSlugs: []
      }
    });
    expect(body.query).toContain("questionSolutionArticles(");
    expect(body.variables).not.toHaveProperty("userInput");
  });

  it("accepts the CN videosInfo list response shape", async () => {
    const transport = fakeFetch(
      jsonResponse({
        data: {
          questionSolutionArticles: {
            totalNum: 2,
            edges: [
              {
                node: {
                  slug: "video-solution",
                  canSee: true,
                  topic: { id: "67890" },
                  videosInfo: [
                    { coverUrl: "https://pic.leetcode.cn/video-cover.png" }
                  ]
                }
              },
              {
                node: {
                  slug: "text-solution",
                  canSee: true,
                  topic: { id: "67891" },
                  videosInfo: []
                }
              }
            ]
          }
        }
      })
    );

    const result = await createLeetCodeReadAdapter("cn", {
      fetch: transport.fetch
    }).searchSolutions({ region: "cn", titleSlug: "two-sum" });

    expect(result.items).toEqual([
      {
        topicId: "67890",
        slug: "video-solution",
        canSee: true,
        coverUrl: "https://pic.leetcode.cn/video-cover.png"
      },
      {
        topicId: "67891",
        slug: "text-solution",
        canSee: true
      }
    ]);
  });

  it("rejects region-specific order values and invalid pagination before I/O", async () => {
    const transport = fakeFetch();
    const globalAdapter = createLeetCodeReadAdapter("global", {
      fetch: transport.fetch
    });
    const cnAdapter = createLeetCodeReadAdapter("cn", { fetch: transport.fetch });

    await expect(
      globalAdapter.searchSolutions({
        region: "global",
        titleSlug: "two-sum",
        orderBy: "MOST_UPVOTE"
      })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      cnAdapter.searchSolutions({
        region: "cn",
        titleSlug: "two-sum",
        orderBy: "MOST_VOTES"
      })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      cnAdapter.searchSolutions({
        region: "cn",
        titleSlug: "two-sum",
        limit: 51
      })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(transport.requests).toHaveLength(0);
  });

  it("reads a full Global solution by topicId", async () => {
    const transport = fakeFetch(
      jsonResponse({
        data: {
          ugcArticleSolutionArticle: {
            title: "One pass hash table",
            slug: "one-pass-hash-table",
            content: "# Idea\r\n\r\nUse `unordered_map`.\n",
            tags: [{ slug: "hash-table" }, { slug: "cpp" }],
            topic: { id: "12345" },
            prev: {
              uuid: "ignored",
              topicId: "12344",
              slug: "brute-force",
              title: "Brute force"
            },
            next: { topicId: "12346", slug: "two-pointers" }
          }
        }
      })
    );
    const adapter = createLeetCodeReadAdapter("global", {
      fetch: transport.fetch
    });

    await expect(
      adapter.getSolution({ region: "global", topicId: "12345" })
    ).resolves.toEqual({
      title: "One pass hash table",
      slug: "one-pass-hash-table",
      topicId: "12345",
      content: "# Idea\n\nUse `unordered_map`.\n",
      tags: ["hash-table", "cpp"],
      prev: {
        topicId: "12344",
        slug: "brute-force",
        title: "Brute force"
      },
      next: { topicId: "12346", slug: "two-pointers" }
    });
    expect(requestBody(transport.requests[0]!)).toMatchObject({
      operationName: "ugcArticleSolutionArticle",
      variables: { topicId: "12345" }
    });
    expect(new Headers(transport.requests[0]?.init?.headers).has("cookie")).toBe(
      false
    );
  });

  it("reads a full CN solution by slug and keeps question navigation", async () => {
    const transport = fakeFetch(
      jsonResponse({
        data: {
          solutionArticle: {
            title: "哈希表",
            slug: "liang-shu-zhi-he-ha-xi-biao",
            content: "使用哈希表记录补数。",
            tags: [{ slug: "hash-table" }, { slug: "hash-table" }],
            topic: { id: "67890" },
            question: { titleSlug: "two-sum" },
            prev: { slug: "bao-li-mei-ju" },
            next: { slug: "pai-xu-shuang-zhi-zhen" }
          }
        }
      })
    );
    const adapter = createLeetCodeReadAdapter("cn", { fetch: transport.fetch });

    await expect(
      adapter.getSolution({
        region: "cn",
        slug: "liang-shu-zhi-he-ha-xi-biao"
      })
    ).resolves.toEqual({
      title: "哈希表",
      slug: "liang-shu-zhi-he-ha-xi-biao",
      topicId: "67890",
      questionSlug: "two-sum",
      content: "使用哈希表记录补数。",
      tags: ["hash-table"],
      prev: { slug: "bao-li-mei-ju" },
      next: { slug: "pai-xu-shuang-zhi-zhen" }
    });
    const body = requestBody(transport.requests[0]!);
    expect(body).toMatchObject({
      operationName: "discussTopic",
      variables: { slug: "liang-shu-zhi-he-ha-xi-biao" }
    });
    expect(body.query).toContain("solutionArticle(slug: $slug, orderBy: DEFAULT)");
  });

  it("enforces the region-specific detail identifier", async () => {
    const transport = fakeFetch();
    const globalAdapter = createLeetCodeReadAdapter("global", {
      fetch: transport.fetch
    });
    const cnAdapter = createLeetCodeReadAdapter("cn", { fetch: transport.fetch });

    await expect(
      globalAdapter.getSolution({ region: "global", slug: "some-solution" })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      cnAdapter.getSolution({ region: "cn", topicId: "12345" })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      globalAdapter.getSolution({ region: "global", topicId: "not-numeric" })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(transport.requests).toHaveLength(0);
  });

  it("maps absent detail to NOT_FOUND", async () => {
    const transport = fakeFetch(
      jsonResponse({ data: { ugcArticleSolutionArticle: null } })
    );
    const adapter = createLeetCodeReadAdapter("global", {
      fetch: transport.fetch
    });

    await expect(
      adapter.getSolution({ region: "global", topicId: "12345" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("fails closed on malformed list fields and oversized answer text", async () => {
    const listTransport = fakeFetch(
      jsonResponse({
        data: {
          ugcArticleSolutionArticles: {
            totalNum: 1,
            pageInfo: { hasNextPage: false },
            edges: [{ node: { topicId: "12345", canSee: "yes" } }]
          }
        }
      })
    );
    const detailTransport = fakeFetch(
      jsonResponse({
        data: {
          ugcArticleSolutionArticle: {
            title: "Too large",
            slug: "too-large",
            content: "x".repeat(200_001),
            tags: [],
            topic: { id: "12345" }
          }
        }
      })
    );

    await expect(
      createLeetCodeReadAdapter("global", {
        fetch: listTransport.fetch
      }).searchSolutions({ region: "global", titleSlug: "two-sum" })
    ).rejects.toMatchObject({
      code: "REMOTE_SCHEMA_CHANGED",
      details: { field: "data.solutionArticles.edges[0].node.canSee" }
    });
    await expect(
      createLeetCodeReadAdapter("global", {
        fetch: detailTransport.fetch
      }).getSolution({ region: "global", topicId: "12345" })
    ).rejects.toMatchObject({
      code: "REMOTE_SCHEMA_CHANGED",
      details: { field: "data.solutionArticle.content" }
    });
  });
});

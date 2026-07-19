import { describe, expect, it, vi } from "vitest";

import type { LeetCodeFetch } from "../../src/leetcode/read-adapter.js";
import { takeNormalizationMeta } from "../../src/leetcode/adapters/read-normalization.js";
import {
  createLeetCodeReadAdapter,
  createLeetCodeReadAdapters
} from "../../src/leetcode/read-adapter.js";
import { DefaultTransportPolicy } from "../../src/runtime/transport-policy.js";

interface CapturedRequest {
  input: RequestInfo | URL;
  init: RequestInit | undefined;
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

function fakeFetch(...responses: Response[]): {
  fetch: LeetCodeFetch;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const queue = [...responses];
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

function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    questionId: "1",
    questionFrontendId: "1",
    title: "Two Sum",
    translatedTitle: "Two Sum CN",
    titleSlug: "two-sum",
    difficulty: "Easy",
    isPaidOnly: false,
    acRate: 54.25,
    status: null,
    topicTags: [
      {
        name: "Array",
        slug: "array",
        translatedName: "Array CN"
      }
    ],
    ...overrides
  };
}

function problemResource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...summary(),
    boundTopicId: null,
    content: "<p>Problem</p>",
    translatedContent: null,
    likes: 10,
    dislikes: 1,
    isLiked: null,
    similarQuestions: "[]",
    exampleTestcases: "[2,7,11,15]\n9",
    contributors: [],
    companyTagStats: null,
    codeSnippets: [],
    stats: "{}",
    hints: [],
    solution: null,
    sampleTestCase: "[2,7,11,15]\n9",
    metaData: "{}",
    judgerAvailable: true,
    judgeType: "large",
    mysqlSchemas: [],
    enableRunCode: true,
    enableTestMode: true,
    enableDebugger: false,
    envInfo: "{}",
    libraryUrl: null,
    adminUrl: null,
    challengeQuestion: null,
    note: null,
    ...overrides
  };
}

describe("LeetCode read adapters", () => {
  it("normalizes Global daily challenge and keeps the request unauthenticated", async () => {
    const regionalPayload = {
      date: "2026-07-15",
      link: "/problems/two-sum/?utm_source=tracking",
      question: problemResource({
        topicTags: [
          { name: "Array", slug: "array", translatedName: null }
        ]
      })
    };
    const transport = fakeFetch(
      jsonResponse({
        data: {
          activeDailyCodingChallengeQuestion: regionalPayload
        }
      })
    );
    const adapter = createLeetCodeReadAdapter("global", {
      fetch: transport.fetch,
      now: () => new Date("2026-07-15T23:59:59.000Z")
    });

    await expect(adapter.getDaily()).resolves.toEqual({
      date: "2026-07-15",
      link: "https://leetcode.com/problems/two-sum/",
      problem: {
        questionId: "1",
        frontendId: "1",
        title: "Two Sum",
        translatedTitle: "Two Sum CN",
        titleSlug: "two-sum",
        difficulty: "easy",
        paidOnly: false,
        acRate: 54.25,
        topicTags: [
          { name: "Array", slug: "array" }
        ]
      },
      regionalPayload
    });
    expect(String(transport.requests[0]?.input)).toBe(
      "https://leetcode.com/graphql/"
    );
    expect(requestBody(transport.requests[0]!)).toMatchObject({
      operationName: "dailyCodingChallengeV2",
      variables: {}
    });
    expect(new Headers(transport.requests[0]?.init?.headers).has("cookie")).toBe(
      false
    );
  });

  it("uses the CN operation and normalizes the CN field aliases", async () => {
    const regionalPayload = {
      date: "2026-07-16",
      userStatus: null,
      question: {
        questionId: "2",
        frontendQuestionId: "2",
        title: "Add Two Numbers",
        titleCn: "Add Two Numbers CN",
        titleSlug: "add-two-numbers",
        difficulty: "MEDIUM",
        paidOnly: false,
        acRate: 0.878,
        status: null,
        freqBar: null,
        isFavor: false,
        solutionNum: 10,
        hasVideoSolution: false,
        topicTags: [],
        extra: { topCompanyTags: [] }
      },
      lastSubmission: null
    };
    const transport = fakeFetch(
      jsonResponse({
        data: {
          todayRecord: [
            regionalPayload
          ]
        }
      })
    );
    const adapter = createLeetCodeReadAdapters({
      fetch: transport.fetch,
      now: () => new Date("2026-07-16T00:00:01.000Z")
    }).cn;

    const result = await adapter.getDaily();

    expect(result).toMatchObject({
      date: "2026-07-16",
      link: "https://leetcode.cn/problems/add-two-numbers/",
      problem: {
        frontendId: "2",
        titleSlug: "add-two-numbers",
        difficulty: "medium",
        acRate: 87.8
      },
      regionalPayload
    });
    expect(String(transport.requests[0]?.input)).toBe(
      "https://leetcode.cn/graphql/"
    );
    expect(requestBody(transport.requests[0]!)).toMatchObject({
      operationName: "questionOfToday"
    });
  });

  it("sends bounded search filters and normalizes status and pagination", async () => {
    const transport = fakeFetch(
      jsonResponse({
        data: {
          problemsetQuestionList: {
            total: 3,
            hasMore: true,
            questions: [summary({ status: "ac" })]
          }
        }
      })
    );
    const adapter = createLeetCodeReadAdapter("global", {
      fetch: transport.fetch
    });

    const result = await adapter.searchProblems({
      region: "global",
      category: "algorithms",
      query: "  two sum  ",
      tags: ["Array", "Hash-Table"],
      difficulty: "easy",
      limit: 1,
      offset: 1
    });

    expect(result.items[0]?.status).toBe("solved");
    expect(result.page).toEqual({
      offset: 1,
      limit: 1,
      totalKind: "exact",
      total: 3,
      hasMore: true
    });
    expect(requestBody(transport.requests[0]!)).toMatchObject({
      operationName: "problemsetQuestionList",
      variables: {
        categorySlug: "algorithms",
        limit: 1,
        skip: 1,
        filters: {
          searchKeywords: "two sum",
          tags: ["array", "hash-table"],
          difficulty: "EASY"
        }
      }
    });
  });

  it("uses the CN problemset query shape instead of the Global questionList field", async () => {
    const transport = fakeFetch(
      jsonResponse({
        data: {
          problemsetQuestionList: {
            total: 1,
            hasMore: false,
            questions: [
              {
                frontendQuestionId: "1",
                title: "Two Sum",
                titleCn: "Two Sum CN",
                titleSlug: "two-sum",
                difficulty: "EASY",
                paidOnly: false,
                acRate: 0.5,
                status: null,
                topicTags: [
                  { name: "Array", nameTranslated: "Array CN", slug: "array" }
                ]
              }
            ]
          }
        }
      })
    );
    const adapter = createLeetCodeReadAdapter("cn", { fetch: transport.fetch });

    const result = await adapter.searchProblems({ region: "cn" });

    expect(result.items[0]).toMatchObject({
      questionId: "1",
      translatedTitle: "Two Sum CN",
      acRate: 50,
      topicTags: [{ translatedName: "Array CN" }]
    });
    const query = requestBody(transport.requests[0]!).query;
    expect(query).toContain("problemsetQuestionList(");
    expect(query).not.toMatch(/\bquestionList\(/u);
  });

  it("sanitizes problem HTML, tracking links, and executable elements", async () => {
    const transport = fakeFetch(
      jsonResponse({
        data: {
          question: problemResource({
            content:
              '<p>Read <a href="https://tracker.invalid/x">this</a>.</p>' +
              '<script>secret-canary</script><style>.x{display:none}</style>' +
              '<p onclick="steal()">Then solve it.</p>',
            translatedContent: "<p>Translated content</p>",
            exampleTestcases: "[2,7,11,15]\n9",
            sampleTestCase: "  [2,7,11,15]\n9\n",
            enableRunCode: true,
            hints: ["<p>Use a hash map.</p>"],
            similarQuestions: JSON.stringify([
              { titleSlug: "three-sum", difficulty: "Medium" },
              { titleSlug: "four-sum", difficulty: "Hard" },
              { titleSlug: "two-sum-ii-input-array-is-sorted", difficulty: "Medium" },
              { titleSlug: "ignored-fourth", difficulty: "Easy" }
            ]),
            codeSnippets: [
              { lang: "C++", langSlug: "cpp", code: "class Solution {};" },
              { lang: "Python3", langSlug: "python3", code: "class Solution:\n    pass" },
              { lang: "Java", langSlug: "java", code: "class Solution {}" },
              { lang: "Go", langSlug: "golang", code: "func twoSum() {}" }
            ]
          })
        }
      })
    );
    const adapter = createLeetCodeReadAdapter("global", {
      fetch: transport.fetch
    });

    const result = await adapter.getProblem({
      region: "global",
      titleSlug: "two-sum",
      language: "python3",
      includeResourcePayload: true
    });

    expect(result.content).toContain("Read this.");
    expect(result.content).toContain("Then solve it.");
    expect(result.content).not.toContain("secret-canary");
    expect(result.content).not.toContain("tracker.invalid");
    expect(result.translatedContent).toBe("Translated content");
    expect(result.defaultTestcase).toBe("  [2,7,11,15]\n9\n");
    expect(result.exampleTestcases).toEqual(["[2,7,11,15]\n9"]);
    expect(result.availableLanguages).toEqual(["cpp", "go", "java", "python3"]);
    expect(result.selectedCodeSnippet).toEqual({
      language: "python3",
      languageName: "Python3",
      code: "class Solution:\n    pass"
    });
    expect(result.enableRunCode).toBe(true);
    expect(result.hints).toEqual(["Use a hash map."]);
    expect(result.similarQuestions).toEqual([
      { titleSlug: "three-sum", difficulty: "medium" },
      { titleSlug: "four-sum", difficulty: "hard" },
      { titleSlug: "two-sum-ii-input-array-is-sorted", difficulty: "medium" }
    ]);
    expect(result.codeSnippets.map((snippet) => snippet.language)).toEqual([
      "cpp",
      "python3",
      "java"
    ]);
    expect(result.resourcePayload).toMatchObject({
      questionId: "1",
      titleSlug: "two-sum",
      note: null,
      solution: null
    });
  });

  it("normalizes an arbitrary Global public profile without loading credentials", async () => {
    const credentialLookup = vi.fn();
    const transport = fakeFetch(
      jsonResponse({
        data: {
          matchedUser: {
            username: "public_user",
            githubUrl: "https://github.com/public-user",
            profile: {
              realName: "Public User",
              countryName: "Canada",
              company: "Example Co",
              school: "Example University",
              aboutMe: "Competitive programmer",
              userAvatar: "https://assets.example/avatar.png",
              ranking: 42
            },
            submitStats: {
              acSubmissionNum: [
                { difficulty: "All", count: 90, submissions: 100 }
              ],
              totalSubmissionNum: [
                { difficulty: "All", count: 100, submissions: 120 },
                { difficulty: "Easy", count: 50, submissions: 60 }
              ]
            }
          }
        }
      })
    );
    const adapter = createLeetCodeReadAdapter("global", {
      fetch: transport.fetch,
      credentialLookup
    });

    await expect(
      adapter.getUserProfile({ region: "global", username: "public_user" })
    ).resolves.toEqual({
      username: "public_user",
      realName: "Public User",
      avatar: "https://assets.example/avatar.png",
      aboutMe: "Competitive programmer",
      country: "Canada",
      company: "Example Co",
      school: "Example University",
      githubUrl: "https://github.com/public-user",
      ranking: 42,
      totalSubmissions: [
        { difficulty: "All", count: 100, submissions: 120 },
        { difficulty: "Easy", count: 50, submissions: 60 }
      ],
      acceptedQuestions: [{ difficulty: "All", count: 90, submissions: 100 }]
    });
    expect(credentialLookup).not.toHaveBeenCalled();
    expect(new Headers(transport.requests[0]?.init?.headers).has("cookie")).toBe(false);
    expect(requestBody(transport.requests[0]!)).toMatchObject({
      operationName: "userProfile",
      variables: { username: "public_user" }
    });
  });

  it("normalizes a CN public profile and uses the query's named operation", async () => {
    const transport = fakeFetch(
      jsonResponse({
        data: {
          userProfileUserQuestionProgress: {
            numAcceptedQuestions: [
              { difficulty: "All", count: 80 },
              { difficulty: "Easy", count: 40 }
            ],
            numFailedQuestions: [{ difficulty: "All", count: 7 }],
            numUntouchedQuestions: [{ difficulty: "All", count: 200 }]
          },
          userProfilePublicProfile: {
            siteRanking: 88,
            profile: {
              userSlug: "public-cn",
              realName: "公开用户",
              aboutMe: "算法学习者",
              userAvatar: "https://assets.example/cn-avatar.png",
              github: "https://github.com/public-cn",
              school: { name: "示例大学" },
              company: { name: "示例公司" },
              socialAccounts: [
                { provider: "GITHUB", profileUrl: "https://github.com/public-cn" },
                { provider: "BROKEN", profileUrl: null }
              ],
              skillSet: {
                topics: [{ slug: "dynamic-programming", name: "DP", translatedName: "动态规划" }],
                topicAreaScores: [{ score: 98.5, topicArea: { slug: "algorithms", name: "Algorithms" } }]
              },
              globalLocation: {
                country: "China",
                province: "Zhejiang",
                city: "Hangzhou",
                overseasCity: false
              }
            }
          }
        }
      })
    );
    const adapter = createLeetCodeReadAdapter("cn", { fetch: transport.fetch });

    await expect(
      adapter.getUserProfile({ region: "cn", username: "public-cn" })
    ).resolves.toEqual({
      username: "public-cn",
      realName: "公开用户",
      avatar: "https://assets.example/cn-avatar.png",
      aboutMe: "算法学习者",
      location: "China, Zhejiang, Hangzhou",
      company: "示例公司",
      school: "示例大学",
      githubUrl: "https://github.com/public-cn",
      siteRanking: 88,
      acceptedQuestions: [
        { difficulty: "All", count: 80 },
        { difficulty: "Easy", count: 40 }
      ],
      failedQuestions: [{ difficulty: "All", count: 7 }],
      untouchedQuestions: [{ difficulty: "All", count: 200 }],
      socialAccounts: [{ provider: "GITHUB", profileUrl: "https://github.com/public-cn" }],
      skillTopics: ["dynamic-programming"],
      topicAreaScores: [{ slug: "algorithms", score: 98.5 }]
    });
    expect(requestBody(transport.requests[0]!)).toMatchObject({
      operationName: "getUserProfile",
      variables: { username: "public-cn" }
    });
  });

  it("maps missing public profiles to NOT_FOUND for both regions", async () => {
    const globalTransport = fakeFetch(jsonResponse({ data: { matchedUser: null } }));
    const cnTransport = fakeFetch(
      jsonResponse({
        data: {
          userProfileUserQuestionProgress: null,
          userProfilePublicProfile: null
        }
      })
    );

    await expect(
      createLeetCodeReadAdapter("global", { fetch: globalTransport.fetch }).getUserProfile({
        region: "global",
        username: "missing-user"
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      createLeetCodeReadAdapter("cn", { fetch: cnTransport.fetch }).getUserProfile({
        region: "cn",
        username: "missing-user"
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("normalizes public contest rankings, filters attendance, and uses CN noj-go", async () => {
    const globalTransport = fakeFetch(
      jsonResponse({
        data: {
          userContestRanking: {
            attendedContestsCount: 2,
            rating: 1_500.5,
            globalRanking: 123,
            totalParticipants: 10_000,
            topPercentage: 1.23,
            badge: { name: "Guardian" }
          },
          userContestRankingHistory: [
            {
              attended: true,
              problemsSolved: 3,
              totalProblems: 4,
              finishTimeInSeconds: 3_600,
              rating: 1_500.5,
              ranking: 123,
              trendDirection: "UP",
              contest: { title: "Weekly Contest 1", startTime: 1_720_000_000 }
            },
            {
              attended: false,
              problemsSolved: 0,
              totalProblems: 4,
              contest: { title: "Weekly Contest 2", startTime: 1_720_086_400 }
            }
          ]
        }
      })
    );
    const global = createLeetCodeReadAdapter("global", { fetch: globalTransport.fetch });

    const globalResult = await global.getUserContest({
      region: "global",
      username: "public_user"
    });
    expect(globalResult).toEqual({
      username: "public_user",
      ranking: {
        attendedContestsCount: 2,
        rating: 1_500.5,
        globalRanking: 123,
        globalTotalParticipants: 10_000,
        topPercentage: 1.23,
        badge: "Guardian"
      },
      history: [
        {
          attended: true,
          title: "Weekly Contest 1",
          startTime: "2024-07-03T09:46:40.000Z",
          totalProblems: 4,
          solvedProblems: 3,
          finishTimeSeconds: 3_600,
          rating: 1_500.5,
          ranking: 123,
          trend: "UP"
        }
      ],
      page: { offset: 0, limit: 50, totalKind: "exact", total: 1, hasMore: false }
    });
    expect(new Headers(globalTransport.requests[0]?.init?.headers).has("cookie")).toBe(false);

    const cnTransport = fakeFetch(
      jsonResponse({
        data: {
          userContestRanking: {
            attendedContestsCount: 1,
            rating: 1_600,
            globalRanking: 100,
            localRanking: 10,
            globalTotalParticipants: 20_000,
            localTotalParticipants: 2_000,
            topPercentage: 0.5
          },
          userContestRankingHistory: [
            {
              attended: true,
              totalProblems: 4,
              finishTimeInSeconds: 1_800,
              rating: 1_600,
              score: 18,
              ranking: 10,
              trendingDirection: "DOWN",
              contest: {
                title: "Weekly Contest 3",
                titleCn: "第 3 场周赛",
                startTime: 1_720_000_000
              }
            },
            {
              attended: false,
              totalProblems: 4,
              contest: { title: "Weekly Contest 4", titleCn: "第 4 场周赛" }
            }
          ]
        }
      })
    );
    const cn = createLeetCodeReadAdapter("cn", { fetch: cnTransport.fetch });
    const cnResult = await cn.getUserContest({
      region: "cn",
      username: "public-cn",
      attendedOnly: false
    });

    expect(cnResult.history).toHaveLength(2);
    expect(cnResult).toMatchObject({
      username: "public-cn",
      ranking: {
        attendedContestsCount: 1,
        globalRanking: 100,
        localRanking: 10,
        globalTotalParticipants: 20_000,
        localTotalParticipants: 2_000
      },
      history: [
        { attended: true, translatedTitle: "第 3 场周赛", score: 18, trend: "DOWN" },
        { attended: false, translatedTitle: "第 4 场周赛" }
      ]
    });
    expect(String(cnTransport.requests[0]?.input)).toBe("https://leetcode.cn/graphql/noj-go/");
    expect(requestBody(cnTransport.requests[0]!)).toMatchObject({
      operationName: "userContestRankingInfo",
      variables: { username: "public-cn" }
    });
  });

  it("paginates complete public contest history without truncation metadata", async () => {
    const payload = {
      data: {
        userContestRanking: null,
        userContestRankingHistory: Array.from({ length: 51 }, (_, index) => ({
          attended: true,
          totalProblems: 4,
          contest: { title: `Weekly Contest ${index + 1}` }
        }))
      }
    };
    const transport = fakeFetch(
      jsonResponse(payload),
      jsonResponse(payload)
    );
    const adapter = createLeetCodeReadAdapter("global", { fetch: transport.fetch });

    const result = await adapter.getUserContest({
      region: "global",
      username: "public_user"
    });

    expect(result.history).toHaveLength(50);
    expect(result.page).toEqual({
      offset: 0,
      limit: 50,
      totalKind: "exact",
      total: 51,
      hasMore: true
    });
    expect(takeNormalizationMeta(result)).toBeUndefined();

    const tail = await adapter.getUserContest({
      region: "global",
      username: "public_user",
      offset: 50,
      limit: 1
    });
    expect(tail.history).toHaveLength(1);
    expect(tail.history[0]?.title).toBe("Weekly Contest 51");
    expect(tail.page.hasMore).toBe(false);
  });

  it("reads authenticated user status for both regions without exposing it as a public read", async () => {
    const credentialLookup = vi.fn(async (region: "global" | "cn") => ({
      profileId: `profile-${region}`,
      region,
      session: `${region}-session`,
      csrfToken: `${region}-csrf`
    }));
    const transport = fakeFetch(
      jsonResponse({
        data: {
          userStatus: {
            isSignedIn: true,
            username: "global_user",
            avatar: "https://assets.example/global.png",
            isAdmin: false
          }
        }
      }),
      jsonResponse({
        data: {
          userStatus: {
            isSignedIn: true,
            username: "中文昵称",
            userSlug: "cn_user",
            avatar: "https://assets.example/cn.png",
            isAdmin: true,
            useTranslation: true
          }
        }
      })
    );
    const adapters = createLeetCodeReadAdapters({
      fetch: transport.fetch,
      credentialLookup
    });

    await expect(adapters.global.getUserStatus()).resolves.toEqual({
      isSignedIn: true,
      username: "global_user",
      avatar: "https://assets.example/global.png",
      isAdmin: false
    });
    await expect(adapters.cn.getUserStatus()).resolves.toEqual({
      isSignedIn: true,
      username: "cn_user",
      displayName: "中文昵称",
      avatar: "https://assets.example/cn.png",
      isAdmin: true,
      useTranslation: true
    });
    expect(credentialLookup).toHaveBeenNthCalledWith(1, "global");
    expect(credentialLookup).toHaveBeenNthCalledWith(2, "cn");
    expect(String(transport.requests[0]?.input)).toBe("https://leetcode.com/graphql/");
    expect(String(transport.requests[1]?.input)).toBe("https://leetcode.cn/graphql/");
    expect(new Headers(transport.requests[1]?.init?.headers).get("cookie")).toBe(
      "LEETCODE_SESSION=cn-session; csrftoken=cn-csrf"
    );
  });

  it("normalizes a signed-out user status without stale account identity", async () => {
    const transport = fakeFetch(
      jsonResponse({
        data: {
          userStatus: {
            isSignedIn: false,
            username: "stale-display-name",
            avatar: "https://assets.example/stale.png",
            isAdmin: false
          }
        }
      })
    );
    const adapter = createLeetCodeReadAdapter("global", {
      fetch: transport.fetch,
      credentialLookup: async () => ({
        profileId: "profile-global",
        region: "global",
        session: "expired-session",
        csrfToken: "expired-csrf"
      })
    });

    await expect(adapter.getUserStatus()).resolves.toEqual({
      isSignedIn: false,
      isAdmin: false
    });
  });

  it("treats a null contest history as an empty public history", async () => {
    const transport = fakeFetch(
      jsonResponse({
        data: {
          userContestRanking: null,
          userContestRankingHistory: null
        }
      })
    );
    const adapter = createLeetCodeReadAdapter("global", { fetch: transport.fetch });

    await expect(
      adapter.getUserContest({ region: "global", username: "public_user" })
    ).resolves.toEqual({
      username: "public_user",
      history: [],
      page: { offset: 0, limit: 50, totalKind: "exact", total: 0, hasMore: false }
    });
  });

  it("fails closed for missing, expired, and schema-drifted user status auth", async () => {
    const noAuthFetch = vi.fn<LeetCodeFetch>();
    await expect(
      createLeetCodeReadAdapter("global", { fetch: noAuthFetch }).getUserStatus()
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(noAuthFetch).not.toHaveBeenCalled();

    const credentials = () => ({
      profileId: "profile-global",
      region: "global" as const,
      session: "session-token",
      csrfToken: "csrf-token"
    });
    const expired = fakeFetch(
      jsonResponse({ errors: [{ message: "Login required secret-canary" }], data: null })
    );
    await expect(
      createLeetCodeReadAdapter("global", {
        fetch: expired.fetch,
        credentialLookup: credentials
      }).getUserStatus()
    ).rejects.toMatchObject({ code: "AUTH_EXPIRED" });

    const drift = fakeFetch(
      jsonResponse({ data: { userStatus: { isSignedIn: true, isAdmin: "no" } } })
    );
    await expect(
      createLeetCodeReadAdapter("global", {
        fetch: drift.fetch,
        credentialLookup: credentials
      }).getUserStatus()
    ).rejects.toMatchObject({
      code: "REMOTE_SCHEMA_CHANGED",
      details: { field: "data.userStatus.isAdmin" }
    });
  });

  it("loads region-scoped credentials only for progress and normalizes sparse progress", async () => {
    const credentialLookup = vi.fn(async () => ({
      profileId: "profile-a",
      region: "global" as const,
      session: "session-token",
      csrfToken: "csrf-token"
    }));
    const transport = fakeFetch(
      jsonResponse({
        data: {
          userProgressQuestionList: {
            totalNum: 2,
            questions: [
              {
                difficulty: "MEDIUM",
                frontendId: "2",
                lastSubmittedAt: "1720000000",
                numSubmitted: 3,
                questionStatus: "ATTEMPTED",
                title: "Add Two Numbers",
                titleSlug: "add-two-numbers",
                translatedTitle: "Add Two Numbers CN"
              }
            ]
          }
        }
      })
    );
    const adapter = createLeetCodeReadAdapter("global", {
      fetch: transport.fetch,
      credentialLookup
    });

    const result = await adapter.getProgress({
      region: "global",
      status: "attempted",
      difficulty: ["medium", "hard"],
      limit: 1,
      offset: 0
    });

    expect(credentialLookup).toHaveBeenCalledWith("global");
    const headers = new Headers(transport.requests[0]?.init?.headers);
    expect(headers.get("cookie")).toBe(
      "LEETCODE_SESSION=session-token; csrftoken=csrf-token"
    );
    expect(headers.get("x-csrftoken")).toBe("csrf-token");
    expect(requestBody(transport.requests[0]!)).toMatchObject({
      operationName: "userProgressQuestionList",
      variables: {
        filters: {
          skip: 0,
          limit: 1,
          questionStatus: "ATTEMPTED",
          difficulty: ["MEDIUM", "HARD"]
        }
      }
    });
    expect(result.items[0]).toMatchObject({
      frontendId: "2",
      titleSlug: "add-two-numbers",
      difficulty: "medium",
      status: "attempted",
      topicTags: [],
      numSubmitted: 3,
      lastSubmittedAt: "2024-07-03T09:46:40.000Z"
    });
    expect(result.filters).toEqual({
      offset: 0,
      limit: 1,
      questionStatus: "ATTEMPTED",
      difficulty: ["MEDIUM", "HARD"]
    });
    expect(result.page.hasMore).toBe(true);
  });

  it("supports an absent optional CSRF token without emitting an empty header", async () => {
    const transport = fakeFetch(
      jsonResponse({
        data: {
          submissionList: { lastKey: null, hasNext: false, submissions: [] }
        }
      })
    );
    const adapter = createLeetCodeReadAdapter("global", {
      fetch: transport.fetch,
      credentialLookup: () => ({
        profileId: "profile-a",
        region: "global",
        session: "session-token",
        csrfToken: ""
      })
    });

    await adapter.getHistory({ region: "global", titleSlug: "two-sum" });

    const headers = new Headers(transport.requests[0]?.init?.headers);
    expect(headers.get("cookie")).toBe("LEETCODE_SESSION=session-token");
    expect(headers.has("x-csrftoken")).toBe(false);
    const body = requestBody(transport.requests[0]!);
    expect(body.variables).not.toHaveProperty("lastKey");
    expect(body.query).not.toContain("$lastKey");
  });

  it("normalizes cursor-based submission history without inventing an exact total", async () => {
    const transport = fakeFetch(
      jsonResponse({
        data: {
          submissionList: {
            lastKey: "next-page-key",
            hasNext: true,
            submissions: [
              {
                id: "123",
                title: "Two Sum",
                statusDisplay: "Accepted",
                lang: "python3",
                timestamp: 1720000000,
                runtime: "42 ms",
                memory: "18.1 MB",
                isPending: "Not Pending"
              }
            ]
          }
        }
      })
    );
    const adapter = createLeetCodeReadAdapter("cn", {
      fetch: transport.fetch,
      credentialLookup: () => ({
        profileId: "profile-cn",
        region: "cn",
        session: "cn-session",
        csrfToken: "cn-csrf"
      })
    });

    const result = await adapter.getHistory({
      region: "cn",
      titleSlug: "two-sum",
      limit: 1,
      offset: 4,
      cursor: "current-page-key"
    });

    expect(result.items[0]).toEqual({
      id: "123",
      title: "Two Sum",
      titleSlug: "two-sum",
      language: "python3",
      status: "Accepted",
      timestamp: "2024-07-03T09:46:40.000Z",
      runtime: "42 ms",
      memory: "18.1 MB",
      pending: false
    });
    expect(result.page).toEqual({
      offset: 4,
      limit: 1,
      totalKind: "lower_bound",
      total: 6,
      hasMore: true,
      nextCursor: "next-page-key"
    });
    expect(requestBody(transport.requests[0]!)).toMatchObject({
      variables: {
        offset: 4,
        limit: 1,
        lastKey: "current-page-key",
        questionSlug: "two-sum"
      }
    });
    expect(requestBody(transport.requests[0]!).query).toContain("$lastKey");
  });

  it("supports authenticated account-wide history and CN-only filters", async () => {
    const transport = fakeFetch(
      jsonResponse({
        data: {
          submissionList: {
            lastKey: null,
            hasNext: false,
            submissions: [
              {
                id: "456",
                title: "Two Sum",
                statusDisplay: "Accepted",
                lang: "cpp",
                timestamp: 1720000000,
                frontendId: "1"
              }
            ]
          }
        }
      })
    );
    const adapter = createLeetCodeReadAdapter("cn", {
      fetch: transport.fetch,
      credentialLookup: () => ({
        profileId: "profile-cn",
        region: "cn",
        session: "cn-session",
        csrfToken: "cn-csrf"
      })
    });

    const result = await adapter.getHistory({
      region: "cn",
      scope: "account",
      language: "cpp",
      status: "accepted",
      limit: 5,
      offset: 0,
      cursor: "remote-key"
    });

    expect(result.items[0]).toEqual({
      id: "456",
      title: "Two Sum",
      frontendId: "1",
      language: "cpp",
      status: "Accepted",
      timestamp: "2024-07-03T09:46:40.000Z"
    });
    expect(requestBody(transport.requests[0]!)).toMatchObject({
      variables: {
        offset: 0,
        limit: 5,
        lastKey: "remote-key",
        questionSlug: null,
        lang: "cpp",
        status: "AC"
      }
    });
  });

  it("rejects CN-only filters on Global history instead of filtering one page locally", async () => {
    const adapter = createLeetCodeReadAdapter("global", {
      fetch: fakeFetch().fetch,
      credentialLookup: () => ({
        profileId: "profile-global",
        region: "global",
        session: "session",
        csrfToken: "csrf"
      })
    });

    await expect(
      adapter.getHistory({ region: "global", scope: "account", status: "accepted" })
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
  });

  it("reads public Global recent submissions without credentials", async () => {
    const transport = fakeFetch(
      jsonResponse({
        data: {
          recentSubmissionList: [
            {
              title: "Two Sum",
              titleSlug: "two-sum",
              timestamp: "1720000000",
              statusDisplay: "Wrong Answer",
              lang: "python3"
            }
          ]
        }
      })
    );
    const adapter = createLeetCodeReadAdapter("global", { fetch: transport.fetch });

    const result = await adapter.getUserSubmissions({
      region: "global",
      username: "public_user",
      mode: "recent",
      limit: 10
    });

    expect(result).toMatchObject({
      username: "public_user",
      mode: "recent",
      items: [
        {
          title: "Two Sum",
          titleSlug: "two-sum",
          language: "python3",
          status: "Wrong Answer",
          timestamp: "2024-07-03T09:46:40.000Z"
        }
      ]
    });
    expect(new Headers(transport.requests[0]?.init?.headers).has("cookie")).toBe(false);
    expect(requestBody(transport.requests[0]!)).toMatchObject({
      operationName: "recentSubmissions",
      variables: { username: "public_user", limit: 10 }
    });
  });

  it("uses the CN noj-go endpoint for public accepted submissions", async () => {
    const transport = fakeFetch(
      jsonResponse({
        data: {
          recentACSubmissions: [
            {
              submissionId: "789",
              submitTime: 1720000000,
              question: {
                title: "Two Sum",
                translatedTitle: "两数之和",
                titleSlug: "two-sum",
                questionFrontendId: "1"
              }
            }
          ]
        }
      })
    );
    const adapter = createLeetCodeReadAdapter("cn", { fetch: transport.fetch });

    const result = await adapter.getUserSubmissions({
      region: "cn",
      username: "public-cn",
      mode: "accepted",
      limit: 1
    });

    expect(String(transport.requests[0]?.input)).toBe("https://leetcode.cn/graphql/noj-go/");
    expect(result.items[0]).toEqual({
      id: "789",
      title: "两数之和",
      titleSlug: "two-sum",
      frontendId: "1",
      status: "Accepted",
      timestamp: "2024-07-03T09:46:40.000Z"
    });
    expect(requestBody(transport.requests[0]!)).toMatchObject({
      variables: { username: "public-cn" }
    });
  });

  it("keeps submission code opt-in and preserves source bytes", async () => {
    const source = "  class Solution {\n\tpublic: int answer = 42;\n};\n";
    const transport = fakeFetch(
      jsonResponse({
        data: {
          submissionDetails: {
            id: 123,
            runtimeDisplay: "0 ms",
            memoryDisplay: "8 MB",
            runtimePercentile: 100,
            memoryPercentile: 99.5,
            code: source,
            timestamp: 1720000000,
            statusCode: 10,
            lang: { name: "cpp", verboseName: "C++" },
            question: { questionId: "1", titleSlug: "two-sum" },
            totalCorrect: 63,
            totalTestcases: 63,
            stdOutput: ""
          }
        }
      }),
      jsonResponse({
        data: {
          submissionDetails: {
            id: 123,
            runtimeDisplay: "0 ms",
            memoryDisplay: "8 MB",
            runtimePercentile: 100,
            memoryPercentile: 99.5,
            code: source,
            timestamp: 1720000000,
            statusCode: 10,
            lang: { name: "cpp", verboseName: "C++" },
            question: { questionId: "1", titleSlug: "two-sum" },
            totalCorrect: 63,
            totalTestcases: 63
          }
        }
      })
    );
    const adapter = createLeetCodeReadAdapter("global", {
      fetch: transport.fetch,
      credentialLookup: () => ({
        profileId: "profile-global",
        region: "global",
        session: "session",
        csrfToken: ""
      })
    });

    const metadata = await adapter.getSubmissionDetail({
      region: "global",
      submissionId: "123",
      includeCode: false
    });
    const withCode = await adapter.getSubmissionDetail({
      region: "global",
      submissionId: "123",
      includeCode: true
    });

    expect(metadata).not.toHaveProperty("code");
    expect(metadata).toMatchObject({
      id: "123",
      titleSlug: "two-sum",
      language: "cpp",
      statusCode: "10",
      passedTestCases: 63,
      totalTestCases: 63
    });
    expect(withCode.code).toBe(source);
    expect(requestBody(transport.requests[0]!)).toMatchObject({
      variables: { id: 123, includeCode: false }
    });
    expect(requestBody(transport.requests[1]!)).toMatchObject({
      variables: { id: 123, includeCode: true }
    });
  });

  it("does not choose a code template implicitly and marks bounded omissions", async () => {
    const tags = Array.from({ length: 101 }, (_, index) => ({
      name: `Tag ${index}`,
      slug: `tag-${index}`
    }));
    const transport = fakeFetch(
      jsonResponse({
        data: {
          question: summary({
            topicTags: tags,
            content: "<p>Problem</p>",
            sampleTestCase: "  1\n2  ",
            exampleTestcases: "1\n2",
            enableRunCode: true,
            codeSnippets: [
              { lang: "Go", langSlug: "golang", code: "func solve() {}" },
              { lang: "Future", langSlug: "future-lang", code: "future" }
            ]
          })
        }
      })
    );
    const adapter = createLeetCodeReadAdapter("cn", { fetch: transport.fetch });

    const result = await adapter.getProblem({ region: "cn", titleSlug: "two-sum" });

    expect(result.defaultTestcase).toBe("  1\n2  ");
    expect(result.availableLanguages).toEqual(["go"]);
    expect(result.selectedCodeSnippet).toBeNull();
    expect(result.topicTags).toHaveLength(100);
    expect(takeNormalizationMeta(result)).toEqual({
      truncated: true,
      omittedFields: ["/availableLanguages", "/topicTags"]
    });
    expect(takeNormalizationMeta(result)).toBeUndefined();
  });

  it("rejects an unavailable requested language with the canonical choices", async () => {
    const transport = fakeFetch(
      jsonResponse({
        data: {
          question: summary({
            content: "<p>Problem</p>",
            exampleTestcases: [],
            enableRunCode: true,
            codeSnippets: [
              { lang: "Go", langSlug: "golang", code: "func solve() {}" }
            ]
          })
        }
      })
    );
    const adapter = createLeetCodeReadAdapter("global", { fetch: transport.fetch });

    await expect(
      adapter.getProblem({
        region: "global",
        titleSlug: "two-sum",
        language: "python3"
      })
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { requestedLanguage: "python3", availableLanguages: "go" }
    });
  });

  it("fails closed for missing auth, region mismatches, and schema drift", async () => {
    const noAuthFetch = vi.fn<LeetCodeFetch>();
    const noAuthAdapter = createLeetCodeReadAdapter("global", {
      fetch: noAuthFetch
    });
    await expect(
      noAuthAdapter.getHistory({ region: "global", titleSlug: "two-sum" })
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(noAuthFetch).not.toHaveBeenCalled();

    await expect(
      noAuthAdapter.searchProblems({ region: "cn", query: "two sum" })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const drift = fakeFetch(
      jsonResponse({ data: { problemsetQuestionList: { questions: [] } } })
    );
    const driftAdapter = createLeetCodeReadAdapter("global", {
      fetch: drift.fetch
    });
    await expect(
      driftAdapter.searchProblems({ region: "global" })
    ).rejects.toMatchObject({
      code: "REMOTE_SCHEMA_CHANGED",
      details: { field: "data.problemsetQuestionList.total" }
    });
  });

  it("maps GraphQL auth and contract errors without exposing remote messages", async () => {
    const expired = fakeFetch(
      jsonResponse({
        errors: [{ message: "Login required secret-canary" }],
        data: null
      })
    );
    const expiredAdapter = createLeetCodeReadAdapter("global", {
      fetch: expired.fetch,
      credentialLookup: () => ({
        profileId: "profile-a",
        region: "global",
        session: "session-token",
        csrfToken: "csrf-token"
      })
    });
    await expect(
      expiredAdapter.getHistory({ region: "global", titleSlug: "two-sum" })
    ).rejects.toMatchObject({ code: "AUTH_EXPIRED" });

    const contractError = fakeFetch(
      jsonResponse({
        errors: [{ message: "Unknown field secret-canary" }],
        data: null
      })
    );
    const contractAdapter = createLeetCodeReadAdapter("global", {
      fetch: contractError.fetch
    });
    const error = await contractAdapter.getDaily().catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "REMOTE_SCHEMA_CHANGED",
      details: { operation: "dailyCodingChallengeV2", errorCount: 1 }
    });
    expect(String((error as Error).message)).not.toContain("secret-canary");
  });

  it("maps HTTP rate limiting and refuses redirects", async () => {
    const limited = fakeFetch(
      jsonResponse({}, 429, { "retry-after": "2" }),
      new Response(null, {
        status: 302,
        headers: { location: "https://attacker.invalid/collect" }
      })
    );
    const adapter = createLeetCodeReadAdapter("global", {
      fetch: limited.fetch,
      transportPolicy: new DefaultTransportPolicy({ readMaxAttempts: 1 })
    });

    await expect(adapter.getDaily()).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
      retryAfterMs: 2_000
    });
    await expect(adapter.getDaily()).rejects.toMatchObject({
      code: "REMOTE_UNAVAILABLE",
      details: { redirectRejected: true }
    });
  });
});

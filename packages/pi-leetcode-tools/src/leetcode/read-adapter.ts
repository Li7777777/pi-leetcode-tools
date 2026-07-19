import type {
  GetHistoryInput,
  GetProblemInput,
  GetProgressInput,
  GetSolutionInput,
  GetSolutionSearchInput,
  GetSubmissionDetailInput,
  GetUserContestInput,
  GetUserProfileInput,
  GetUserSubmissionsInput,
  SearchProblemsInput
} from "./client.js";
import { authRequired, LeetCodeToolError } from "./errors.js";
import {
  normalizeDailyChallenge,
  normalizeProblemDetail,
  normalizeProgressBySlug,
  normalizeProgressList,
  normalizeSearchProblems,
  normalizeSolutionDetail,
  normalizeSolutionSearch,
  normalizeSubmissionDetail,
  normalizeSubmissionHistory,
  normalizeUserContest,
  normalizeUserProfile,
  normalizeUserStatus,
  normalizeUserSubmissions
} from "./adapters/read-normalization.js";
import {
  CN_HISTORY_QUERY,
  CN_PROBLEM_QUERY,
  CN_RECENT_AC_SUBMISSIONS_QUERY,
  CN_SEARCH_QUERY,
  CN_SOLUTION_ARTICLES_QUERY,
  CN_SOLUTION_DETAIL_QUERY,
  CN_SUBMISSION_DETAIL_QUERY,
  CN_DAILY_QUERY,
  CN_USER_CONTEST_QUERY,
  CN_USER_PROFILE_QUERY,
  CN_USER_STATUS_QUERY,
  GLOBAL_HISTORY_QUERY,
  GLOBAL_PROBLEM_QUERY,
  GLOBAL_RECENT_AC_SUBMISSIONS_QUERY,
  GLOBAL_RECENT_SUBMISSIONS_QUERY,
  GLOBAL_SEARCH_QUERY,
  GLOBAL_SOLUTION_ARTICLES_QUERY,
  GLOBAL_SOLUTION_DETAIL_QUERY,
  GLOBAL_SUBMISSION_DETAIL_QUERY,
  GLOBAL_DAILY_QUERY,
  GLOBAL_USER_CONTEST_QUERY,
  GLOBAL_USER_PROFILE_QUERY,
  GLOBAL_USER_STATUS_QUERY,
  PROGRESS_BY_SLUG_QUERY,
  PROGRESS_LIST_QUERY
} from "./adapters/read-queries.js";
import type {
  CredentialBundle,
  DailyChallenge,
  ProblemDetail,
  ProblemProgressResult,
  Region,
  SearchProblemsResult,
  SolutionDetail,
  SolutionSearchResult,
  SubmissionDetail,
  SubmissionHistoryResult,
  UserContestResult,
  UserProfile,
  UserStatus,
  UserSubmissionsResult
} from "../types.js";
import { canonicalLanguageToRemote } from "../tool-calls/contract.js";
import { PROBLEM_CATEGORIES, PROBLEM_TAGS } from "../tool-calls/contract.js";
import type { TransportPolicy } from "../runtime/transport-policy.js";
import { createDefaultTransportPolicy } from "../runtime/transport-policy.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_SIZE = 50;
const MAX_QUERY_LENGTH = 200;
const MAX_TAGS = 20;
const MAX_CURSOR_LENGTH = 1_000;
const MAX_SOLUTION_TAG_LENGTH = 128;
const TITLE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_SLUG = /^[a-z0-9+#.]+(?:-[a-z0-9+#.]+)*$/i;
const SOLUTION_TAG_SLUG = /^[A-Za-z0-9+#._]+(?:-[A-Za-z0-9+#._]+)*$/u;
const SOLUTION_SLUG = /^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*$/u;
const SOLUTION_TOPIC_ID = /^\d+$/u;
const USERNAME = /^[A-Za-z0-9_.-]+$/u;
const SUBMISSION_ID = /^\d+$/u;

type UnknownRecord = Record<string, unknown>;

export type LeetCodeFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export type CredentialLookup = (
  region: Region
) =>
  | CredentialBundle
  | undefined
  | Promise<CredentialBundle | undefined>;

export interface LeetCodeReadAdapterOptions {
  fetch?: LeetCodeFetch;
  credentialLookup?: CredentialLookup;
  transportPolicy?: TransportPolicy;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => Date;
}

export interface LeetCodeReadAdapter {
  readonly region: Region;
  getDaily(signal?: AbortSignal): Promise<DailyChallenge>;
  searchProblems(
    input: SearchProblemsInput,
    signal?: AbortSignal
  ): Promise<SearchProblemsResult>;
  getProblem(
    input: GetProblemInput,
    signal?: AbortSignal
  ): Promise<ProblemDetail>;
  searchSolutions(
    input: GetSolutionSearchInput,
    signal?: AbortSignal
  ): Promise<SolutionSearchResult>;
  getSolution(
    input: GetSolutionInput,
    signal?: AbortSignal
  ): Promise<SolutionDetail>;
  getUserProfile(
    input: GetUserProfileInput,
    signal?: AbortSignal
  ): Promise<UserProfile>;
  getUserContest(
    input: GetUserContestInput,
    signal?: AbortSignal
  ): Promise<UserContestResult>;
  getProgress(
    input: GetProgressInput,
    signal?: AbortSignal
  ): Promise<ProblemProgressResult>;
  getHistory(
    input: GetHistoryInput,
    signal?: AbortSignal
  ): Promise<SubmissionHistoryResult>;
  getUserSubmissions(
    input: GetUserSubmissionsInput,
    signal?: AbortSignal
  ): Promise<UserSubmissionsResult>;
  getSubmissionDetail(
    input: GetSubmissionDetailInput,
    signal?: AbortSignal
  ): Promise<SubmissionDetail>;
  getUserStatus(signal?: AbortSignal): Promise<UserStatus>;
}

export interface LeetCodeReadAdapters {
  readonly global: LeetCodeReadAdapter;
  readonly cn: LeetCodeReadAdapter;
  forRegion(region: Region): LeetCodeReadAdapter;
}

interface RegionConfig {
  readonly origin: string;
  readonly graphqlEndpoint: string;
  readonly publicRecentEndpoint: string;
  readonly contestEndpoint: string;
  readonly dailyOperationName: string;
  readonly dailyQuery: string;
  readonly searchQuery: string;
  readonly historyQuery: string;
  readonly historyUsesCursor: boolean;
}

const REGION_CONFIG: Readonly<Record<Region, RegionConfig>> = {
  global: {
    origin: "https://leetcode.com",
    graphqlEndpoint: "https://leetcode.com/graphql/",
    publicRecentEndpoint: "https://leetcode.com/graphql/",
    contestEndpoint: "https://leetcode.com/graphql/",
    dailyOperationName: "dailyCodingChallengeV2",
    dailyQuery: GLOBAL_DAILY_QUERY,
    searchQuery: GLOBAL_SEARCH_QUERY,
    historyQuery: GLOBAL_HISTORY_QUERY,
    historyUsesCursor: false
  },
  cn: {
    origin: "https://leetcode.cn",
    graphqlEndpoint: "https://leetcode.cn/graphql/",
    publicRecentEndpoint: "https://leetcode.cn/graphql/noj-go/",
    contestEndpoint: "https://leetcode.cn/graphql/noj-go/",
    dailyOperationName: "questionOfToday",
    dailyQuery: CN_DAILY_QUERY,
    searchQuery: CN_SEARCH_QUERY,
    historyQuery: CN_HISTORY_QUERY,
    historyUsesCursor: true
  }
};

export const LEETCODE_READ_ENDPOINTS: Readonly<Record<Region, string>> = {
  global: REGION_CONFIG.global.graphqlEndpoint,
  cn: REGION_CONFIG.cn.graphqlEndpoint
};

function validationError(message: string): LeetCodeToolError {
  return new LeetCodeToolError("VALIDATION_ERROR", message);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new LeetCodeToolError("CANCELLED", "LeetCode request was cancelled");
  }
}

function normalizePage(
  limitValue: number | undefined,
  offsetValue: number | undefined
): { limit: number; offset: number } {
  const limit = limitValue ?? 20;
  const offset = offsetValue ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw validationError(`limit must be an integer from 1 to ${MAX_PAGE_SIZE}`);
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw validationError("offset must be a non-negative integer");
  }
  return { limit, offset };
}

function normalizeProgressPage(
  limitValue: number | undefined,
  offsetValue: number | undefined
): { limit: number; offset: number } {
  const limit = limitValue ?? 100;
  const offset = offsetValue ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw validationError("limit must be an integer from 1 to 100");
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw validationError("offset must be a non-negative integer");
  }
  return { limit, offset };
}

function normalizeTitleSlug(value: string): string {
  const titleSlug = value.trim().toLowerCase();
  if (titleSlug.length === 0 || titleSlug.length > 200 || !TITLE_SLUG.test(titleSlug)) {
    throw validationError("titleSlug must be a valid LeetCode problem slug");
  }
  return titleSlug;
}

function normalizeSolutionTopicId(value: string): string {
  const topicId = value.trim();
  if (
    topicId.length === 0 ||
    topicId.length > 32 ||
    !SOLUTION_TOPIC_ID.test(topicId)
  ) {
    throw validationError("topicId must be a numeric LeetCode solution topic ID");
  }
  return topicId;
}

function normalizeSolutionSlug(value: string): string {
  const slug = value.trim();
  if (slug.length === 0 || slug.length > 256 || !SOLUTION_SLUG.test(slug)) {
    throw validationError("slug must be a valid LeetCode solution article slug");
  }
  return slug;
}

function normalizeSolutionTags(value: string[] | undefined): string[] {
  if (value === undefined || value.length === 0) {
    return [];
  }
  if (value.length > MAX_TAGS) {
    throw validationError(`tags must contain at most ${MAX_TAGS} entries`);
  }

  const normalized = value.map((tag) => {
    const slug = tag.trim().toLowerCase();
    if (
      slug.length === 0 ||
      slug.length > MAX_SOLUTION_TAG_LENGTH ||
      !SOLUTION_TAG_SLUG.test(slug)
    ) {
      throw validationError("tags must contain valid LeetCode solution tag slugs");
    }
    return slug;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw validationError("tags must not contain duplicate solution tag slugs");
  }
  return normalized;
}

function normalizeSolutionOrderBy(
  region: Region,
  value: GetSolutionSearchInput["orderBy"]
): string {
  const orderBy = value ?? (region === "global" ? "HOT" : "DEFAULT");
  const allowed =
    region === "global"
      ? (["HOT", "MOST_RECENT", "MOST_VOTES"] as const)
      : ([
          "DEFAULT",
          "MOST_UPVOTE",
          "HOT",
          "NEWEST_TO_OLDEST",
          "OLDEST_TO_NEWEST"
        ] as const);
  if (!(allowed as readonly string[]).includes(orderBy)) {
    throw validationError(
      `orderBy ${orderBy} is not supported on LeetCode ${region}`
    );
  }
  return orderBy;
}

function normalizeUsername(value: string): string {
  if (value.length === 0 || value.length > 64 || !USERNAME.test(value)) {
    throw validationError("username must be a valid public LeetCode username");
  }
  return value;
}

function normalizeSubmissionId(value: string): string {
  if (value.length === 0 || value.length > 20 || !SUBMISSION_ID.test(value)) {
    throw validationError("submissionId must be a numeric LeetCode submission ID");
  }
  return value;
}

function normalizeQuery(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const query = value.trim();
  if (query.length === 0) {
    return undefined;
  }
  if (query.length > MAX_QUERY_LENGTH) {
    throw validationError(`query must not exceed ${MAX_QUERY_LENGTH} characters`);
  }
  return query;
}

function normalizeTags(value: string[] | undefined): string[] | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  if (value.length > MAX_TAGS) {
    throw validationError(`tags must contain at most ${MAX_TAGS} entries`);
  }

  return value.map((tag) => {
    const normalized = tag.trim().toLowerCase();
    if (
      normalized.length === 0 ||
      normalized.length > 100 ||
      !TAG_SLUG.test(normalized) ||
      !(PROBLEM_TAGS as readonly string[]).includes(normalized)
    ) {
      throw validationError("tags must contain valid LeetCode tag slugs");
    }
    return normalized;
  });
}

function normalizeCategory(value: string | undefined): string {
  const category = value ?? "all-code-essentials";
  if (!(PROBLEM_CATEGORIES as readonly string[]).includes(category)) {
    throw validationError("category must be a canonical LeetCode problem category");
  }
  return category;
}

function normalizeCursor(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const cursor = value.trim();
  if (cursor.length === 0) {
    return undefined;
  }
  if (cursor.length > MAX_CURSOR_LENGTH || /[\r\n]/.test(cursor)) {
    throw validationError("cursor is invalid");
  }
  return cursor;
}

function asResponseRecord(value: unknown, field: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LeetCodeToolError(
      "REMOTE_SCHEMA_CHANGED",
      "LeetCode returned an unexpected response shape",
      { details: { field } }
    );
  }
  return value as UnknownRecord;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.round(seconds * 1_000), 24 * 60 * 60 * 1_000);
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) {
    return undefined;
  }
  return Math.min(Math.max(0, date - Date.now()), 24 * 60 * 60 * 1_000);
}

function graphQLErrorsIndicateAuth(errors: unknown[]): boolean {
  return errors.some((error) => {
    if (typeof error !== "object" || error === null || Array.isArray(error)) {
      return false;
    }
    const record = error as UnknownRecord;
    const message = typeof record.message === "string" ? record.message.toLowerCase() : "";
    const extensions =
      typeof record.extensions === "object" &&
      record.extensions !== null &&
      !Array.isArray(record.extensions)
        ? (record.extensions as UnknownRecord)
        : undefined;
    const code =
      typeof extensions?.code === "string" ? extensions.code.toLowerCase() : "";
    return (
      code === "unauthenticated" ||
      code === "unauthorized" ||
      code === "forbidden" ||
      message.includes("not authenticated") ||
      message.includes("authentication required") ||
      message.includes("log in") ||
      message.includes("login required")
    );
  });
}

function graphQLErrorsIndicateNotFound(errors: unknown[]): boolean {
  return errors.some((error) => {
    if (typeof error !== "object" || error === null || Array.isArray(error)) {
      return false;
    }
    const message = (error as UnknownRecord).message;
    return typeof message === "string" && message.toLowerCase().includes("not found");
  });
}

function isSafeCredentialValue(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 16_384 &&
    !/[\u0000-\u0020\u007f;,]/.test(value)
  );
}

class GraphQLReadAdapter implements LeetCodeReadAdapter {
  readonly region: Region;

  private readonly config: RegionConfig;
  private readonly fetchImpl: LeetCodeFetch;
  private readonly credentialLookup: CredentialLookup | undefined;
  private readonly transportPolicy: TransportPolicy;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly now: () => Date;

  constructor(region: Region, options: LeetCodeReadAdapterOptions) {
    this.region = region;
    this.config = REGION_CONFIG[region];
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new LeetCodeToolError(
        "CAPABILITY_UNAVAILABLE",
        "A Fetch API implementation is required"
      );
    }
    this.fetchImpl = fetchImpl.bind(globalThis);
    this.credentialLookup = options.credentialLookup;
    this.transportPolicy =
      options.transportPolicy ?? createDefaultTransportPolicy();
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxResponseBytes =
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.now = options.now ?? (() => new Date());
    if (
      !Number.isInteger(this.requestTimeoutMs) ||
      this.requestTimeoutMs < 100 ||
      this.requestTimeoutMs > 120_000
    ) {
      throw validationError("requestTimeoutMs must be between 100 and 120000");
    }
    if (
      !Number.isInteger(this.maxResponseBytes) ||
      this.maxResponseBytes < 1_024 ||
      this.maxResponseBytes > 10 * 1024 * 1024
    ) {
      throw validationError(
        "maxResponseBytes must be between 1024 and 10485760"
      );
    }
  }

  async getDaily(signal?: AbortSignal): Promise<DailyChallenge> {
    return this.request(
      this.config.dailyOperationName,
      this.config.dailyQuery,
      {},
      false,
      signal,
      (data) => normalizeDailyChallenge(
        data,
        this.region,
        this.now().toISOString().slice(0, 10)
      )
    );
  }

  async searchProblems(
    input: SearchProblemsInput,
    signal?: AbortSignal
  ): Promise<SearchProblemsResult> {
    this.assertRegion(input.region);
    const { limit, offset } = normalizePage(input.limit ?? 10, input.offset);
    const category = normalizeCategory(input.category);
    const query = normalizeQuery(input.query);
    const tags = normalizeTags(input.tags);
    const filters: UnknownRecord = {};
    if (query !== undefined) {
      filters.searchKeywords = query;
    }
    if (tags !== undefined) {
      filters.tags = tags;
    }
    if (input.difficulty !== undefined) {
      filters.difficulty = input.difficulty.toUpperCase();
    }

    return this.request(
      "problemsetQuestionList",
      this.config.searchQuery,
      {
        categorySlug: category,
        limit,
        skip: offset,
        filters
      },
      false,
      signal,
      (data) => normalizeSearchProblems(data, this.region, offset, limit)
    );
  }

  async getProblem(
    input: GetProblemInput,
    signal?: AbortSignal
  ): Promise<ProblemDetail> {
    this.assertRegion(input.region);
    const titleSlug = normalizeTitleSlug(input.titleSlug);
    return this.request(
      "questionData",
      this.region === "global" ? GLOBAL_PROBLEM_QUERY : CN_PROBLEM_QUERY,
      { titleSlug },
      false,
      signal,
      (data) => normalizeProblemDetail(
        data,
        this.region,
        input.language,
        input.includeResourcePayload ?? false
      )
    );
  }

  async searchSolutions(
    input: GetSolutionSearchInput,
    signal?: AbortSignal
  ): Promise<SolutionSearchResult> {
    this.assertRegion(input.region);
    const titleSlug = normalizeTitleSlug(input.titleSlug);
    const { limit, offset } = normalizePage(input.limit ?? 10, input.offset);
    const orderBy = normalizeSolutionOrderBy(this.region, input.orderBy);
    const query = normalizeQuery(input.query);
    const tags = normalizeSolutionTags(input.tags);

    return this.request(
      this.region === "global"
        ? "ugcArticleSolutionArticles"
        : "questionTopicsList",
      this.region === "global"
        ? GLOBAL_SOLUTION_ARTICLES_QUERY
        : CN_SOLUTION_ARTICLES_QUERY,
      {
        questionSlug: titleSlug,
        first: limit,
        skip: offset,
        orderBy,
        ...(query === undefined ? {} : { userInput: query }),
        tagSlugs: tags
      },
      false,
      signal,
      (data) =>
        normalizeSolutionSearch(data, this.region, titleSlug, offset, limit)
    );
  }

  async getSolution(
    input: GetSolutionInput,
    signal?: AbortSignal
  ): Promise<SolutionDetail> {
    this.assertRegion(input.region);
    if (this.region === "global") {
      if (input.topicId === undefined || input.slug !== undefined) {
        throw validationError(
          "Global solution detail requires topicId and does not accept slug"
        );
      }
      const topicId = normalizeSolutionTopicId(input.topicId);
      return this.request(
        "ugcArticleSolutionArticle",
        GLOBAL_SOLUTION_DETAIL_QUERY,
        { topicId },
        false,
        signal,
        (data) => normalizeSolutionDetail(data, "global", { topicId })
      );
    }

    if (input.slug === undefined || input.topicId !== undefined) {
      throw validationError(
        "LeetCode CN solution detail requires slug and does not accept topicId"
      );
    }
    const slug = normalizeSolutionSlug(input.slug);
    return this.request(
      "discussTopic",
      CN_SOLUTION_DETAIL_QUERY,
      { slug },
      false,
      signal,
      (data) => normalizeSolutionDetail(data, "cn", { slug })
    );
  }

  async getUserProfile(
    input: GetUserProfileInput,
    signal?: AbortSignal
  ): Promise<UserProfile> {
    this.assertRegion(input.region);
    const username = normalizeUsername(input.username);
    return this.request(
      this.region === "global" ? "userProfile" : "getUserProfile",
      this.region === "global" ? GLOBAL_USER_PROFILE_QUERY : CN_USER_PROFILE_QUERY,
      { username },
      false,
      signal,
      (data) => normalizeUserProfile(data, this.region, username)
    );
  }

  async getUserContest(
    input: GetUserContestInput,
    signal?: AbortSignal
  ): Promise<UserContestResult> {
    this.assertRegion(input.region);
    const username = normalizeUsername(input.username);
    const attendedOnly = input.attendedOnly ?? true;
    const { limit, offset } = normalizePage(input.limit ?? 50, input.offset);
    return this.request(
      "userContestRankingInfo",
      this.region === "global" ? GLOBAL_USER_CONTEST_QUERY : CN_USER_CONTEST_QUERY,
      { username },
      false,
      signal,
      (data) => normalizeUserContest(data, username, attendedOnly, offset, limit),
      this.config.contestEndpoint
    );
  }

  async getProgress(
    input: GetProgressInput,
    signal?: AbortSignal
  ): Promise<ProblemProgressResult> {
    this.assertRegion(input.region);
    const { limit, offset } = normalizeProgressPage(input.limit, input.offset);
    if (input.titleSlug !== undefined) {
      const titleSlug = normalizeTitleSlug(input.titleSlug);
      return this.request(
        "questionProgress",
        PROGRESS_BY_SLUG_QUERY,
        { titleSlug },
        true,
        signal,
        (data) => {
          const item = normalizeProgressBySlug(data, this.region);
          const matchesStatus =
            input.status === undefined || item.status === input.status;
          const matchesDifficulty =
            input.difficulty === undefined ||
            input.difficulty.includes(item.difficulty);
          const matches = matchesStatus && matchesDifficulty;
          return {
            filters: {
              offset,
              limit,
              ...(input.status === undefined
                ? {}
                : { questionStatus: input.status === "solved" ? "SOLVED" as const : "ATTEMPTED" as const }),
              ...(input.difficulty === undefined
                ? {}
                : { difficulty: input.difficulty.map((difficulty) => difficulty.toUpperCase() as "EASY" | "MEDIUM" | "HARD") })
            },
            items: matches && offset === 0 ? [item] : [],
            page: {
              offset,
              limit,
              totalKind: "exact",
              total: matches ? 1 : 0,
              hasMore: false
            }
          };
        }
      );
    }

    const filters: UnknownRecord = { skip: offset, limit };
    if (input.status !== undefined) {
      filters.questionStatus =
        input.status === "solved" ? "SOLVED" : "ATTEMPTED";
    }
    if (input.difficulty !== undefined) {
      filters.difficulty = input.difficulty.map((difficulty) =>
        difficulty.toUpperCase()
      );
    }

    return this.request(
      "userProgressQuestionList",
      PROGRESS_LIST_QUERY,
      { filters },
      true,
      signal,
      (data) => normalizeProgressList(data, this.region, offset, limit, {
        ...(filters.questionStatus === undefined
          ? {}
          : { questionStatus: filters.questionStatus as "SOLVED" | "ATTEMPTED" }),
        ...(filters.difficulty === undefined
          ? {}
          : { difficulty: filters.difficulty as ("EASY" | "MEDIUM" | "HARD")[] })
      })
    );
  }

  async getHistory(
    input: GetHistoryInput,
    signal?: AbortSignal
  ): Promise<SubmissionHistoryResult> {
    this.assertRegion(input.region);
    const scope = input.scope ?? (input.titleSlug === undefined ? "account" : "problem");
    if (scope === "problem" && input.titleSlug === undefined) {
      throw validationError("titleSlug is required when history scope is problem");
    }
    if (scope === "account" && input.titleSlug !== undefined) {
      throw validationError("titleSlug must be omitted when history scope is account");
    }
    const titleSlug =
      input.titleSlug === undefined ? undefined : normalizeTitleSlug(input.titleSlug);
    if (this.region === "global" && (input.language !== undefined || input.status !== undefined)) {
      throw new LeetCodeToolError(
        "CAPABILITY_UNAVAILABLE",
        "Language and status history filters are supported only on LeetCode CN"
      );
    }
    const { limit, offset } = normalizePage(input.limit, input.offset);
    const cursor = normalizeCursor(input.cursor);
    if (!this.config.historyUsesCursor && cursor !== undefined) {
      throw validationError("cursor is supported only for LeetCode CN history");
    }
    const variables: UnknownRecord = {
      offset,
      limit,
      questionSlug: titleSlug ?? null
    };
    if (this.config.historyUsesCursor) {
      variables.lastKey = cursor ?? null;
      variables.lang =
        input.language === undefined
          ? null
          : canonicalLanguageToRemote(this.region, input.language);
      if (input.language !== undefined && variables.lang === undefined) {
        throw validationError(`Unsupported canonical language: ${input.language}`);
      }
      variables.status =
        input.status === undefined
          ? null
          : input.status === "accepted"
            ? "AC"
            : "WA";
    }
    return this.request(
      "submissionList",
      this.config.historyQuery,
      variables,
      true,
      signal,
      (data) => normalizeSubmissionHistory(data, this.region, offset, limit, titleSlug)
    );
  }

  async getUserSubmissions(
    input: GetUserSubmissionsInput,
    signal?: AbortSignal
  ): Promise<UserSubmissionsResult> {
    this.assertRegion(input.region);
    const username = normalizeUsername(input.username);
    const limit = input.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw validationError("limit must be an integer from 1 to 20");
    }
    if (this.region === "cn" && input.mode !== "accepted") {
      throw new LeetCodeToolError(
        "CAPABILITY_UNAVAILABLE",
        "Public recent submissions including failures are unavailable on LeetCode CN"
      );
    }
    const query =
      this.region === "cn"
        ? CN_RECENT_AC_SUBMISSIONS_QUERY
        : input.mode === "accepted"
          ? GLOBAL_RECENT_AC_SUBMISSIONS_QUERY
          : GLOBAL_RECENT_SUBMISSIONS_QUERY;
    return this.request(
      input.mode === "accepted" ? "recentAcSubmissions" : "recentSubmissions",
      query,
      this.region === "cn" ? { username } : { username, limit },
      false,
      signal,
      (data) => normalizeUserSubmissions(data, this.region, username, input.mode, limit),
      this.config.publicRecentEndpoint
    );
  }

  async getSubmissionDetail(
    input: GetSubmissionDetailInput,
    signal?: AbortSignal
  ): Promise<SubmissionDetail> {
    this.assertRegion(input.region);
    const submissionId = normalizeSubmissionId(input.submissionId);
    const includeCode = input.includeCode ?? false;
    const variables: UnknownRecord =
      this.region === "global"
        ? { id: Number(submissionId), includeCode }
        : { submissionId, includeCode };
    if (
      this.region === "global" &&
      (!Number.isSafeInteger(variables.id) || (variables.id as number) > 2_147_483_647)
    ) {
      throw validationError("Global submissionId must fit the GraphQL Int range");
    }
    return this.request(
      "submissionDetails",
      this.region === "global"
        ? GLOBAL_SUBMISSION_DETAIL_QUERY
        : CN_SUBMISSION_DETAIL_QUERY,
      variables,
      true,
      signal,
      (data) => normalizeSubmissionDetail(data, this.region, submissionId, includeCode)
    );
  }

  async getUserStatus(signal?: AbortSignal): Promise<UserStatus> {
    return this.request(
      "userStatus",
      this.region === "global" ? GLOBAL_USER_STATUS_QUERY : CN_USER_STATUS_QUERY,
      {},
      true,
      signal,
      (data) => normalizeUserStatus(data, this.region)
    );
  }

  private assertRegion(region: Region): void {
    if (region !== this.region) {
      throw validationError(
        `Input region ${region} does not match ${this.region} adapter`
      );
    }
  }

  private async authenticationHeaders(): Promise<{
    headers: Record<string, string>;
    profileId: string;
  }> {
    if (this.credentialLookup === undefined) {
      throw authRequired(this.region);
    }

    let credential: CredentialBundle | undefined;
    try {
      credential = await this.credentialLookup(this.region);
    } catch {
      throw new LeetCodeToolError(
        "AUTH_REQUIRED",
        `Credentials are unavailable for LeetCode ${this.region}`
      );
    }
    if (credential === undefined || credential.region !== this.region) {
      throw authRequired(this.region);
    }
    if (
      credential.profileId.trim().length === 0 ||
      !isSafeCredentialValue(credential.session) ||
      (credential.csrfToken.length > 0 &&
        !isSafeCredentialValue(credential.csrfToken))
    ) {
      throw new LeetCodeToolError(
        "AUTH_REQUIRED",
        `Credentials are invalid for LeetCode ${this.region}`
      );
    }

    const cookie =
      credential.csrfToken.length === 0
        ? `LEETCODE_SESSION=${credential.session}`
        : `LEETCODE_SESSION=${credential.session}; csrftoken=${credential.csrfToken}`;
    return {
      profileId: credential.profileId,
      headers: {
        cookie,
        ...(credential.csrfToken.length === 0
          ? {}
          : { "x-csrftoken": credential.csrfToken }),
        "x-requested-with": "XMLHttpRequest"
      }
    };
  }

  private async request<T>(
    operationName: string,
    query: string,
    variables: UnknownRecord,
    requiresAuth: boolean,
    signal: AbortSignal | undefined,
    decode: (data: UnknownRecord) => T,
    endpoint = this.config.graphqlEndpoint
  ): Promise<T> {
    throwIfAborted(signal);

    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
      origin: this.config.origin,
      referer: `${this.config.origin}/`
    };
    let profileId: string | undefined;
    if (requiresAuth) {
      const authentication = await this.authenticationHeaders();
      Object.assign(headers, authentication.headers);
      profileId = authentication.profileId;
    }
    throwIfAborted(signal);

    return this.transportPolicy.execute(
      {
        region: this.region,
        operation: operationName,
        retryMode: "safe-read",
        recoveryProbe: true,
        requestTimeoutMs: this.requestTimeoutMs,
        ...(profileId === undefined ? {} : { profileId }),
        ...(signal === undefined ? {} : { signal })
      },
      async ({ signal: requestSignal }) => {
        try {
          const response = await this.fetchImpl(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify({ operationName, query, variables }),
            redirect: "manual",
            cache: "no-store",
            signal: requestSignal
          });

          if (response.status >= 300 && response.status < 400) {
            throw new LeetCodeToolError(
              "REMOTE_UNAVAILABLE",
              "LeetCode returned a redirect that was not followed",
              { details: { operation: operationName, redirectRejected: true } }
            );
          }
          if (response.status === 429) {
            const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
            throw new LeetCodeToolError(
              "RATE_LIMITED",
              "LeetCode rate limit was reached",
              {
                retryable: true,
                ...(retryAfterMs === undefined ? {} : { retryAfterMs })
              }
            );
          }
          if (response.status === 401 || response.status === 403) {
            throw new LeetCodeToolError(
              requiresAuth ? "AUTH_EXPIRED" : "PERMISSION_DENIED",
              requiresAuth
                ? `Authentication expired for LeetCode ${this.region}`
                : "LeetCode denied the request"
            );
          }
          if (response.status >= 500) {
            throw new LeetCodeToolError(
              "REMOTE_UNAVAILABLE",
              "LeetCode is temporarily unavailable",
              { retryable: true, details: { status: response.status } }
            );
          }
          if (response.status === 400) {
            throw new LeetCodeToolError(
              "REMOTE_SCHEMA_CHANGED",
              "LeetCode rejected the GraphQL request",
              { details: { operation: operationName, status: response.status } }
            );
          }
          if (!response.ok) {
            throw new LeetCodeToolError(
              "REMOTE_UNAVAILABLE",
              "LeetCode request failed",
              { details: { status: response.status } }
            );
          }

          const contentType =
            response.headers.get("content-type")?.toLowerCase() ?? "";
          if (
            !contentType.startsWith("application/json") &&
            !contentType.startsWith("application/graphql-response+json")
          ) {
            throw new LeetCodeToolError(
              "REMOTE_SCHEMA_CHANGED",
              "LeetCode returned an unsupported content type",
              { details: { operation: operationName } }
            );
          }
          const declaredLength = Number(response.headers.get("content-length"));
          if (
            Number.isFinite(declaredLength) &&
            declaredLength > this.maxResponseBytes
          ) {
            throw new LeetCodeToolError(
              "REMOTE_SCHEMA_CHANGED",
              "LeetCode response exceeded the configured size limit",
              { details: { operation: operationName } }
            );
          }

          const responseText = await response.text();
          if (
            new TextEncoder().encode(responseText).byteLength >
            this.maxResponseBytes
          ) {
            throw new LeetCodeToolError(
              "REMOTE_SCHEMA_CHANGED",
              "LeetCode response exceeded the configured size limit",
              { details: { operation: operationName } }
            );
          }

          let payload: unknown;
          try {
            payload = JSON.parse(responseText);
          } catch {
            throw new LeetCodeToolError(
              "REMOTE_SCHEMA_CHANGED",
              "LeetCode returned malformed JSON",
              { details: { operation: operationName } }
            );
          }
          const responseObject = asResponseRecord(payload, "response");
          if (responseObject.errors !== undefined) {
            if (!Array.isArray(responseObject.errors)) {
              throw new LeetCodeToolError(
                "REMOTE_SCHEMA_CHANGED",
                "LeetCode returned an unexpected GraphQL error shape",
                { details: { operation: operationName } }
              );
            }
            if (responseObject.errors.length > 0) {
              if (graphQLErrorsIndicateAuth(responseObject.errors)) {
                throw new LeetCodeToolError(
                  requiresAuth ? "AUTH_EXPIRED" : "AUTH_REQUIRED",
                  requiresAuth
                    ? `Authentication expired for LeetCode ${this.region}`
                    : `Authentication is required for LeetCode ${this.region}`
                );
              }
              if (graphQLErrorsIndicateNotFound(responseObject.errors)) {
                throw new LeetCodeToolError(
                  "NOT_FOUND",
                  "LeetCode resource was not found"
                );
              }
              throw new LeetCodeToolError(
                "REMOTE_SCHEMA_CHANGED",
                "LeetCode returned a GraphQL contract error",
                {
                  details: {
                    operation: operationName,
                    errorCount: responseObject.errors.length
                  }
                }
              );
            }
          }
          return decode(asResponseRecord(responseObject.data, "data"));
        } catch (error) {
          if (error instanceof LeetCodeToolError) {
            throw error;
          }
          throw new LeetCodeToolError(
            "REMOTE_UNAVAILABLE",
            "LeetCode request failed",
            { retryable: true }
          );
        }
      }
    );
  }
}

export function createLeetCodeReadAdapter(
  region: Region,
  options: LeetCodeReadAdapterOptions = {}
): LeetCodeReadAdapter {
  return new GraphQLReadAdapter(region, options);
}

export function createLeetCodeReadAdapters(
  options: LeetCodeReadAdapterOptions = {}
): LeetCodeReadAdapters {
  const transportPolicy =
    options.transportPolicy ?? createDefaultTransportPolicy();
  const sharedOptions: LeetCodeReadAdapterOptions = {
    ...options,
    transportPolicy
  };
  const global = createLeetCodeReadAdapter("global", sharedOptions);
  const cn = createLeetCodeReadAdapter("cn", sharedOptions);
  return {
    global,
    cn,
    forRegion(region: Region): LeetCodeReadAdapter {
      switch (region) {
        case "global":
          return global;
        case "cn":
          return cn;
        default:
          throw new LeetCodeToolError(
            "UNSUPPORTED_REGION",
            `Unsupported LeetCode region: ${String(region)}`
          );
      }
    }
  };
}

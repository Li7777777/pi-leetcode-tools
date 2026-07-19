import { createHash } from "node:crypto";

import { Type, type Static, type TSchema } from "typebox";

export const PACKAGE_VERSION = "0.1.2";
export const PACKAGE_NAME = "pi-leetcode-tools";
export const CONTRACT_VERSION = "1.1.0";
export const PROTOCOL_VERSION = "1.0.0";
export const DISCOVERY_CHANNEL = "pi-leetcode-tools:discover:v1";
export const RPC_CHANNEL = "pi-leetcode-tools:rpc:v1";
export const READY_CHANNEL = "pi-leetcode-tools:ready:v1";
export const DEACTIVATED_CHANNEL = "pi-leetcode-tools:deactivated:v1";
export const DEFAULT_RPC_TIMEOUT_MS = 10_000;

export const TOOL_ERROR_CODES = [
  "VALIDATION_ERROR",
  "AUTH_REQUIRED",
  "AUTH_EXPIRED",
  "PERMISSION_DENIED",
  "INTERACTION_REQUIRED",
  "NOT_FOUND",
  "RATE_LIMITED",
  "REMOTE_UNAVAILABLE",
  "EXECUTION_FAILED",
  "UNSUPPORTED_REGION",
  "STALE_OPERATION",
  "STALE_CURSOR",
  "UNKNOWN_WRITE_OUTCOME",
  "CANCELLED",
  "CAPABILITY_UNAVAILABLE",
  "REMOTE_SCHEMA_CHANGED",
  "PROVIDER_CONFLICT",
  "CONTRACT_MISMATCH",
  "PROTOCOL_TIMEOUT"
] as const;

export const TOOL_NAMES = [
  "lc_daily",
  "lc_search",
  "lc_problem",
  "lc_solution_search",
  "lc_solution",
  "lc_profile",
  "lc_contest",
  "lc_progress",
  "lc_history",
  "lc_user_submissions",
  "lc_submission",
  "lc_run",
  "lc_submit",
  "lc_operation_status"
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export const CANONICAL_LANGUAGE_IDS = [
  "bash",
  "c",
  "cpp",
  "csharp",
  "cangjie",
  "dart",
  "elixir",
  "erlang",
  "go",
  "java",
  "javascript",
  "kotlin",
  "mysql",
  "mssql",
  "oracle",
  "php",
  "python",
  "python3",
  "racket",
  "ruby",
  "rust",
  "scala",
  "swift",
  "typescript"
] as const;

export type CanonicalLanguage = (typeof CANONICAL_LANGUAGE_IDS)[number];
export type ContractRegion = "global" | "cn";

export const UPSTREAM_PROGRAMMING_LANGS = [
  "cpp", "java", "python", "python3", "c", "csharp", "javascript",
  "typescript", "php", "swift", "kotlin", "dart", "golang", "ruby",
  "scala", "rust", "racket", "erlang", "elixir", "cangjie"
] as const;

export const PROBLEM_CATEGORIES = [
  "all-code-essentials",
  "algorithms",
  "database",
  "pandas",
  "javascript",
  "shell",
  "concurrency"
] as const;

export const PROBLEM_TAGS = [
  "array", "string", "hash-table", "dynamic-programming", "math", "sorting",
  "greedy", "depth-first-search", "binary-search", "database", "tree",
  "breadth-first-search", "matrix", "bit-manipulation", "two-pointers",
  "binary-tree", "heap-priority-queue", "prefix-sum", "stack", "simulation",
  "graph", "counting", "sliding-window", "design", "backtracking",
  "enumeration", "linked-list", "union-find", "ordered-set", "monotonic-stack",
  "number-theory", "trie", "segment-tree", "recursion", "divide-and-conquer",
  "queue", "combinatorics", "binary-search-tree", "bitmask", "memoization",
  "geometry", "binary-indexed-tree", "hash-function", "topological-sort",
  "string-matching", "shortest-path", "rolling-hash", "game-theory",
  "data-stream", "interactive", "monotonic-queue", "brainteaser",
  "doubly-linked-list", "merge-sort", "randomized", "quickselect",
  "counting-sort", "iterator", "probability-and-statistics", "concurrency",
  "bucket-sort", "suffix-array", "line-sweep", "minimum-spanning-tree", "shell",
  "reservoir-sampling", "strongly-connected-component", "eulerian-circuit",
  "radix-sort", "biconnected-component", "rejection-sampling"
] as const;

/**
 * Explicit site identifiers. Even entries whose spelling currently matches the
 * canonical id are listed so adapters never pass canonical ids through by
 * accident. LeetCode calls Go `golang` and Oracle SQL `oraclesql`.
 */
export const LANGUAGE_REMOTE_IDS: Readonly<
  Record<ContractRegion, Readonly<Record<CanonicalLanguage, string>>>
> = Object.freeze({
  global: Object.freeze({
    bash: "bash",
    c: "c",
    cpp: "cpp",
    csharp: "csharp",
    cangjie: "cangjie",
    dart: "dart",
    elixir: "elixir",
    erlang: "erlang",
    go: "golang",
    java: "java",
    javascript: "javascript",
    kotlin: "kotlin",
    mysql: "mysql",
    mssql: "mssql",
    oracle: "oraclesql",
    php: "php",
    python: "python",
    python3: "python3",
    racket: "racket",
    ruby: "ruby",
    rust: "rust",
    scala: "scala",
    swift: "swift",
    typescript: "typescript"
  }),
  cn: Object.freeze({
    bash: "bash",
    c: "c",
    cpp: "cpp",
    csharp: "csharp",
    cangjie: "cangjie",
    dart: "dart",
    elixir: "elixir",
    erlang: "erlang",
    go: "golang",
    java: "java",
    javascript: "javascript",
    kotlin: "kotlin",
    mysql: "mysql",
    mssql: "mssql",
    oracle: "oraclesql",
    php: "php",
    python: "python",
    python3: "python3",
    racket: "racket",
    ruby: "ruby",
    rust: "rust",
    scala: "scala",
    swift: "swift",
    typescript: "typescript"
  })
});

const REMOTE_LANGUAGE_ALIASES: Readonly<
  Record<ContractRegion, Readonly<Record<string, CanonicalLanguage>>>
> = Object.freeze({
  global: Object.freeze({ go: "go", oracle: "oracle" }),
  cn: Object.freeze({ go: "go", oracle: "oracle" })
});

export function canonicalLanguageToRemote(
  region: ContractRegion,
  language: string
): string | undefined {
  if (!(CANONICAL_LANGUAGE_IDS as readonly string[]).includes(language)) {
    return undefined;
  }
  return LANGUAGE_REMOTE_IDS[region][language as CanonicalLanguage];
}

export function remoteLanguageToCanonical(
  region: ContractRegion,
  remoteLanguage: string
): CanonicalLanguage | undefined {
  const normalized = remoteLanguage.trim().toLowerCase();
  const mapping = LANGUAGE_REMOTE_IDS[region];
  for (const language of CANONICAL_LANGUAGE_IDS) {
    if (mapping[language] === normalized) {
      return language;
    }
  }
  return REMOTE_LANGUAGE_ALIASES[region][normalized];
}

export const MAX_TESTCASE_BYTES = 200_000;
export const DIGEST_CANONICALIZATION = "RFC8785/JCS";
export const DIGEST_ENCODING = "UTF-8";
export const DIGEST_ALGORITHM = "SHA-256";

export const RegionSchema = Type.Union(
  [Type.Literal("global"), Type.Literal("cn")],
  { description: "LeetCode site region" }
);

export const DifficultySchema = Type.Union([
  Type.Literal("easy"),
  Type.Literal("medium"),
  Type.Literal("hard")
]);

export const LanguageSchema = Type.Union(
  [
    Type.Literal("bash"),
    Type.Literal("c"),
    Type.Literal("cpp"),
  Type.Literal("csharp"),
    Type.Literal("cangjie"),
    Type.Literal("dart"),
    Type.Literal("elixir"),
    Type.Literal("erlang"),
    Type.Literal("go"),
    Type.Literal("java"),
    Type.Literal("javascript"),
    Type.Literal("kotlin"),
    Type.Literal("mysql"),
    Type.Literal("mssql"),
    Type.Literal("oracle"),
    Type.Literal("php"),
    Type.Literal("python"),
    Type.Literal("python3"),
    Type.Literal("racket"),
    Type.Literal("ruby"),
    Type.Literal("rust"),
    Type.Literal("scala"),
    Type.Literal("swift"),
    Type.Literal("typescript")
  ],
  { description: "Canonical language identifier" }
);

/**
 * Execution tools additionally accept the one upstream spelling that differs
 * from the package's canonical vocabulary. Results and ledger records always
 * normalize this alias back to `go`.
 */
export const ExecutionLanguageSchema = Type.Union(
  [LanguageSchema, Type.Literal("golang")],
  { description: "Canonical language identifier or upstream LeetCode alias" }
);

export const ToolNameSchema = Type.Union([
  Type.Literal("lc_daily"),
  Type.Literal("lc_search"),
  Type.Literal("lc_problem"),
  Type.Literal("lc_solution_search"),
  Type.Literal("lc_solution"),
  Type.Literal("lc_profile"),
  Type.Literal("lc_contest"),
  Type.Literal("lc_progress"),
  Type.Literal("lc_history"),
  Type.Literal("lc_user_submissions"),
  Type.Literal("lc_submission"),
  Type.Literal("lc_run"),
  Type.Literal("lc_submit"),
  Type.Literal("lc_operation_status")
]);

export const ToolErrorCodeSchema = Type.Union([
  Type.Literal("VALIDATION_ERROR"),
  Type.Literal("AUTH_REQUIRED"),
  Type.Literal("AUTH_EXPIRED"),
  Type.Literal("PERMISSION_DENIED"),
  Type.Literal("INTERACTION_REQUIRED"),
  Type.Literal("NOT_FOUND"),
  Type.Literal("RATE_LIMITED"),
  Type.Literal("REMOTE_UNAVAILABLE"),
  Type.Literal("EXECUTION_FAILED"),
  Type.Literal("UNSUPPORTED_REGION"),
  Type.Literal("STALE_OPERATION"),
  Type.Literal("STALE_CURSOR"),
  Type.Literal("UNKNOWN_WRITE_OUTCOME"),
  Type.Literal("CANCELLED"),
  Type.Literal("CAPABILITY_UNAVAILABLE"),
  Type.Literal("REMOTE_SCHEMA_CHANGED"),
  Type.Literal("PROVIDER_CONFLICT"),
  Type.Literal("CONTRACT_MISMATCH"),
  Type.Literal("PROTOCOL_TIMEOUT")
]);

export const TitleSlugSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
  description: "LeetCode problem title slug"
});

export const UsernameSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[A-Za-z0-9_.-]+$",
  description: "Public LeetCode username or CN user slug"
});

export const SubmissionIdSchema = Type.String({
  minLength: 1,
  maxLength: 20,
  pattern: "^[0-9]+$",
  description: "Numeric LeetCode submission ID"
});

export const SolutionTopicIdSchema = Type.String({
  minLength: 1,
  maxLength: 32,
  pattern: "^[0-9]+$",
  description: "Global LeetCode solution topic ID"
});

export const SolutionSlugSchema = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*$",
  description: "LeetCode CN solution article slug"
});

const SafeIdentifierSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9._:-]+$"
});

const Sha256HexSchema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const Sha256DigestSchema = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });
const TimestampSchema = Type.String({ minLength: 1, maxLength: 64 });
const BoundedTextSchema = Type.String({ maxLength: 200_000 });
export const TestcaseSchema = Type.String({
  maxLength: MAX_TESTCASE_BYTES,
  description: `UTF-8 text limited to ${MAX_TESTCASE_BYTES} bytes at runtime`,
  "x-maxUtf8Bytes": MAX_TESTCASE_BYTES
});
const PaginationLimitSchema = Type.Integer({ minimum: 1, maximum: 50, default: 20 });
const SearchPaginationLimitSchema = Type.Integer({ minimum: 1, maximum: 50, default: 10 });
const OffsetSchema = Type.Integer({ minimum: 0, maximum: 10_000, default: 0 });
const UserNotesPaginationLimitSchema = Type.Integer({
  minimum: 1,
  maximum: 100,
  default: 10
});
const UserNotesSkipSchema = Type.Integer({ minimum: 0, maximum: 1_000_000, default: 0 });
const UserNoteIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[^\\u0000-\\u001f\\u007f]+$"
});
const UserNoteQuestionIdSchema = Type.String({
  minLength: 1,
  maxLength: 20,
  pattern: "^[0-9]+$",
  description: "Numeric LeetCode CN question ID, not a title slug"
});
const UserNoteContentSchema = Type.String({
  maxLength: 200_000,
  description: "Sensitive personal note body; markdown is preserved verbatim",
  "x-sensitive": true,
  "x-persistence": "never"
});
const UserNoteTitleSchema = Type.String({
  maxLength: 2_048,
  description: "Personal note title/summary"
});
const CursorSchema = Type.String({ minLength: 1, maxLength: 1_000 });
export const OperationIdSchema = SafeIdentifierSchema;
const TimeoutSchema = Type.Integer({ minimum: 1, maximum: 120_000, default: 120_000 });
const PollIntervalSchema = Type.Integer({ minimum: 1, maximum: 5_000, default: 1_500 });

export const DailyInputSchema = Type.Object(
  { region: Type.Optional(RegionSchema) },
  { additionalProperties: false }
);

export const SearchInputSchema = Type.Object(
  {
    region: Type.Optional(RegionSchema),
    category: Type.Optional(
      Type.String({ enum: PROBLEM_CATEGORIES, default: "all-code-essentials" })
    ),
    query: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    tags: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 64, enum: PROBLEM_TAGS }), {
        maxItems: 10,
        uniqueItems: true
      })
    ),
    difficulty: Type.Optional(DifficultySchema),
    limit: Type.Optional(SearchPaginationLimitSchema),
    offset: Type.Optional(OffsetSchema),
    cursor: Type.Optional(CursorSchema)
  },
  { additionalProperties: false }
);

export const ProblemInputSchema = Type.Object(
  {
    region: Type.Optional(RegionSchema),
    titleSlug: TitleSlugSchema,
    language: Type.Optional(LanguageSchema),
    includeResourcePayload: Type.Optional(Type.Boolean({ default: false }))
  },
  { additionalProperties: false }
);

export const SolutionSearchInputSchema = Type.Object(
  {
    region: Type.Optional(RegionSchema),
    titleSlug: TitleSlugSchema,
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 10 })),
    offset: Type.Optional(OffsetSchema),
    orderBy: Type.Optional(
      Type.Union([
        Type.Literal("HOT"),
        Type.Literal("MOST_RECENT"),
        Type.Literal("MOST_VOTES"),
        Type.Literal("DEFAULT"),
        Type.Literal("MOST_UPVOTE"),
        Type.Literal("NEWEST_TO_OLDEST"),
        Type.Literal("OLDEST_TO_NEWEST")
      ])
    ),
    query: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    tags: Type.Optional(
      Type.Array(
        Type.String({
          minLength: 1,
          maxLength: 128,
          pattern: "^[A-Za-z0-9+#._]+(?:-[A-Za-z0-9+#._]+)*$"
        }),
        { maxItems: 20, uniqueItems: true, default: [] }
      )
    )
  },
  { additionalProperties: false }
);

export const SolutionInputSchema = Type.Object(
  {
    region: Type.Optional(RegionSchema),
    topicId: Type.Optional(SolutionTopicIdSchema),
    slug: Type.Optional(SolutionSlugSchema)
  },
  {
    additionalProperties: false,
    anyOf: [{ required: ["topicId"] }, { required: ["slug"] }],
    not: { required: ["topicId", "slug"] }
  }
);

export const ProfileInputSchema = Type.Object(
  {
    region: Type.Optional(RegionSchema),
    username: UsernameSchema
  },
  { additionalProperties: false }
);

export const ContestInputSchema = Type.Object(
  {
    region: Type.Optional(RegionSchema),
    username: UsernameSchema,
    attendedOnly: Type.Optional(Type.Boolean({ default: true })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 50 })),
    offset: Type.Optional(OffsetSchema)
  },
  { additionalProperties: false }
);

export const ProgressInputSchema = Type.Object(
  {
    region: Type.Optional(RegionSchema),
    titleSlug: Type.Optional(TitleSlugSchema),
    status: Type.Optional(Type.Union([Type.Literal("solved"), Type.Literal("attempted")])),
    difficulty: Type.Optional(Type.Array(DifficultySchema, { maxItems: 3, uniqueItems: true })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 100 })),
    offset: Type.Optional(OffsetSchema)
  },
  { additionalProperties: false }
);

export const HistoryInputSchema = Type.Object(
  {
    region: Type.Optional(RegionSchema),
    scope: Type.Optional(Type.Union([Type.Literal("account"), Type.Literal("problem")])),
    titleSlug: Type.Optional(TitleSlugSchema),
    language: Type.Optional(LanguageSchema),
    status: Type.Optional(
      Type.Union([Type.Literal("accepted"), Type.Literal("wrong_answer")])
    ),
    limit: Type.Optional(PaginationLimitSchema),
    offset: Type.Optional(OffsetSchema),
    cursor: Type.Optional(CursorSchema)
  },
  { additionalProperties: false }
);

export const UserSubmissionsInputSchema = Type.Object(
  {
    region: Type.Optional(RegionSchema),
    username: UsernameSchema,
    mode: Type.Union([Type.Literal("recent"), Type.Literal("accepted")]),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 10 }))
  },
  { additionalProperties: false }
);

export const SubmissionDetailInputSchema = Type.Object(
  {
    region: Type.Optional(RegionSchema),
    submissionId: SubmissionIdSchema,
    includeCode: Type.Optional(Type.Boolean({ default: false }))
  },
  { additionalProperties: false }
);

export const RunInputSchema = Type.Object(
  {
    region: Type.Optional(RegionSchema),
    titleSlug: TitleSlugSchema,
    language: ExecutionLanguageSchema,
    code: Type.String({ minLength: 1, maxLength: 100_000 }),
    testcase: Type.Optional(TestcaseSchema),
    timeoutMs: Type.Optional(TimeoutSchema),
    pollIntervalMs: Type.Optional(PollIntervalSchema)
  },
  { additionalProperties: false }
);

export const SubmitInputSchema = Type.Object(
  {
    region: Type.Optional(RegionSchema),
    titleSlug: TitleSlugSchema,
    language: ExecutionLanguageSchema,
    code: Type.String({ minLength: 1, maxLength: 100_000 }),
    retryUnknownOperationId: Type.Optional(OperationIdSchema),
    resubmitCompletedOperationId: Type.Optional(OperationIdSchema),
    timeoutMs: Type.Optional(TimeoutSchema),
    pollIntervalMs: Type.Optional(PollIntervalSchema)
  },
  {
    additionalProperties: false,
    not: {
      required: ["retryUnknownOperationId", "resubmitCompletedOperationId"]
    }
  }
);

export const OperationStatusInputSchema = Type.Object(
  { operationId: OperationIdSchema },
  { additionalProperties: false }
);

export const NotesReadInputSchema = Type.Object(
  { region: RegionSchema, target: TitleSlugSchema },
  { additionalProperties: false }
);

export const NotesWriteInputSchema = Type.Object(
  {
    region: RegionSchema,
    target: TitleSlugSchema,
    content: Type.String({ maxLength: 16_384 }),
    expectedRevision: Type.Union([Sha256DigestSchema, Type.Null()])
  },
  { additionalProperties: false }
);

/**
 * Current-account personal Notes API. These schemas intentionally remain
 * separate from NotesReadInputSchema/NotesWriteInputSchema, which describe the
 * revisioned state port.
 */
export const UserNotesSearchInputSchema = Type.Object(
  {
    region: Type.Optional(RegionSchema),
    keyword: Type.Optional(Type.String({ maxLength: 2_048 })),
    limit: Type.Optional(UserNotesPaginationLimitSchema),
    skip: Type.Optional(UserNotesSkipSchema),
    orderBy: Type.Optional(
      Type.Union([Type.Literal("ASCENDING"), Type.Literal("DESCENDING")], {
        default: "DESCENDING"
      })
    )
  },
  { additionalProperties: false }
);

export const UserNotesGetInputSchema = Type.Object(
  {
    region: Type.Optional(RegionSchema),
    questionId: UserNoteQuestionIdSchema,
    limit: Type.Optional(UserNotesPaginationLimitSchema),
    skip: Type.Optional(UserNotesSkipSchema)
  },
  { additionalProperties: false }
);

export const UserNotesCreateInputSchema = Type.Object(
  {
    region: Type.Optional(RegionSchema),
    questionId: UserNoteQuestionIdSchema,
    content: UserNoteContentSchema,
    title: Type.Optional(Type.String({ maxLength: 2_048, default: "" }))
  },
  { additionalProperties: false }
);

export const UserNotesUpdateInputSchema = Type.Object(
  {
    region: Type.Optional(RegionSchema),
    noteId: UserNoteIdSchema,
    content: Type.Optional(
      Type.String({
        maxLength: 200_000,
        default: "",
        "x-sensitive": true,
        "x-persistence": "never"
      })
    ),
    title: Type.Optional(Type.String({ maxLength: 2_048, default: "" }))
  },
  { additionalProperties: false }
);

export const TopicTagSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 128 }),
    slug: Type.String({ minLength: 1, maxLength: 128 }),
    translatedName: Type.Optional(Type.String({ minLength: 1, maxLength: 128 }))
  },
  { additionalProperties: false }
);

export const ProblemSummarySchema = Type.Object(
  {
    questionId: Type.String({ minLength: 1, maxLength: 128 }),
    frontendId: Type.String({ minLength: 1, maxLength: 128 }),
    title: Type.String({ minLength: 1, maxLength: 512 }),
    translatedTitle: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    titleSlug: TitleSlugSchema,
    difficulty: DifficultySchema,
    paidOnly: Type.Boolean(),
    acRate: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
    status: Type.Optional(
      Type.Union([
        Type.Literal("not_started"),
        Type.Literal("attempted"),
        Type.Literal("solved")
      ])
    ),
    topicTags: Type.Array(TopicTagSchema, { maxItems: 100 })
  },
  { additionalProperties: false }
);

export const CodeSnippetSchema = Type.Object(
  {
    language: LanguageSchema,
    languageName: Type.String({ minLength: 1, maxLength: 128 }),
    code: Type.String({ maxLength: 100_000 })
  },
  { additionalProperties: false }
);

const NullableTextSchema = Type.Union([BoundedTextSchema, Type.Null()]);
const ProblemResourceCodeSnippetSchema = Type.Object(
  {
    lang: Type.String({ minLength: 1, maxLength: 128 }),
    langSlug: Type.String({ minLength: 1, maxLength: 128 }),
    code: Type.String({ maxLength: 100_000 })
  },
  { additionalProperties: false }
);
const ProblemResourceTopicTagSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 128 }),
    slug: Type.String({ minLength: 1, maxLength: 128 }),
    translatedName: Type.Optional(
      Type.Union([
        Type.String({ minLength: 1, maxLength: 128 }),
        Type.Null()
      ])
    )
  },
  { additionalProperties: false }
);
const ProblemContributorSchema = Type.Object(
  {
    username: Type.String({ maxLength: 128 }),
    profileUrl: Type.String({ maxLength: 2_048 }),
    avatarUrl: Type.String({ maxLength: 2_048 })
  },
  { additionalProperties: false }
);
const OfficialSolutionSchema = Type.Object(
  {
    id: Type.String({ maxLength: 128 }),
    canSeeDetail: Type.Boolean(),
    paidOnly: Type.Optional(Type.Boolean()),
    hasVideoSolution: Type.Optional(Type.Boolean()),
    paidOnlyVideo: Type.Optional(Type.Boolean())
  },
  { additionalProperties: false }
);
const ChallengeQuestionSchema = Type.Object(
  {
    id: Type.String({ maxLength: 128 }),
    date: Type.String({ maxLength: 32 }),
    incompleteChallengeCount: Type.Integer({ minimum: 0 }),
    streakCount: Type.Integer({ minimum: 0 }),
    type: Type.String({ maxLength: 128 })
  },
  { additionalProperties: false }
);

export const ProblemResourcePayloadSchema = Type.Object(
  {
    questionId: Type.String({ minLength: 1, maxLength: 128 }),
    questionFrontendId: Type.String({ minLength: 1, maxLength: 128 }),
    boundTopicId: Type.Union([Type.String({ maxLength: 128 }), Type.Null()]),
    title: Type.String({ minLength: 1, maxLength: 512 }),
    titleSlug: TitleSlugSchema,
    content: BoundedTextSchema,
    translatedTitle: Type.Union([Type.String({ maxLength: 512 }), Type.Null()]),
    translatedContent: NullableTextSchema,
    isPaidOnly: Type.Boolean(),
    difficulty: Type.String({ minLength: 1, maxLength: 32 }),
    acRate: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
    likes: Type.Integer({ minimum: 0 }),
    dislikes: Type.Integer({ minimum: 0 }),
    isLiked: Type.Union([Type.Boolean(), Type.Null()]),
    similarQuestions: Type.String({ maxLength: 200_000 }),
    exampleTestcases: Type.String({ maxLength: 200_000 }),
    contributors: Type.Array(ProblemContributorSchema, { maxItems: 100 }),
    topicTags: Type.Array(ProblemResourceTopicTagSchema, { maxItems: 100 }),
    companyTagStats: Type.Union([Type.String({ maxLength: 200_000 }), Type.Null()]),
    codeSnippets: Type.Array(ProblemResourceCodeSnippetSchema, { maxItems: 100 }),
    stats: Type.String({ maxLength: 200_000 }),
    hints: Type.Array(BoundedTextSchema, { maxItems: 100 }),
    solution: Type.Union([OfficialSolutionSchema, Type.Null()]),
    status: Type.Union([Type.String({ maxLength: 128 }), Type.Null()]),
    sampleTestCase: TestcaseSchema,
    metaData: Type.String({ maxLength: 200_000 }),
    judgerAvailable: Type.Boolean(),
    judgeType: Type.String({ maxLength: 128 }),
    mysqlSchemas: Type.Array(Type.String({ maxLength: 200_000 }), { maxItems: 100 }),
    enableRunCode: Type.Boolean(),
    enableTestMode: Type.Boolean(),
    enableDebugger: Type.Optional(Type.Boolean()),
    envInfo: Type.Optional(Type.String({ maxLength: 200_000 })),
    libraryUrl: Type.Union([Type.String({ maxLength: 2_048 }), Type.Null()]),
    adminUrl: Type.Optional(Type.Union([Type.String({ maxLength: 2_048 }), Type.Null()])),
    challengeQuestion: Type.Optional(Type.Union([ChallengeQuestionSchema, Type.Null()])),
    note: Type.Union([BoundedTextSchema, Type.Null()])
  },
  { additionalProperties: false }
);

const CnDailyQuestionPayloadSchema = Type.Object(
  {
    questionId: Type.String({ minLength: 1, maxLength: 128 }),
    frontendQuestionId: Type.String({ minLength: 1, maxLength: 128 }),
    title: Type.String({ minLength: 1, maxLength: 512 }),
    titleCn: Type.String({ minLength: 1, maxLength: 512 }),
    titleSlug: TitleSlugSchema,
    difficulty: Type.String({ minLength: 1, maxLength: 32 }),
    paidOnly: Type.Boolean(),
    acRate: Type.Number({ minimum: 0, maximum: 100 }),
    status: Type.Union([Type.String({ maxLength: 128 }), Type.Null()]),
    freqBar: Type.Union([Type.Number(), Type.Null()]),
    isFavor: Type.Boolean(),
    solutionNum: Type.Integer({ minimum: 0 }),
    hasVideoSolution: Type.Boolean(),
    topicTags: Type.Array(Type.Object({
      name: Type.String({ maxLength: 128 }),
      slug: Type.Optional(Type.String({ maxLength: 128 })),
      id: Type.String({ maxLength: 128 }),
      nameTranslated: Type.String({ maxLength: 128 })
    }, { additionalProperties: false }), { maxItems: 100 }),
    extra: Type.Object({
      topCompanyTags: Type.Array(Type.Object({
        imgUrl: Type.String({ maxLength: 2_048 }),
        slug: Type.String({ maxLength: 128 }),
        numSubscribed: Type.Integer({ minimum: 0 })
      }, { additionalProperties: false }), { maxItems: 100 })
    }, { additionalProperties: false })
  },
  { additionalProperties: false }
);

export const RegionalDailyPayloadSchema = Type.Union([
  Type.Object({
    date: Type.String({ minLength: 1, maxLength: 32 }),
    link: Type.String({ minLength: 1, maxLength: 2_048 }),
    question: ProblemResourcePayloadSchema
  }, { additionalProperties: false }),
  Type.Object({
    date: Type.String({ minLength: 1, maxLength: 32 }),
    userStatus: Type.Union([Type.String({ maxLength: 128 }), Type.Null()]),
    question: CnDailyQuestionPayloadSchema,
    lastSubmission: Type.Union([
      Type.Object({ id: Type.String({ maxLength: 128 }) }, { additionalProperties: false }),
      Type.Null()
    ])
  }, { additionalProperties: false })
]);

export const ProblemDetailSchema = Type.Object(
  {
    ...ProblemSummarySchema.properties,
    content: BoundedTextSchema,
    translatedContent: Type.Optional(BoundedTextSchema),
    defaultTestcase: Type.Optional(TestcaseSchema),
    exampleTestcases: Type.Array(TestcaseSchema, { maxItems: 100 }),
    availableLanguages: Type.Array(LanguageSchema, {
      maxItems: CANONICAL_LANGUAGE_IDS.length,
      uniqueItems: true
    }),
    selectedCodeSnippet: Type.Union([CodeSnippetSchema, Type.Null()]),
    enableRunCode: Type.Boolean(),
    hints: Type.Array(BoundedTextSchema, { maxItems: 100 }),
    similarQuestions: Type.Array(
      Type.Object(
        {
          titleSlug: TitleSlugSchema,
          difficulty: DifficultySchema
        },
        { additionalProperties: false }
      ),
      { maxItems: 3 }
    ),
    codeSnippets: Type.Array(CodeSnippetSchema, { maxItems: 3 }),
    resourcePayload: Type.Optional(ProblemResourcePayloadSchema)
  },
  { additionalProperties: false }
);

export const DailyChallengeSchema = Type.Object(
  {
    date: Type.String({ minLength: 1, maxLength: 32 }),
    link: Type.String({ minLength: 1, maxLength: 2_048 }),
    problem: ProblemSummarySchema,
    regionalPayload: RegionalDailyPayloadSchema
  },
  { additionalProperties: false }
);

const PageInfoBaseProperties = {
  offset: Type.Integer({ minimum: 0 }),
  limit: Type.Integer({ minimum: 1, maximum: 100 }),
  hasMore: Type.Boolean(),
  nextCursor: Type.Optional(CursorSchema)
} as const;

export const PageInfoSchema = Type.Union([
  Type.Object(
    {
      ...PageInfoBaseProperties,
      totalKind: Type.Literal("exact"),
      total: Type.Integer({ minimum: 0 })
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ...PageInfoBaseProperties,
      totalKind: Type.Literal("lower_bound"),
      total: Type.Integer({ minimum: 0 })
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ...PageInfoBaseProperties,
      totalKind: Type.Literal("unknown"),
      total: Type.Null()
    },
    { additionalProperties: false }
  )
]);

export const SearchProblemsResultSchema = Type.Object(
  {
    items: Type.Array(ProblemSummarySchema, { maxItems: 50 }),
    page: PageInfoSchema
  },
  { additionalProperties: false }
);

export const SolutionArticleSummarySchema = Type.Object(
  {
    topicId: Type.String({ minLength: 1, maxLength: 128 }),
    slug: Type.Optional(SolutionSlugSchema),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    summary: Type.Optional(
      Type.String({
        maxLength: 20_000,
        "x-sensitive": true,
        "x-disclosureRisk": "solution",
        "x-persistence": "never"
      })
    ),
    canSee: Type.Boolean(),
    hasVideoArticle: Type.Optional(Type.Boolean()),
    coverUrl: Type.Optional(Type.String({ maxLength: 2_048 }))
  },
  { additionalProperties: false }
);

export const SolutionSearchResultSchema = Type.Object(
  {
    titleSlug: TitleSlugSchema,
    items: Type.Array(SolutionArticleSummarySchema, { maxItems: 50 }),
    page: PageInfoSchema
  },
  { additionalProperties: false }
);

export const SolutionNavigationSchema = Type.Object(
  {
    topicId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    slug: Type.Optional(SolutionSlugSchema),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 512 }))
  },
  { additionalProperties: false }
);

export const SolutionDetailSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 512 }),
    slug: SolutionSlugSchema,
    topicId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    questionSlug: Type.Optional(TitleSlugSchema),
    content: Type.String({
      maxLength: 200_000,
      "x-sensitive": true,
      "x-disclosureRisk": "solution",
      "x-untrusted": true,
      "x-persistence": "never"
    }),
    tags: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      maxItems: 100,
      uniqueItems: true
    }),
    prev: Type.Optional(SolutionNavigationSchema),
    next: Type.Optional(SolutionNavigationSchema)
  },
  { additionalProperties: false }
);

export const ProgressProblemSchema = Type.Object(
  {
    frontendId: Type.String({ minLength: 1, maxLength: 128 }),
    title: Type.String({ minLength: 1, maxLength: 512 }),
    translatedTitle: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    titleSlug: TitleSlugSchema,
    difficulty: DifficultySchema,
    status: Type.Optional(Type.Union([
      Type.Literal("not_started"), Type.Literal("attempted"), Type.Literal("solved")
    ])),
    topicTags: Type.Array(TopicTagSchema, { maxItems: 100 }),
    lastSubmittedAt: Type.Optional(TimestampSchema),
    numSubmitted: Type.Optional(Type.Integer({ minimum: 0 })),
    lastResult: Type.Optional(Type.String({ maxLength: 128 }))
  },
  { additionalProperties: false }
);

export const ProblemProgressResultSchema = Type.Object(
  {
    filters: Type.Object({
      offset: Type.Integer({ minimum: 0 }),
      limit: Type.Integer({ minimum: 1, maximum: 100 }),
      questionStatus: Type.Optional(Type.Union([Type.Literal("SOLVED"), Type.Literal("ATTEMPTED")])),
      difficulty: Type.Optional(Type.Array(Type.Union([
        Type.Literal("EASY"), Type.Literal("MEDIUM"), Type.Literal("HARD")
      ]), { maxItems: 3, uniqueItems: true }))
    }, { additionalProperties: false }),
    items: Type.Array(ProgressProblemSchema, { maxItems: 100 }),
    page: PageInfoSchema
  },
  { additionalProperties: false }
);

export const SubmissionRecordSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    title: Type.String({ minLength: 1, maxLength: 512 }),
    titleSlug: Type.Optional(TitleSlugSchema),
    frontendId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    language: LanguageSchema,
    status: Type.String({ minLength: 1, maxLength: 128 }),
    timestamp: Type.Optional(TimestampSchema),
    runtime: Type.Optional(Type.String({ maxLength: 128 })),
    memory: Type.Optional(Type.String({ maxLength: 128 })),
    pending: Type.Optional(Type.Boolean())
  },
  { additionalProperties: false }
);

export const SubmissionHistoryResultSchema = Type.Object(
  {
    items: Type.Array(SubmissionRecordSchema, { maxItems: 50 }),
    page: PageInfoSchema
  },
  { additionalProperties: false }
);

export const PublicSubmissionRecordSchema = Type.Object(
  {
    id: Type.Optional(SubmissionIdSchema),
    title: Type.String({ minLength: 1, maxLength: 512 }),
    titleSlug: TitleSlugSchema,
    frontendId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    language: Type.Optional(LanguageSchema),
    status: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    timestamp: Type.Optional(TimestampSchema)
  },
  { additionalProperties: false }
);

export const UserSubmissionsResultSchema = Type.Object(
  {
    username: UsernameSchema,
    mode: Type.Union([Type.Literal("recent"), Type.Literal("accepted")]),
    items: Type.Array(PublicSubmissionRecordSchema, { maxItems: 20 }),
    page: PageInfoSchema
  },
  { additionalProperties: false }
);

export const DifficultyCountSchema = Type.Object(
  {
    difficulty: Type.String({ minLength: 1, maxLength: 32 }),
    count: Type.Integer({ minimum: 0 }),
    submissions: Type.Optional(Type.Integer({ minimum: 0 }))
  },
  { additionalProperties: false }
);

export const UserProfileSchema = Type.Object(
  {
    username: UsernameSchema,
    realName: Type.Optional(Type.String({ maxLength: 256 })),
    avatar: Type.Optional(Type.String({ maxLength: 2_048 })),
    aboutMe: Type.Optional(Type.String({ maxLength: 8_192 })),
    country: Type.Optional(Type.String({ maxLength: 128 })),
    location: Type.Optional(Type.String({ maxLength: 256 })),
    company: Type.Optional(Type.String({ maxLength: 256 })),
    school: Type.Optional(Type.String({ maxLength: 256 })),
    githubUrl: Type.Optional(Type.String({ maxLength: 2_048 })),
    ranking: Type.Optional(Type.Integer({ minimum: 0 })),
    siteRanking: Type.Optional(Type.Integer({ minimum: 0 })),
    totalSubmissions: Type.Optional(Type.Array(DifficultyCountSchema, { maxItems: 4 })),
    acceptedQuestions: Type.Optional(Type.Array(DifficultyCountSchema, { maxItems: 4 })),
    failedQuestions: Type.Optional(Type.Array(DifficultyCountSchema, { maxItems: 4 })),
    untouchedQuestions: Type.Optional(Type.Array(DifficultyCountSchema, { maxItems: 4 })),
    socialAccounts: Type.Optional(Type.Array(Type.Object({ provider: Type.Optional(Type.String({maxLength:128})), profileUrl: Type.String({maxLength:2048}) }, {additionalProperties:false}), {maxItems:50})),
    skillTopics: Type.Optional(Type.Array(Type.String({maxLength:128}), {maxItems:200})),
    topicAreaScores: Type.Optional(Type.Array(Type.Object({ slug: Type.String({maxLength:128}), score: Type.Number() }, {additionalProperties:false}), {maxItems:200}))
  },
  { additionalProperties: false }
);

export const ContestRankingSchema = Type.Object(
  {
    attendedContestsCount: Type.Optional(Type.Integer({ minimum: 0 })),
    rating: Type.Optional(Type.Number()),
    globalRanking: Type.Optional(Type.Integer({ minimum: 0 })),
    localRanking: Type.Optional(Type.Integer({ minimum: 0 })),
    globalTotalParticipants: Type.Optional(Type.Integer({ minimum: 0 })),
    localTotalParticipants: Type.Optional(Type.Integer({ minimum: 0 })),
    topPercentage: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
    badge: Type.Optional(Type.String({ minLength: 1, maxLength: 256 }))
  },
  { additionalProperties: false }
);

export const ContestHistoryRecordSchema = Type.Object(
  {
    attended: Type.Boolean(),
    title: Type.String({ minLength: 1, maxLength: 512 }),
    translatedTitle: Type.Optional(Type.String({ maxLength: 512 })),
    startTime: Type.Optional(TimestampSchema),
    totalProblems: Type.Optional(Type.Integer({ minimum: 0 })),
    solvedProblems: Type.Optional(Type.Integer({ minimum: 0 })),
    finishTimeSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
    rating: Type.Optional(Type.Number()),
    score: Type.Optional(Type.Number()),
    ranking: Type.Optional(Type.Integer({ minimum: 0 })),
    trend: Type.Optional(Type.String({ minLength: 1, maxLength: 64 }))
  },
  { additionalProperties: false }
);

export const UserContestResultSchema = Type.Object(
  {
    username: UsernameSchema,
    ranking: Type.Optional(ContestRankingSchema),
    history: Type.Array(ContestHistoryRecordSchema, { maxItems: 50 }),
    page: PageInfoSchema
  },
  { additionalProperties: false }
);

export const UserStatusInputSchema = Type.Object(
  { region: Type.Optional(RegionSchema) },
  { additionalProperties: false }
);

export const UserStatusSchema = Type.Union([
  Type.Object(
    {
      isSignedIn: Type.Literal(false),
      isAdmin: Type.Boolean(),
      useTranslation: Type.Optional(Type.Boolean())
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      isSignedIn: Type.Literal(true),
      username: UsernameSchema,
      displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      avatar: Type.Optional(Type.String({ maxLength: 2_048 })),
      isAdmin: Type.Boolean(),
      useTranslation: Type.Optional(Type.Boolean())
    },
    { additionalProperties: false }
  )
]);

export const SubmissionDetailSchema = Type.Object(
  {
    id: SubmissionIdSchema,
    titleSlug: TitleSlugSchema,
    language: LanguageSchema,
    status: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    statusCode: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    timestamp: Type.Optional(TimestampSchema),
    runtime: Type.Optional(Type.String({ maxLength: 128 })),
    memory: Type.Optional(Type.String({ maxLength: 128 })),
    runtimePercentile: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
    memoryPercentile: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
    passedTestCases: Type.Optional(Type.Integer({ minimum: 0 })),
    totalTestCases: Type.Optional(Type.Integer({ minimum: 0 })),
    code: Type.Optional(Type.String({ maxLength: 100_000 })),
    compileError: Type.Optional(BoundedTextSchema),
    runtimeError: Type.Optional(BoundedTextSchema),
    lastTestcase: Type.Optional(BoundedTextSchema),
    codeOutput: Type.Optional(BoundedTextSchema),
    expectedOutput: Type.Optional(BoundedTextSchema),
    stdout: Type.Optional(BoundedTextSchema)
  },
  { additionalProperties: false }
);

export const OperationKindSchema = Type.Union([Type.Literal("run"), Type.Literal("submit")]);
export const OperationStateSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("polling"),
  Type.Literal("completed"),
  Type.Literal("unknown"),
  Type.Literal("failed"),
  Type.Literal("cancelled")
]);

export const JudgeResultSchema = Type.Object(
  {
    state: Type.String({ minLength: 1, maxLength: 128 }),
    verdict: Type.Optional(Type.String({ maxLength: 128 })),
    statusMessage: Type.Optional(Type.String({ maxLength: 1_024 })),
    runtime: Type.Optional(Type.String({ maxLength: 128 })),
    memory: Type.Optional(Type.String({ maxLength: 128 })),
    stdout: Type.Optional(BoundedTextSchema),
    expectedOutput: Type.Optional(BoundedTextSchema),
    compileError: Type.Optional(BoundedTextSchema),
    runtimeError: Type.Optional(BoundedTextSchema),
    input: Type.Optional(BoundedTextSchema)
  },
  { additionalProperties: false }
);

const UpstreamJudgePayloadSchema = Type.Record(
  Type.String({ minLength: 1, maxLength: 128 }),
  Type.Unknown(),
  {
    maxProperties: 512,
    description:
      "Complete bounded JSON object returned by the pinned upstream start/check endpoint; available only on the originating call",
    "x-maxJsonBytes": 900_000,
    "x-maxDepth": 16,
    "x-persistence": "never",
    "x-sensitive": true
  }
);

export const OperationStatusSchema = Type.Object(
  {
    operationId: OperationIdSchema,
    kind: OperationKindSchema,
    state: OperationStateSchema,
    region: RegionSchema,
    titleSlug: TitleSlugSchema,
    language: LanguageSchema,
    codeHash: Sha256HexSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    remoteId: Type.Optional(SafeIdentifierSchema),
    questionId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    start: Type.Optional(UpstreamJudgePayloadSchema),
    checkUrl: Type.Optional(Type.String({
      minLength: 1,
      maxLength: 512,
      pattern:
        "^https://leetcode\\.(?:com|cn)/submissions/detail/[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*/check/$"
    })),
    check: Type.Optional(UpstreamJudgePayloadSchema),
    supersedesOperationId: Type.Optional(OperationIdSchema),
    repeatsOperationId: Type.Optional(OperationIdSchema),
    result: Type.Optional(JudgeResultSchema),
    errorCode: Type.Optional(ToolErrorCodeSchema)
  },
  { additionalProperties: false }
);

export const NotesRevisionModeSchema = Type.Union([
  Type.Literal("native-etag"),
  Type.Literal("best-effort-compare-and-set"),
  Type.Literal("unsupported")
]);

export const ToolCapabilitySchema = Type.Object(
  {
    name: ToolNameSchema,
    version: Type.String({ minLength: 1, maxLength: 64 }),
    supported: Type.Boolean(),
    configured: Type.Boolean(),
    currentlyAvailable: Type.Boolean(),
    reason: Type.Optional(Type.String({ maxLength: 128 })),
    requiresAuth: Type.Boolean(),
    consequence: Type.Union([
      Type.Literal("read"),
      Type.Literal("answer_read"),
      Type.Literal("sensitive_read"),
      Type.Literal("execution"),
      Type.Literal("external_write")
    ]),
    disclosureRisk: Type.Optional(Type.Literal("solution"))
  },
  { additionalProperties: false }
);

export const NotesCapabilitySchema = Type.Object(
  {
    supported: Type.Boolean(),
    configured: Type.Boolean(),
    currentlyAvailable: Type.Boolean(),
    reason: Type.Optional(Type.String({ maxLength: 128 })),
    revisionMode: NotesRevisionModeSchema,
    maxSize: Type.Integer({ minimum: 0 })
  },
  { additionalProperties: false }
);

export const NotesCapabilitiesSchema = Type.Object(
  { global: NotesCapabilitySchema, cn: NotesCapabilitySchema },
  { additionalProperties: false }
);

export const StaticToolCapabilitySchema = Type.Object(
  {
    name: ToolNameSchema,
    version: Type.String({ minLength: 1, maxLength: 64 }),
    requiresAuth: Type.Boolean(),
    consequence: Type.Union([
      Type.Literal("read"),
      Type.Literal("answer_read"),
      Type.Literal("sensitive_read"),
      Type.Literal("execution"),
      Type.Literal("external_write")
    ]),
    disclosureRisk: Type.Optional(Type.Literal("solution"))
  },
  { additionalProperties: false }
);

export const StaticNotesCapabilitySchema = Type.Object(
  {
    supported: Type.Boolean(),
    revisionMode: NotesRevisionModeSchema,
    maxSize: Type.Integer({ minimum: 0 })
  },
  { additionalProperties: false }
);

export const StaticCapabilityManifestSchema = Type.Object(
  {
    packageName: Type.Literal(PACKAGE_NAME),
    supportedRegions: Type.Array(RegionSchema, {
      minItems: 1,
      maxItems: 2,
      uniqueItems: true
    }),
    tools: Type.Array(StaticToolCapabilitySchema, {
      minItems: TOOL_NAMES.length,
      maxItems: TOOL_NAMES.length
    }),
    notesPort: Type.Object(
      { global: StaticNotesCapabilitySchema, cn: StaticNotesCapabilitySchema },
      { additionalProperties: false }
    )
  },
  { additionalProperties: false }
);

export const ReadinessValueSchema = Type.Union([
  Type.Boolean(),
  Type.Literal("unknown")
]);

export const RegionReadinessSchema = Type.Object(
  {
    configured: Type.Boolean(),
    publicReads: ReadinessValueSchema,
    sessionReads: ReadinessValueSchema,
    execution: ReadinessValueSchema,
    externalWrite: ReadinessValueSchema,
    notes: ReadinessValueSchema,
    retryAt: Type.Optional(TimestampSchema)
  },
  { additionalProperties: false }
);

export const CapabilitySnapshotSchema = Type.Object(
  {
    packageName: Type.Literal(PACKAGE_NAME),
    providerId: SafeIdentifierSchema,
    instanceId: SafeIdentifierSchema,
    contextRevision: Type.Integer({ minimum: 0 }),
    activeAccountProfileId: Type.Optional(SafeIdentifierSchema),
    packageVersion: Type.String({ minLength: 1, maxLength: 64 }),
    contractVersion: Type.String({ minLength: 1, maxLength: 64 }),
    protocolVersion: Type.String({ minLength: 1, maxLength: 64 }),
    schemaDigest: Sha256DigestSchema,
    behaviorManifestDigest: Sha256DigestSchema,
    capabilityManifestDigest: Sha256DigestSchema,
    snapshotRevision: Type.Integer({ minimum: 0 }),
    observedAt: TimestampSchema,
    supportedRegions: Type.Array(RegionSchema, { minItems: 1, maxItems: 2, uniqueItems: true }),
    tools: Type.Array(ToolCapabilitySchema, { maxItems: TOOL_NAMES.length }),
    notesPort: NotesCapabilitiesSchema,
    regionReadiness: Type.Object(
      { global: RegionReadinessSchema, cn: RegionReadinessSchema },
      { additionalProperties: false }
    ),
    interactiveUI: Type.Boolean()
  },
  { additionalProperties: false }
);

/** Backwards-compatible descriptor name used by the current Gateway API. */
export const CapabilityManifestSchema = CapabilitySnapshotSchema;

export const DiagnosticRegionSnapshotSchema = Type.Object(
  {
    configured: Type.Boolean(),
    sessionConfigured: Type.Boolean(),
    operationConfigured: Type.Boolean(),
    queueDepth: Type.Integer({ minimum: 0 }),
    queueLimit: Type.Integer({ minimum: 0 }),
    circuitState: Type.Union([
      Type.Literal("unknown"),
      Type.Literal("closed"),
      Type.Literal("open"),
      Type.Literal("half_open")
    ]),
    nextProbeAt: Type.Optional(TimestampSchema),
    lastSafeErrorCode: Type.Optional(ToolErrorCodeSchema)
  },
  { additionalProperties: false }
);

export const DiagnosticsSnapshotSchema = Type.Object(
  {
    packageName: Type.Literal(PACKAGE_NAME),
    packageVersion: Type.String({ minLength: 1, maxLength: 64 }),
    contractVersion: Type.String({ minLength: 1, maxLength: 64 }),
    protocolVersion: Type.String({ minLength: 1, maxLength: 64 }),
    schemaDigest: Sha256DigestSchema,
    behaviorManifestDigest: Sha256DigestSchema,
    capabilityManifestDigest: Sha256DigestSchema,
    providerId: SafeIdentifierSchema,
    instanceId: SafeIdentifierSchema,
    contextRevision: Type.Integer({ minimum: 0 }),
    activeAccountProfileId: Type.Optional(SafeIdentifierSchema),
    snapshotRevision: Type.Integer({ minimum: 0 }),
    observedAt: TimestampSchema,
    providerConflict: Type.Boolean(),
    storageWritable: Type.Boolean(),
    regions: Type.Object(
      {
        global: DiagnosticRegionSnapshotSchema,
        cn: DiagnosticRegionSnapshotSchema
      },
      { additionalProperties: false }
    )
  },
  { additionalProperties: false }
);

export const NotesDocumentSchema = Type.Object(
  {
    target: TitleSlugSchema,
    content: Type.String({ maxLength: 16_384 }),
    byteLength: Type.Integer({ minimum: 0, maximum: 16_384 }),
    revision: Type.Union([Sha256DigestSchema, Type.Null()]),
    revisionMode: NotesRevisionModeSchema,
    updatedAt: Type.Optional(TimestampSchema)
  },
  { additionalProperties: false }
);

export const UserNoteQuestionSchema = Type.Object(
  {
    linkTemplate: Type.String({ minLength: 1, maxLength: 2_048 }),
    questionId: UserNoteQuestionIdSchema,
    title: Type.String({ minLength: 1, maxLength: 512 }),
    translatedTitle: Type.Optional(
      Type.Union([Type.String({ maxLength: 512 }), Type.Null()])
    )
  },
  { additionalProperties: false }
);

export const UserNoteSchema = Type.Object(
  {
    id: UserNoteIdSchema,
    summary: UserNoteTitleSchema,
    content: UserNoteContentSchema,
    noteQuestion: Type.Optional(Type.Union([UserNoteQuestionSchema, Type.Null()]))
  },
  { additionalProperties: false }
);

export const UserNotesSearchResultSchema = Type.Object(
  {
    filters: Type.Object(
      {
        keyword: Type.Optional(Type.String({ maxLength: 2_048 })),
        orderBy: Type.Union([Type.Literal("ASCENDING"), Type.Literal("DESCENDING")])
      },
      { additionalProperties: false }
    ),
    pagination: Type.Object(
      {
        limit: UserNotesPaginationLimitSchema,
        skip: UserNotesSkipSchema,
        totalCount: Type.Integer({ minimum: 0 })
      },
      { additionalProperties: false }
    ),
    notes: Type.Array(UserNoteSchema, { maxItems: 100 })
  },
  { additionalProperties: false }
);

export const UserNotesGetResultSchema = Type.Object(
  {
    questionId: UserNoteQuestionIdSchema,
    count: Type.Integer({ minimum: 0 }),
    pagination: Type.Object(
      { limit: UserNotesPaginationLimitSchema, skip: UserNotesSkipSchema },
      { additionalProperties: false }
    ),
    notes: Type.Array(UserNoteSchema, { maxItems: 100 })
  },
  { additionalProperties: false }
);

export const UserNoteMutationNoteSchema = Type.Object(
  {
    id: UserNoteIdSchema,
    content: UserNoteContentSchema,
    targetId: Type.String({ minLength: 1, maxLength: 128 })
  },
  { additionalProperties: false }
);

export const UserNoteMutationResultSchema = Type.Object(
  {
    success: Type.Boolean(),
    note: Type.Union([UserNoteMutationNoteSchema, Type.Null()])
  },
  { additionalProperties: false }
);

export const ToolMetaSchema = Type.Object(
  {
    region: RegionSchema,
    packageVersion: Type.String({ minLength: 1, maxLength: 64 }),
    contractVersion: Type.String({ minLength: 1, maxLength: 64 }),
    schemaDigest: Sha256DigestSchema,
    behaviorManifestDigest: Sha256DigestSchema,
    instanceId: Type.String({ minLength: 1, maxLength: 128 }),
    contextRevision: Type.Integer({ minimum: 0 }),
    accountProfileId: Type.Optional(SafeIdentifierSchema),
    requestId: SafeIdentifierSchema,
    durationMs: Type.Optional(Type.Number({ minimum: 0 })),
    truncated: Type.Optional(Type.Boolean()),
    omittedFields: Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { maxItems: 100 }))
  },
  { additionalProperties: false }
);

const ToolErrorDetailValueSchema = Type.Union([
  Type.String({ maxLength: 2_048 }),
  Type.Number(),
  Type.Boolean(),
  Type.Null()
]);

export const ToolErrorSchema = Type.Object(
  {
    code: ToolErrorCodeSchema,
    message: Type.String({ minLength: 1, maxLength: 2_048 }),
    retryable: Type.Boolean(),
    retryAfterMs: Type.Optional(Type.Integer({ minimum: 0 })),
    operationId: Type.Optional(OperationIdSchema),
    details: Type.Optional(Type.Record(Type.String({ maxLength: 128 }), ToolErrorDetailValueSchema))
  },
  { additionalProperties: false }
);

export const ToolFailureSchema = Type.Object(
  { ok: Type.Literal(false), error: ToolErrorSchema, meta: ToolMetaSchema },
  { additionalProperties: false }
);

function toolResultSchema<T extends TSchema>(data: T) {
  return Type.Union([
    Type.Object(
      { ok: Type.Literal(true), data, meta: ToolMetaSchema },
      { additionalProperties: false }
    ),
    ToolFailureSchema
  ]);
}

export const DailyToolResultSchema = toolResultSchema(DailyChallengeSchema);
export const SearchToolResultSchema = toolResultSchema(SearchProblemsResultSchema);
export const ProblemToolResultSchema = toolResultSchema(ProblemDetailSchema);
export const SolutionSearchToolResultSchema = toolResultSchema(SolutionSearchResultSchema);
export const SolutionToolResultSchema = toolResultSchema(SolutionDetailSchema);
export const ProfileToolResultSchema = toolResultSchema(UserProfileSchema);
export const ContestToolResultSchema = toolResultSchema(UserContestResultSchema);
export const ProgressToolResultSchema = toolResultSchema(ProblemProgressResultSchema);
export const HistoryToolResultSchema = toolResultSchema(SubmissionHistoryResultSchema);
export const UserSubmissionsToolResultSchema = toolResultSchema(UserSubmissionsResultSchema);
export const SubmissionDetailToolResultSchema = toolResultSchema(SubmissionDetailSchema);
export const OperationToolResultSchema = toolResultSchema(OperationStatusSchema);
export const NotesDocumentResultSchema = toolResultSchema(NotesDocumentSchema);
export const NotesCapabilitiesResultSchema = toolResultSchema(NotesCapabilitiesSchema);
export const DiagnosticsSnapshotResultSchema = toolResultSchema(DiagnosticsSnapshotSchema);
export const UserStatusResultSchema = toolResultSchema(UserStatusSchema);
export const UserNotesSearchToolResultSchema = toolResultSchema(UserNotesSearchResultSchema);
export const UserNotesGetToolResultSchema = toolResultSchema(UserNotesGetResultSchema);
export const UserNoteMutationToolResultSchema = toolResultSchema(UserNoteMutationResultSchema);

export const TOOL_INPUT_SCHEMAS = {
  lc_daily: DailyInputSchema,
  lc_search: SearchInputSchema,
  lc_problem: ProblemInputSchema,
  lc_solution_search: SolutionSearchInputSchema,
  lc_solution: SolutionInputSchema,
  lc_profile: ProfileInputSchema,
  lc_contest: ContestInputSchema,
  lc_progress: ProgressInputSchema,
  lc_history: HistoryInputSchema,
  lc_user_submissions: UserSubmissionsInputSchema,
  lc_submission: SubmissionDetailInputSchema,
  lc_run: RunInputSchema,
  lc_submit: SubmitInputSchema,
  lc_operation_status: OperationStatusInputSchema
} as const satisfies Record<ToolName, TSchema>;

export const TOOL_OUTPUT_SCHEMAS = {
  lc_daily: DailyToolResultSchema,
  lc_search: SearchToolResultSchema,
  lc_problem: ProblemToolResultSchema,
  lc_solution_search: SolutionSearchToolResultSchema,
  lc_solution: SolutionToolResultSchema,
  lc_profile: ProfileToolResultSchema,
  lc_contest: ContestToolResultSchema,
  lc_progress: ProgressToolResultSchema,
  lc_history: HistoryToolResultSchema,
  lc_user_submissions: UserSubmissionsToolResultSchema,
  lc_submission: SubmissionDetailToolResultSchema,
  lc_run: OperationToolResultSchema,
  lc_submit: OperationToolResultSchema,
  lc_operation_status: OperationToolResultSchema
} as const satisfies Record<ToolName, TSchema>;

export interface ToolInputByName {
  lc_daily: Static<typeof DailyInputSchema>;
  lc_search: Static<typeof SearchInputSchema>;
  lc_problem: Static<typeof ProblemInputSchema>;
  lc_solution_search: Static<typeof SolutionSearchInputSchema>;
  lc_solution: Static<typeof SolutionInputSchema>;
  lc_profile: Static<typeof ProfileInputSchema>;
  lc_contest: Static<typeof ContestInputSchema>;
  lc_progress: Static<typeof ProgressInputSchema>;
  lc_history: Static<typeof HistoryInputSchema>;
  lc_user_submissions: Static<typeof UserSubmissionsInputSchema>;
  lc_submission: Static<typeof SubmissionDetailInputSchema>;
  lc_run: Static<typeof RunInputSchema>;
  lc_submit: Static<typeof SubmitInputSchema>;
  lc_operation_status: Static<typeof OperationStatusInputSchema>;
}

export const GATEWAY_RPC_METHODS = [
  "tool.execute",
  "notes.capabilities",
  "notes.read",
  "notes.write",
  "notes.search",
  "notes.get",
  "notes.create",
  "notes.update",
  "user.status",
  "diagnostics.getSnapshot"
] as const;

export type GatewayRpcMethodName = (typeof GATEWAY_RPC_METHODS)[number];

export const GatewayRpcMethodSchema = Type.Union([
  Type.Literal(GATEWAY_RPC_METHODS[0]),
  Type.Literal(GATEWAY_RPC_METHODS[1]),
  Type.Literal(GATEWAY_RPC_METHODS[2]),
  Type.Literal(GATEWAY_RPC_METHODS[3]),
  Type.Literal(GATEWAY_RPC_METHODS[4]),
  Type.Literal(GATEWAY_RPC_METHODS[5]),
  Type.Literal(GATEWAY_RPC_METHODS[6]),
  Type.Literal(GATEWAY_RPC_METHODS[7]),
  Type.Literal(GATEWAY_RPC_METHODS[8]),
  Type.Literal(GATEWAY_RPC_METHODS[9])
]);

export const GatewayDiscoveryRequestSchema = Type.Object(
  {
    protocolVersion: Type.Literal(PROTOCOL_VERSION),
    requestId: SafeIdentifierSchema,
    respond: Type.Any({ description: "Process-local one-shot discovery response callback" })
  },
  { additionalProperties: false }
);

export const GatewayDiscoveryResponseSchema = Type.Object(
  {
    protocolVersion: Type.Literal(PROTOCOL_VERSION),
    requestId: SafeIdentifierSchema,
    descriptor: CapabilityManifestSchema
  },
  { additionalProperties: false }
);

export const GatewayRpcRequestSchema = Type.Object(
  {
    protocolVersion: Type.String({ minLength: 1, maxLength: 64 }),
    requestId: SafeIdentifierSchema,
    providerId: SafeIdentifierSchema,
    instanceId: SafeIdentifierSchema,
    contextRevision: Type.Integer({ minimum: 0 }),
    method: GatewayRpcMethodSchema,
    params: Type.Any(),
    deadlineAt: Type.Integer({ minimum: 0 }),
    respond: Type.Any({ description: "Process-local one-shot RPC response callback" })
  },
  { additionalProperties: false }
);

export const GatewayResultSchema = Type.Union([
  DailyToolResultSchema,
  SearchToolResultSchema,
  ProblemToolResultSchema,
  SolutionSearchToolResultSchema,
  SolutionToolResultSchema,
  ProfileToolResultSchema,
  ContestToolResultSchema,
  ProgressToolResultSchema,
  HistoryToolResultSchema,
  UserSubmissionsToolResultSchema,
  SubmissionDetailToolResultSchema,
  OperationToolResultSchema,
  NotesDocumentResultSchema,
  NotesCapabilitiesResultSchema,
  UserNotesSearchToolResultSchema,
  UserNotesGetToolResultSchema,
  UserNoteMutationToolResultSchema,
  UserStatusResultSchema,
  DiagnosticsSnapshotResultSchema
]);

export const GatewayRpcResponseSchema = Type.Object(
  {
    protocolVersion: Type.Literal(PROTOCOL_VERSION),
    requestId: SafeIdentifierSchema,
    providerId: SafeIdentifierSchema,
    instanceId: SafeIdentifierSchema,
    contextRevision: Type.Integer({ minimum: 0 }),
    result: GatewayResultSchema
  },
  { additionalProperties: false }
);

export const GatewayLifecycleEventSchema = Type.Object(
  { descriptor: CapabilityManifestSchema },
  { additionalProperties: false }
);

export const TOOL_CONTRACT_DOCUMENT = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  packageName: PACKAGE_NAME,
  contractVersion: CONTRACT_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  schemas: {
    meta: ToolMetaSchema,
    error: ToolErrorSchema,
    failure: ToolFailureSchema,
    capabilityManifest: CapabilityManifestSchema,
    notesCapability: NotesCapabilitySchema,
    notesDocument: NotesDocumentSchema,
    userNote: UserNoteSchema,
    userNotesSearchResult: UserNotesSearchResultSchema,
    userNotesGetResult: UserNotesGetResultSchema,
    userNoteMutationResult: UserNoteMutationResultSchema,
    staticCapabilityManifest: StaticCapabilityManifestSchema,
    operationStatus: OperationStatusSchema,
    dailyChallenge: DailyChallengeSchema,
    searchProblemsResult: SearchProblemsResultSchema,
    problemDetail: ProblemDetailSchema,
    solutionSearchResult: SolutionSearchResultSchema,
    solutionDetail: SolutionDetailSchema,
    userProfile: UserProfileSchema,
    userContestResult: UserContestResultSchema,
    userStatus: UserStatusSchema,
    problemProgressResult: ProblemProgressResultSchema,
    submissionHistoryResult: SubmissionHistoryResultSchema,
    userSubmissionsResult: UserSubmissionsResultSchema,
    submissionDetail: SubmissionDetailSchema,
    capabilitySnapshot: CapabilitySnapshotSchema,
    diagnosticsSnapshot: DiagnosticsSnapshotSchema
  },
  tools: Object.fromEntries(
    TOOL_NAMES.map((name) => [
      name,
      { input: TOOL_INPUT_SCHEMAS[name], output: TOOL_OUTPUT_SCHEMAS[name] }
    ])
  ),
  notes: {
    capabilities: { output: NotesCapabilitiesResultSchema },
    read: { input: NotesReadInputSchema, output: NotesDocumentResultSchema },
    write: { input: NotesWriteInputSchema, output: NotesDocumentResultSchema },
    search: { input: UserNotesSearchInputSchema, output: UserNotesSearchToolResultSchema },
    get: { input: UserNotesGetInputSchema, output: UserNotesGetToolResultSchema },
    create: { input: UserNotesCreateInputSchema, output: UserNoteMutationToolResultSchema },
    update: { input: UserNotesUpdateInputSchema, output: UserNoteMutationToolResultSchema }
  },
  user: {
    status: { input: UserStatusInputSchema, output: UserStatusResultSchema }
  },
  diagnostics: {
    getSnapshot: { output: DiagnosticsSnapshotResultSchema }
  },
  errors: TOOL_ERROR_CODES,
  discovery: {
    channel: DISCOVERY_CHANNEL,
    request: GatewayDiscoveryRequestSchema,
    response: GatewayDiscoveryResponseSchema
  },
  rpc: {
    channel: RPC_CHANNEL,
    request: GatewayRpcRequestSchema,
    response: GatewayRpcResponseSchema,
    methods: GATEWAY_RPC_METHODS
  },
  lifecycle: {
    readyChannel: READY_CHANNEL,
    deactivatedChannel: DEACTIVATED_CHANNEL,
    event: GatewayLifecycleEventSchema
  }
} as const;

export const BEHAVIOR_MANIFEST = {
  manifestVersion: CONTRACT_VERSION,
  defaultRegion: Object.fromEntries(TOOL_NAMES.map((name) => [name, "global"])),
  gatewayRpcDefaults: {
    "user.status": { region: "global" },
    "notes.search": { region: "cn", limit: 10, skip: 0, orderBy: "DESCENDING" },
    "notes.get": { region: "cn", limit: 10, skip: 0 },
    "notes.create": { region: "cn", title: "" },
    "notes.update": { region: "cn", content: "", title: "" }
  },
  execution: {
    defaults: { timeoutMs: 120_000, pollIntervalMs: 1_500 },
    bounds: {
      timeoutMs: { minimum: 1, maximum: 120_000 },
      pollIntervalMs: { minimum: 1, maximum: 5_000, effectiveMinimum: 200 }
    },
    languageAliases: { golang: "go" },
    transientUpstreamEnvelope: {
      fields: ["questionId", "start", "checkUrl", "check"],
      maxJsonBytes: 900_000,
      maxDepth: 16,
      persistence: "never"
    }
  },
  userNotes: {
    namespace: "current-authenticated-user",
    region: "cn",
    managedNotesPortSeparated: true,
    sensitiveFields: ["content", "title", "keyword"],
    persistence: "never",
    writeConfirmation: "required-per-call",
    writeRetry: "never",
    uncertainWriteOutcome: "UNKNOWN_WRITE_OUTCOME"
  },
  dailyDate: {
    global: { timeZone: "America/Los_Angeles", representation: "site-calendar-date" },
    cn: { timeZone: "Asia/Shanghai", representation: "site-calendar-date" }
  },
  pagination: {
    defaultLimit: 20,
    maximumLimit: 50,
    defaultOffset: 0,
    ordering: "upstream-order-preserved",
    search: {
      totalKind: "exact",
      defaultCategory: "all-code-essentials",
      defaultLimit: 10,
      cursorFingerprintFields: ["category", "query", "tags(sorted)", "difficulty", "limit"]
    },
    progress: { totalKind: "exact", cursorFingerprintFields: null },
    history: {
      global: {
        totalKind: "lower_bound",
        cursorFingerprintFields: ["scope", "titleSlug", "language", "status", "limit"]
      },
      cn: {
        totalKind: "lower_bound",
        cursorFingerprintFields: ["scope", "titleSlug", "language", "status", "limit"]
      }
    },
    publicUserSubmissions: {
      maximumLimit: 20,
      pagination: "single-bounded-public-window"
    },
    cursor: {
      version: 1,
      signature: "HMAC-SHA-256",
      canonicalization: DIGEST_CANONICALIZATION,
      ttlMs: 900_000,
      maximumEncodedLength: 1_000,
      payloadBindings: [
        "tool",
        "region",
        "queryFingerprint",
        "profileId(if authenticated)",
        "offset",
        "remoteCursor(if present)",
        "expiresAt"
      ]
    }
  },
  language: {
    canonicalIds: CANONICAL_LANGUAGE_IDS,
    remoteIds: LANGUAGE_REMOTE_IDS,
    selection: "explicit-language-only",
    absentSelection: null
  },
  testcase: {
    maximumUtf8Bytes: MAX_TESTCASE_BYTES,
    defaultSource: "problem.defaultTestcase",
    preserveRemoteWhitespace: true,
    missingDefault: "VALIDATION_ERROR"
  },
  submissionDetail: {
    sourceCodeDefault: false,
    sourceCodeOptInField: "includeCode",
    sourceCodeMaximumUtf8Bytes: 100_000,
    persistence: "never"
  },
  solutionArticles: {
    disclosureRisk: "solution",
    contentTrust: "untrusted-answer-bearing",
    defaultLimit: 10,
    maximumLimit: 50,
    globalDefaultOrderBy: "HOT",
    cnDefaultOrderBy: "DEFAULT",
    persistence: "never",
    evidenceBodyStorage: "forbidden"
  },
  outputBounds: {
    transportResponseUtf8Bytes: {
      readDefault: 2_097_152,
      writeDefault: 1_048_576,
      configurableMaximum: 10_485_760,
      overflow: "REMOTE_SCHEMA_CHANGED"
    },
    items: { maximum: 50, overflow: "truncate-and-mark" },
    topicTags: { maximum: 100, overflow: "truncate-and-mark" },
    exampleTestcases: { maximum: 100, overflow: "truncate-and-mark" },
    availableLanguages: {
      maximum: CANONICAL_LANGUAGE_IDS.length,
      unknownRemoteLanguage: "omit-and-mark"
    },
    controlFields: {
      overflow: "REMOTE_SCHEMA_CHANGED",
      fields: [
        "operationId",
        "requestId",
        "codeHash",
        "revision",
        "cursor",
        "verdict",
        "error.code"
      ]
    },
    omissionMeta: {
      truncated: true,
      pointerFormat: "RFC6901 JSON Pointer",
      maximumPointers: 100
    }
  },
  remoteErrors: {
    http401: "AUTH_EXPIRED",
    http403: {
      authenticatedOperation: "AUTH_EXPIRED",
      unauthenticatedOperation: "PERMISSION_DENIED"
    },
    http429: "RATE_LIMITED",
    http5xx: "REMOTE_UNAVAILABLE",
    redirect: "REMOTE_UNAVAILABLE",
    malformedJson: "REMOTE_SCHEMA_CHANGED",
    graphqlAuthentication: {
      authenticatedOperation: "AUTH_EXPIRED",
      unauthenticatedOperation: "AUTH_REQUIRED"
    },
    graphqlNotFound: "NOT_FOUND",
    graphqlContract: "REMOTE_SCHEMA_CHANGED",
    aborted: "CANCELLED",
    uncertainWriteDispatch: "UNKNOWN_WRITE_OUTCOME"
  }
} as const;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export const STATIC_RESOURCE_CATALOG = {
  categories: PROBLEM_CATEGORIES,
  tags: PROBLEM_TAGS,
  languages: {
    upstream: UPSTREAM_PROGRAMMING_LANGS,
    canonical: CANONICAL_LANGUAGE_IDS,
    remoteIds: LANGUAGE_REMOTE_IDS
  }
} as const;

export const SCHEMA_DIGEST = `sha256:${createHash("sha256")
  .update(canonicalJson(TOOL_CONTRACT_DOCUMENT), "utf8")
  .digest("hex")}`;

export const BEHAVIOR_MANIFEST_DIGEST = `sha256:${createHash("sha256")
  .update(canonicalJson(BEHAVIOR_MANIFEST), "utf8")
  .digest("hex")}`;

export const RESOURCE_CATALOG_DIGEST = `sha256:${createHash("sha256")
  .update(canonicalJson(STATIC_RESOURCE_CATALOG), "utf8")
  .digest("hex")}`;

export const STATIC_CAPABILITY_MANIFEST = {
  packageName: PACKAGE_NAME,
  supportedRegions: ["global", "cn"],
  tools: TOOL_NAMES.map((name) => ({
    name,
    version: CONTRACT_VERSION,
    requiresAuth: ![
      "lc_daily",
      "lc_search",
      "lc_problem",
      "lc_solution_search",
      "lc_solution",
      "lc_profile",
      "lc_contest",
      "lc_user_submissions"
    ].includes(name),
    consequence:
      name === "lc_submit"
        ? "external_write"
        : name === "lc_run"
          ? "execution"
          : name === "lc_submission"
            ? "sensitive_read"
            : name === "lc_solution_search" || name === "lc_solution"
              ? "answer_read"
              : "read",
    ...(name === "lc_solution_search" || name === "lc_solution"
      ? { disclosureRisk: "solution" as const }
      : {})
  })),
  notesPort: {
    global: { supported: false, revisionMode: "unsupported", maxSize: 0 },
    cn: {
      supported: true,
      revisionMode: "best-effort-compare-and-set",
      maxSize: 16_384
    }
  }
} as const;

export const CAPABILITY_MANIFEST_DIGEST = `sha256:${createHash("sha256")
  .update(canonicalJson(STATIC_CAPABILITY_MANIFEST), "utf8")
  .digest("hex")}`;

export function isToolName(value: string): value is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(value);
}

export function normalizeToolInput(name: ToolName, input: unknown): unknown {
  const params = input as Record<string, unknown>;
  switch (name) {
    case "lc_daily":
      return { ...params, region: params.region ?? "global" };
    case "lc_search":
      return {
        ...params,
        region: params.region ?? "global",
        category: params.category ?? "all-code-essentials",
        limit: params.limit ?? 10,
        ...("cursor" in params && params.cursor !== undefined
          ? {}
          : { offset: params.offset ?? 0 })
      };
    case "lc_solution_search":
      return {
        ...params,
        region: params.region ?? "global",
        limit: params.limit ?? 10,
        offset: params.offset ?? 0,
        tags: params.tags ?? []
      };
    case "lc_solution":
      return { ...params, region: params.region ?? "global" };
    case "lc_progress":
      return {
        ...params,
        region: params.region ?? "global",
        limit: params.limit ?? 100,
        offset: params.offset ?? 0
      };
    case "lc_history":
      return {
        ...params,
        region: params.region ?? "global",
        scope: params.scope ?? (params.titleSlug === undefined ? "account" : "problem"),
        limit: params.limit ?? 20,
        ...(params.cursor === undefined ? { offset: params.offset ?? 0 } : {})
      };
    case "lc_user_submissions":
      return {
        ...params,
        region: params.region ?? "global",
        limit: params.limit ?? 10
      };
    case "lc_submission":
      return {
        ...params,
        region: params.region ?? "global",
        includeCode: params.includeCode ?? false
      };
    case "lc_problem":
      return {
        ...params,
        region: params.region ?? "global",
        includeResourcePayload: params.includeResourcePayload ?? false
      };
    case "lc_profile":
      return { ...params, region: params.region ?? "global" };
    case "lc_contest":
      return {
        ...params,
        region: params.region ?? "global",
        attendedOnly: params.attendedOnly ?? true,
        limit: params.limit ?? 50,
        offset: params.offset ?? 0
      };
    case "lc_run":
    case "lc_submit":
      return {
        ...params,
        region: params.region ?? "global",
        timeoutMs: params.timeoutMs ?? 120_000,
        pollIntervalMs: params.pollIntervalMs ?? 1_500
      };
    case "lc_operation_status":
      return params;
  }
}

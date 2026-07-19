import { convert } from "html-to-text";
import { Check } from "typebox/value";

import {
  CANONICAL_LANGUAGE_IDS,
  MAX_TESTCASE_BYTES,
  ProblemResourcePayloadSchema,
  RegionalDailyPayloadSchema,
  canonicalLanguageToRemote,
  remoteLanguageToCanonical,
  type CanonicalLanguage
} from "../../tool-calls/contract.js";
import type {
  CodeSnippet,
  DailyChallenge,
  Difficulty,
  ProblemDetail,
  ProblemProgressResult,
  ProblemResourcePayload,
  ProblemSummary,
  ProgressProblem,
  PublicSubmissionRecord,
  Region,
  RegionalDailyPayload,
  SearchProblemsResult,
  SolutionDetail,
  SolutionSearchResult,
  SubmissionDetail,
  SubmissionHistoryResult,
  SubmissionRecord,
  TopicTag,
  UserContestResult,
  UserProfile,
  UserStatus,
  UserSubmissionsResult
} from "../../types.js";
import { LeetCodeToolError } from "../errors.js";

const MAX_HTML_INPUT_LENGTH = 500_000;
const MAX_CONTENT_LENGTH = 200_000;
const MAX_CODE_SNIPPET_BYTES = 100_000;
const MAX_OUTPUT_ITEMS = 50;
const MAX_CONTEST_HISTORY_INPUT = 2_000;
const MAX_TOPIC_TAGS = 100;
const MAX_EXAMPLE_TESTCASES = 100;
const MAX_SOLUTION_SUMMARY_BYTES = 20_000;
const MAX_SOLUTION_CONTENT_BYTES = 200_000;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const TITLE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOLUTION_SLUG = /^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*$/u;
const SOLUTION_TOPIC_ID = /^\d+$/u;

type UnknownRecord = Record<string, unknown>;

function validateProblemResourcePayload(value: unknown, path: string): ProblemResourcePayload {
  if (!Check(ProblemResourcePayloadSchema, value)) {
    return schemaChanged(path);
  }
  return value as ProblemResourcePayload;
}

function validateRegionalDailyPayload(value: unknown): RegionalDailyPayload {
  if (!Check(RegionalDailyPayloadSchema, value)) {
    return schemaChanged("data.daily");
  }
  return value as RegionalDailyPayload;
}

export interface NormalizationMeta {
  readonly truncated: true;
  readonly omittedFields: readonly string[];
}

interface NormalizationCollector {
  readonly omittedFields: Set<string>;
}

const NORMALIZATION_META = new WeakMap<object, NormalizationMeta>();

function collector(): NormalizationCollector {
  return { omittedFields: new Set<string>() };
}

function markOmitted(state: NormalizationCollector, jsonPointer: string): void {
  state.omittedFields.add(jsonPointer);
}

function attachNormalizationMeta<T extends object>(
  value: T,
  state: NormalizationCollector
): T {
  if (state.omittedFields.size > 0) {
    NORMALIZATION_META.set(value, {
      truncated: true,
      omittedFields: [...state.omittedFields].sort()
    });
  }
  return value;
}

/**
 * Reads and consumes adapter-only metadata exactly once. Nested values are
 * visited so callers that wrap an item in a result object do not lose marks.
 */
export function takeNormalizationMeta(value: unknown): NormalizationMeta | undefined {
  const omittedFields = new Set<string>();
  const visited = new WeakSet<object>();
  const visit = (candidate: unknown): void => {
    if (typeof candidate !== "object" || candidate === null || visited.has(candidate)) {
      return;
    }
    visited.add(candidate);
    const meta = NORMALIZATION_META.get(candidate);
    if (meta !== undefined) {
      NORMALIZATION_META.delete(candidate);
      for (const field of meta.omittedFields) {
        omittedFields.add(field);
      }
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        visit(item);
      }
      return;
    }
    for (const item of Object.values(candidate)) {
      visit(item);
    }
  };
  visit(value);
  return omittedFields.size === 0
    ? undefined
    : { truncated: true, omittedFields: [...omittedFields].sort() };
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function schemaChanged(path: string): never {
  throw new LeetCodeToolError(
    "REMOTE_SCHEMA_CHANGED",
    "LeetCode returned an unexpected response shape",
    { details: { field: path } }
  );
}

function asRecord(value: unknown, path: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return schemaChanged(path);
  }

  return value as UnknownRecord;
}

function first(source: UnknownRecord, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) {
      return source[key];
    }
  }

  return undefined;
}

function cleanString(value: string, maxLength: number, path: string): string {
  const cleaned = value.replace(CONTROL_CHARACTERS, "").trim();
  if (cleaned.length === 0 || cleaned.length > maxLength) {
    return schemaChanged(path);
  }
  return cleaned;
}

function requiredString(
  source: UnknownRecord,
  keys: readonly string[],
  path: string,
  maxLength = 500
): string {
  const value = first(source, keys);
  if (typeof value !== "string" && typeof value !== "number") {
    return schemaChanged(path);
  }

  return cleanString(String(value), maxLength, path);
}

function optionalString(
  source: UnknownRecord,
  keys: readonly string[],
  path: string,
  maxLength = 500
): string | undefined {
  const value = first(source, keys);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" && typeof value !== "number") {
    return schemaChanged(path);
  }

  const stringValue = String(value).replace(CONTROL_CHARACTERS, "").trim();
  if (stringValue.length > maxLength) {
    return schemaChanged(path);
  }
  return stringValue.length === 0 ? undefined : stringValue;
}

function optionalCnOverseasCity(
  source: UnknownRecord,
  path: string
): string | undefined {
  const value = first(source, ["overseasCity"]);
  // LeetCode CN currently exposes this as a Boolean location classifier, while
  // older responses and the upstream type declaration described it as text.
  if (typeof value === "boolean") {
    return undefined;
  }
  return optionalString(source, ["overseasCity"], path, 128);
}

function requiredRemoteString(
  source: UnknownRecord,
  keys: readonly string[],
  path: string,
  maxLength: number
): string {
  const value = first(source, keys);
  if (typeof value !== "string") {
    return schemaChanged(path);
  }
  return cleanString(value, maxLength, path);
}

function optionalRemoteString(
  source: UnknownRecord,
  keys: readonly string[],
  path: string,
  maxLength: number
): string | undefined {
  const value = first(source, keys);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return schemaChanged(path);
  }
  const cleaned = value.replace(CONTROL_CHARACTERS, "").trim();
  if (cleaned.length > maxLength) {
    return schemaChanged(path);
  }
  return cleaned.length === 0 ? undefined : cleaned;
}

function optionalRawText(
  source: UnknownRecord,
  keys: readonly string[],
  path: string,
  maximumUtf8Bytes: number
): string | undefined {
  const value = first(source, keys);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || utf8Length(value) > maximumUtf8Bytes) {
    return schemaChanged(path);
  }
  return value;
}

function boundedSolutionText(
  value: unknown,
  path: string,
  maximumUtf8Bytes: number,
  maximumLength: number,
  trim: boolean
): string {
  if (
    typeof value !== "string" ||
    value.length > maximumLength ||
    utf8Length(value) > maximumUtf8Bytes
  ) {
    return schemaChanged(path);
  }
  const cleaned = value
    .replace(CONTROL_CHARACTERS, "")
    .replace(/\r\n?/g, "\n");
  return trim ? cleaned.trim() : cleaned;
}

function optionalSolutionText(
  source: UnknownRecord,
  keys: readonly string[],
  path: string,
  maximumUtf8Bytes: number,
  maximumLength: number
): string | undefined {
  const value = first(source, keys);
  if (value === undefined) {
    return undefined;
  }
  const normalized = boundedSolutionText(
    value,
    path,
    maximumUtf8Bytes,
    maximumLength,
    true
  );
  return normalized.length === 0 ? undefined : normalized;
}

function optionalPercentile(
  source: UnknownRecord,
  keys: readonly string[],
  path: string
): number | undefined {
  const value = optionalNumber(source, keys, path);
  if (value !== undefined && (value < 0 || value > 100)) {
    return schemaChanged(path);
  }
  return value;
}

function optionalCount(
  source: UnknownRecord,
  keys: readonly string[],
  path: string
): number | undefined {
  const value = optionalNumber(source, keys, path);
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    return schemaChanged(path);
  }
  return value;
}

function checkedTitleSlug(value: string, path: string): string {
  const normalized = value.trim().toLowerCase();
  if (!TITLE_SLUG.test(normalized)) {
    return schemaChanged(path);
  }
  return normalized;
}

function checkedSolutionSlug(value: string, path: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 256 ||
    !SOLUTION_SLUG.test(normalized)
  ) {
    return schemaChanged(path);
  }
  return normalized;
}

function checkedSolutionTopicId(value: string, path: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 32 ||
    !SOLUTION_TOPIC_ID.test(normalized)
  ) {
    return schemaChanged(path);
  }
  return normalized;
}

function normalizeSolutionVideoInfo(
  value: unknown,
  path: string
): UnknownRecord | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? undefined : asRecord(value[0], `${path}[0]`);
  }
  return asRecord(value, path);
}

function submissionTitleSlug(
  submission: UnknownRecord,
  requestedTitleSlug: string | undefined,
  path: string
): string | undefined {
  const direct = optionalString(submission, ["titleSlug"], `${path}.titleSlug`, 200);
  if (direct !== undefined) {
    return checkedTitleSlug(direct, `${path}.titleSlug`);
  }
  if (requestedTitleSlug !== undefined) {
    return checkedTitleSlug(requestedTitleSlug, `${path}.requestedTitleSlug`);
  }
  return undefined;
}

function requiredBoolean(
  source: UnknownRecord,
  keys: readonly string[],
  path: string
): boolean {
  const value = first(source, keys);
  if (typeof value !== "boolean") {
    return schemaChanged(path);
  }
  return value;
}

function optionalBoolean(
  source: UnknownRecord,
  keys: readonly string[],
  path: string
): boolean | undefined {
  const value = first(source, keys);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    return schemaChanged(path);
  }
  return value;
}

function optionalNumber(
  source: UnknownRecord,
  keys: readonly string[],
  path: string
): number | undefined {
  const value = first(source, keys);
  if (value === undefined) {
    return undefined;
  }

  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) {
    return schemaChanged(path);
  }
  return numberValue;
}

function requiredNumber(
  source: UnknownRecord,
  keys: readonly string[],
  path: string
): number {
  const value = optionalNumber(source, keys, path);
  return value === undefined ? schemaChanged(path) : value;
}

function requiredCount(
  source: UnknownRecord,
  keys: readonly string[],
  path: string
): number {
  const value = optionalNumber(source, keys, path);
  if (value === undefined || !Number.isInteger(value) || value < 0) {
    return schemaChanged(path);
  }
  return value;
}

function normalizeDifficulty(value: unknown, path: string): Difficulty {
  if (typeof value !== "string") {
    return schemaChanged(path);
  }

  switch (value.toLowerCase()) {
    case "easy":
      return "easy";
    case "medium":
      return "medium";
    case "hard":
      return "hard";
    default:
      return schemaChanged(path);
  }
}

function normalizeStatus(
  value: unknown,
  path: string
): ProblemSummary["status"] | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    return schemaChanged(path);
  }

  switch (value.toLowerCase().replaceAll("-", "_")) {
    case "ac":
    case "accepted":
    case "solved":
      return "solved";
    case "notac":
    case "not_ac":
    case "attempted":
      return "attempted";
    case "none":
    case "not_started":
    case "todo":
      return "not_started";
    default:
      return schemaChanged(path);
  }
}

function normalizeTopicTags(
  value: unknown,
  path: string,
  outputPath: string,
  state: NormalizationCollector
): TopicTag[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    return schemaChanged(path);
  }

  if (value.length > MAX_TOPIC_TAGS) {
    markOmitted(state, outputPath);
  }
  return value.slice(0, MAX_TOPIC_TAGS).map((item, index) => {
    const tag = asRecord(item, `${path}[${index}]`);
    const translatedName = optionalString(
      tag,
      ["translatedName", "nameTranslated"],
      `${path}[${index}].translatedName`
    );
    return {
      name: requiredString(tag, ["name"], `${path}[${index}].name`),
      slug: requiredString(tag, ["slug"], `${path}[${index}].slug`, 128),
      ...(translatedName === undefined ? {} : { translatedName })
    };
  });
}

function normalizeSummary(
  value: unknown,
  path: string,
  region: Region,
  state: NormalizationCollector,
  outputPath: string,
  sparse = false
): ProblemSummary {
  const question = asRecord(value, path);
  const frontendId = requiredString(
    question,
    ["questionFrontendId", "frontendQuestionId", "frontendId"],
    `${path}.frontendId`,
    100
  );
  const questionId =
    optionalString(question, ["questionId"], `${path}.questionId`, 100) ??
    frontendId;
  const titleSlug = requiredString(
    question,
    ["titleSlug"],
    `${path}.titleSlug`,
    200
  );
  if (!TITLE_SLUG.test(titleSlug)) {
    return schemaChanged(`${path}.titleSlug`);
  }

  const translatedTitle = optionalString(
    question,
    ["translatedTitle", "titleCn"],
    `${path}.translatedTitle`
  );
  const remoteAcRate = optionalNumber(question, ["acRate"], `${path}.acRate`);
  const acRate =
    remoteAcRate !== undefined && region === "cn" && remoteAcRate <= 1
      ? remoteAcRate * 100
      : remoteAcRate;
  if (acRate !== undefined && (acRate < 0 || acRate > 100)) {
    return schemaChanged(`${path}.acRate`);
  }
  const status = normalizeStatus(
    first(question, ["status", "questionStatus"]),
    `${path}.status`
  );
  const paidOnly = sparse
    ? (optionalBoolean(
        question,
        ["isPaidOnly", "paidOnly"],
        `${path}.paidOnly`
      ) ?? false)
    : requiredBoolean(
        question,
        ["isPaidOnly", "paidOnly"],
        `${path}.paidOnly`
      );

  return {
    questionId,
    frontendId,
    title: requiredString(question, ["title"], `${path}.title`),
    ...(translatedTitle === undefined ? {} : { translatedTitle }),
    titleSlug,
    difficulty: normalizeDifficulty(question.difficulty, `${path}.difficulty`),
    paidOnly,
    ...(acRate === undefined ? {} : { acRate }),
    ...(status === undefined ? {} : { status }),
    topicTags: normalizeTopicTags(
      question.topicTags,
      `${path}.topicTags`,
      `${outputPath}/topicTags`,
      state
    )
  };
}

function sanitizeHtml(html: string, path: string): string {
  if (html.length > MAX_HTML_INPUT_LENGTH) {
    return schemaChanged(path);
  }

  const text = convert(html, {
    wordwrap: false,
    preserveNewlines: true,
    limits: {
      maxInputLength: MAX_HTML_INPUT_LENGTH,
      maxChildNodes: 20_000,
      maxDepth: 100
    },
    selectors: [
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "noscript", format: "skip" },
      { selector: "svg", format: "skip" },
      { selector: "form", format: "skip" },
      { selector: "button", format: "skip" },
      { selector: "input", format: "skip" },
      { selector: "textarea", format: "skip" },
      { selector: "img", format: "skip" },
      { selector: "a", options: { ignoreHref: true } }
    ]
  })
    .replace(CONTROL_CHARACTERS, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();

  if (text.length > MAX_CONTENT_LENGTH) {
    return schemaChanged(path);
  }
  return text;
}

function normalizeDefaultTestcase(question: UnknownRecord, path: string): string | undefined {
  const value = first(question, ["sampleTestCase"]);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || utf8Length(value) > MAX_TESTCASE_BYTES) {
    return schemaChanged(path);
  }
  return value;
}

function normalizeExamples(
  question: UnknownRecord,
  path: string,
  state: NormalizationCollector
): string[] {
  const value = first(question, ["exampleTestcases"]);
  if (value === undefined) {
    return [];
  }

  const examples = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? [value]
      : schemaChanged(path);

  if (examples.length > MAX_EXAMPLE_TESTCASES) {
    markOmitted(state, "/exampleTestcases");
  }
  return examples.slice(0, MAX_EXAMPLE_TESTCASES).map((example, index) => {
    if (typeof example !== "string") {
      return schemaChanged(`${path}[${index}]`);
    }
    const cleaned = example.replace(CONTROL_CHARACTERS, "").trim();
    if (utf8Length(cleaned) > MAX_TESTCASE_BYTES) {
      return schemaChanged(`${path}[${index}]`);
    }
    return cleaned;
  }).filter((example) => example.length > 0);
}

function normalizeCodeSnippets(
  value: unknown,
  path: string,
  region: Region,
  state: NormalizationCollector
): ReadonlyMap<CanonicalLanguage, CodeSnippet> {
  if (value === undefined || value === null) {
    return new Map();
  }
  if (!Array.isArray(value)) {
    return schemaChanged(path);
  }

  const snippets = new Map<CanonicalLanguage, CodeSnippet>();
  value.forEach((item, index) => {
    const snippet = asRecord(item, `${path}[${index}]`);
    const code = first(snippet, ["code"]);
    if (
      typeof code !== "string" ||
      utf8Length(code) > MAX_CODE_SNIPPET_BYTES ||
      CONTROL_CHARACTERS.test(code)
    ) {
      CONTROL_CHARACTERS.lastIndex = 0;
      schemaChanged(`${path}[${index}].code`);
    }
    CONTROL_CHARACTERS.lastIndex = 0;
    const remoteLanguage = requiredString(
      snippet,
      ["langSlug", "language"],
      `${path}[${index}].language`,
      100
    );
    const language = remoteLanguageToCanonical(region, remoteLanguage);
    if (language === undefined) {
      markOmitted(state, "/availableLanguages");
      return;
    }
    if (snippets.has(language)) {
      schemaChanged(`${path}[${index}].language`);
    }
    snippets.set(language, {
      language,
      languageName: requiredString(
        snippet,
        ["lang", "languageName"],
        `${path}[${index}].languageName`,
        100
      ),
      code
    });
  });
  return snippets;
}

function normalizeTimestamp(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  let milliseconds: number;
  if (typeof value === "number") {
    milliseconds = value > 10_000_000_000 ? value : value * 1_000;
  } else if (typeof value === "string" && /^\d+$/.test(value)) {
    const numeric = Number(value);
    milliseconds = numeric > 10_000_000_000 ? numeric : numeric * 1_000;
  } else if (typeof value === "string") {
    milliseconds = Date.parse(value);
  } else {
    return schemaChanged(path);
  }

  if (!Number.isFinite(milliseconds)) {
    return schemaChanged(path);
  }
  return new Date(milliseconds).toISOString();
}

function normalizePending(value: unknown, path: string): boolean | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    switch (value.trim().toLowerCase()) {
      case "pending":
      case "true":
        return true;
      case "not pending":
      case "false":
        return false;
      default:
        return schemaChanged(path);
    }
  }
  return schemaChanged(path);
}

function safeProblemLink(region: Region, titleSlug: string): string {
  const origin = region === "global" ? "https://leetcode.com" : "https://leetcode.cn";
  return `${origin}/problems/${titleSlug}/`;
}

export function normalizeDailyChallenge(
  data: UnknownRecord,
  region: Region,
  invocationDate = new Date().toISOString().slice(0, 10)
): DailyChallenge {
  const state = collector();
  const value = first(data, ["activeDailyCodingChallengeQuestion", "todayRecord"]);
  const dailyValue = Array.isArray(value)
    ? value.length === 1
      ? value[0]
      : schemaChanged("data.todayRecord.length")
    : value;
  const daily = asRecord(dailyValue, "data.daily");
  const question = normalizeSummary(
    daily.question,
    "data.daily.question",
    region,
    state,
    "/problem"
  );
  const remoteDate = requiredString(daily, ["date"], "data.daily.date", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(remoteDate)) {
    return schemaChanged("data.daily.date");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(invocationDate)) {
    throw new LeetCodeToolError("VALIDATION_ERROR", "invocationDate must be a UTC calendar date");
  }

  return attachNormalizationMeta({
    date: invocationDate,
    link: safeProblemLink(region, question.titleSlug),
    problem: question,
    regionalPayload: validateRegionalDailyPayload(daily)
  }, state);
}

function normalizeProblemHints(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 100) {
    return schemaChanged("data.question.hints");
  }
  return value.map((hint, index) => {
    if (typeof hint !== "string") return schemaChanged(`data.question.hints[${index}]`);
    return sanitizeHtml(hint, `data.question.hints[${index}]`);
  });
}

function normalizeSimilarQuestions(value: unknown): Array<{ titleSlug: string; difficulty: Difficulty }> {
  if (value === undefined || value === null || value === "") return [];
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return schemaChanged("data.question.similarQuestions");
  return parsed.slice(0, 3).map((item, index) => {
    const record = asRecord(item, `data.question.similarQuestions[${index}]`);
    return {
      titleSlug: checkedTitleSlug(requiredString(record, ["titleSlug"], `data.question.similarQuestions[${index}].titleSlug`, 200), `data.question.similarQuestions[${index}].titleSlug`),
      difficulty: normalizeDifficulty(record.difficulty, `data.question.similarQuestions[${index}].difficulty`)
    };
  });
}

export function normalizeSearchProblems(
  data: UnknownRecord,
  region: Region,
  offset: number,
  limit: number
): SearchProblemsResult {
  const state = collector();
  const result = asRecord(
    first(data, ["problemsetQuestionList", "questionList"]),
    "data.problemsetQuestionList"
  );
  const questions = first(result, ["questions", "data"]);
  if (!Array.isArray(questions)) {
    return schemaChanged("data.problemsetQuestionList.questions");
  }
  if (questions.length > MAX_OUTPUT_ITEMS) {
    markOmitted(state, "/items");
  }
  const items = questions.slice(0, MAX_OUTPUT_ITEMS).map((question, index) =>
    normalizeSummary(
      question,
      `data.problemsetQuestionList.questions[${index}]`,
      region,
      state,
      `/items/${index}`
    )
  );
  const total = requiredCount(
    result,
    ["total", "totalNum"],
    "data.problemsetQuestionList.total"
  );
  const remoteHasMore = optionalBoolean(
    result,
    ["hasMore"],
    "data.problemsetQuestionList.hasMore"
  );

  return attachNormalizationMeta({
    items,
    page: {
      offset,
      limit,
      totalKind: "exact",
      total,
      hasMore: remoteHasMore ?? offset + items.length < total
    }
  }, state);
}

export function normalizeSolutionSearch(
  data: UnknownRecord,
  region: Region,
  titleSlug: string,
  offset: number,
  limit: number
): SolutionSearchResult {
  const state = collector();
  const rootValue =
    region === "global"
      ? data.ugcArticleSolutionArticles
      : data.questionSolutionArticles;
  if (rootValue === undefined || rootValue === null) {
    return {
      titleSlug,
      items: [],
      page: {
        offset,
        limit,
        totalKind: "exact",
        total: 0,
        hasMore: false
      }
    };
  }

  const result = asRecord(rootValue, "data.solutionArticles");
  const edges = result.edges;
  if (!Array.isArray(edges)) {
    return schemaChanged("data.solutionArticles.edges");
  }
  if (edges.length > MAX_OUTPUT_ITEMS) {
    markOmitted(state, "/items");
  }

  const items: SolutionSearchResult["items"][number][] = [];
  edges.slice(0, MAX_OUTPUT_ITEMS).forEach((edgeValue, index) => {
    const edgePath = `data.solutionArticles.edges[${index}]`;
    const edge = asRecord(edgeValue, edgePath);
    if (edge.node === undefined || edge.node === null) {
      return;
    }
    const node = asRecord(edge.node, `${edgePath}.node`);
    const canSee = requiredBoolean(node, ["canSee"], `${edgePath}.node.canSee`);
    if (!canSee) {
      return;
    }

    let topicId: string;
    if (region === "global") {
      topicId = checkedSolutionTopicId(
        requiredString(node, ["topicId"], `${edgePath}.node.topicId`, 32),
        `${edgePath}.node.topicId`
      );
    } else {
      const topic = asRecord(node.topic, `${edgePath}.node.topic`);
      topicId = checkedSolutionTopicId(
        requiredString(topic, ["id"], `${edgePath}.node.topic.id`, 32),
        `${edgePath}.node.topic.id`
      );
    }

    const rawSlug = optionalRemoteString(
      node,
      ["slug"],
      `${edgePath}.node.slug`,
      256
    );
    const slug =
      rawSlug === undefined
        ? undefined
        : checkedSolutionSlug(rawSlug, `${edgePath}.node.slug`);
    const title = optionalRemoteString(
      node,
      ["title"],
      `${edgePath}.node.title`,
      512
    );
    const summary = optionalSolutionText(
      node,
      ["summary"],
      `${edgePath}.node.summary`,
      MAX_SOLUTION_SUMMARY_BYTES,
      MAX_SOLUTION_SUMMARY_BYTES
    );
    const hasVideoArticle = optionalBoolean(
      node,
      ["hasVideoArticle"],
      `${edgePath}.node.hasVideoArticle`
    );
    const videosInfo = normalizeSolutionVideoInfo(
      node.videosInfo,
      `${edgePath}.node.videosInfo`
    );
    const coverUrl =
      videosInfo === undefined
        ? undefined
        : optionalRemoteString(
            videosInfo,
            ["coverUrl"],
            `${edgePath}.node.videosInfo.coverUrl`,
            2_048
          );

    items.push({
      topicId,
      ...(slug === undefined ? {} : { slug }),
      ...(title === undefined ? {} : { title }),
      ...(summary === undefined ? {} : { summary }),
      canSee,
      ...(hasVideoArticle === undefined ? {} : { hasVideoArticle }),
      ...(coverUrl === undefined ? {} : { coverUrl })
    });
  });

  const total = requiredCount(result, ["totalNum"], "data.solutionArticles.totalNum");
  const pageInfo =
    result.pageInfo === undefined || result.pageInfo === null
      ? undefined
      : asRecord(result.pageInfo, "data.solutionArticles.pageInfo");
  const remoteHasMore =
    pageInfo === undefined
      ? undefined
      : optionalBoolean(
          pageInfo,
          ["hasNextPage"],
          "data.solutionArticles.pageInfo.hasNextPage"
        );

  return attachNormalizationMeta({
    titleSlug,
    items,
    page: {
      offset,
      limit,
      totalKind: "exact",
      total,
      hasMore: remoteHasMore ?? offset + edges.length < total
    }
  }, state);
}

function normalizeSolutionNavigation(
  value: unknown,
  path: string
): NonNullable<SolutionDetail["prev"]> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const navigation = asRecord(value, path);
  const rawTopicId = optionalString(navigation, ["topicId"], `${path}.topicId`, 32);
  const topicId =
    rawTopicId === undefined
      ? undefined
      : checkedSolutionTopicId(rawTopicId, `${path}.topicId`);
  const rawSlug = optionalRemoteString(navigation, ["slug"], `${path}.slug`, 256);
  const slug =
    rawSlug === undefined ? undefined : checkedSolutionSlug(rawSlug, `${path}.slug`);
  const title = optionalRemoteString(navigation, ["title"], `${path}.title`, 512);
  if (topicId === undefined && slug === undefined && title === undefined) {
    return schemaChanged(path);
  }
  return {
    ...(topicId === undefined ? {} : { topicId }),
    ...(slug === undefined ? {} : { slug }),
    ...(title === undefined ? {} : { title })
  };
}

function normalizeSolutionTags(
  value: unknown,
  path: string,
  state: NormalizationCollector
): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    return schemaChanged(path);
  }
  if (value.length > MAX_TOPIC_TAGS) {
    markOmitted(state, "/tags");
  }
  const tags: string[] = [];
  const seen = new Set<string>();
  value.slice(0, MAX_TOPIC_TAGS).forEach((tagValue, index) => {
    const tag = asRecord(tagValue, `${path}[${index}]`);
    const slug = requiredRemoteString(
      tag,
      ["slug"],
      `${path}[${index}].slug`,
      128
    );
    if (!seen.has(slug)) {
      seen.add(slug);
      tags.push(slug);
    }
  });
  return tags;
}

export function normalizeSolutionDetail(
  data: UnknownRecord,
  region: Region,
  requested: { readonly topicId?: string; readonly slug?: string }
): SolutionDetail {
  const state = collector();
  const rootValue =
    region === "global" ? data.ugcArticleSolutionArticle : data.solutionArticle;
  if (rootValue === undefined || rootValue === null) {
    throw new LeetCodeToolError("NOT_FOUND", "LeetCode solution article was not found");
  }
  const root = asRecord(rootValue, "data.solutionArticle");
  const slug = checkedSolutionSlug(
    requiredRemoteString(root, ["slug"], "data.solutionArticle.slug", 256),
    "data.solutionArticle.slug"
  );
  if (requested.slug !== undefined && slug !== requested.slug) {
    return schemaChanged("data.solutionArticle.slug");
  }

  const topic =
    root.topic === undefined || root.topic === null
      ? undefined
      : asRecord(root.topic, "data.solutionArticle.topic");
  const rawTopicId =
    topic === undefined
      ? undefined
      : optionalString(topic, ["id"], "data.solutionArticle.topic.id", 32);
  const responseTopicId =
    rawTopicId === undefined
      ? undefined
      : checkedSolutionTopicId(rawTopicId, "data.solutionArticle.topic.id");
  if (
    requested.topicId !== undefined &&
    responseTopicId !== undefined &&
    responseTopicId !== requested.topicId
  ) {
    return schemaChanged("data.solutionArticle.topic.id");
  }
  const topicId = responseTopicId ?? requested.topicId;

  const question =
    root.question === undefined || root.question === null
      ? undefined
      : asRecord(root.question, "data.solutionArticle.question");
  const rawQuestionSlug =
    question === undefined
      ? undefined
      : optionalRemoteString(
          question,
          ["titleSlug"],
          "data.solutionArticle.question.titleSlug",
          200
        );
  const questionSlug =
    rawQuestionSlug === undefined
      ? undefined
      : checkedTitleSlug(
          rawQuestionSlug,
          "data.solutionArticle.question.titleSlug"
        );
  const prev = normalizeSolutionNavigation(root.prev, "data.solutionArticle.prev");
  const next = normalizeSolutionNavigation(root.next, "data.solutionArticle.next");

  return attachNormalizationMeta({
    title: requiredRemoteString(
      root,
      ["title"],
      "data.solutionArticle.title",
      512
    ),
    slug,
    ...(topicId === undefined ? {} : { topicId }),
    ...(questionSlug === undefined ? {} : { questionSlug }),
    content: boundedSolutionText(
      root.content,
      "data.solutionArticle.content",
      MAX_SOLUTION_CONTENT_BYTES,
      MAX_SOLUTION_CONTENT_BYTES,
      false
    ),
    tags: normalizeSolutionTags(root.tags, "data.solutionArticle.tags", state),
    ...(prev === undefined ? {} : { prev }),
    ...(next === undefined ? {} : { next })
  }, state);
}

export function normalizeProblemDetail(
  data: UnknownRecord,
  region: Region,
  requestedLanguage?: string,
  includeResourcePayload = false
): ProblemDetail {
  const state = collector();
  if (data.question === null || data.question === undefined) {
    throw new LeetCodeToolError("NOT_FOUND", "LeetCode problem was not found");
  }

  const question = asRecord(data.question, "data.question");
  const summary = normalizeSummary(question, "data.question", region, state, "");
  const rawContent = first(question, ["content"]);
  if (rawContent !== undefined && typeof rawContent !== "string") {
    return schemaChanged("data.question.content");
  }
  const rawTranslatedContent = first(question, ["translatedContent"]);
  if (
    rawTranslatedContent !== undefined &&
    typeof rawTranslatedContent !== "string"
  ) {
    return schemaChanged("data.question.translatedContent");
  }
  const translatedContent =
    typeof rawTranslatedContent === "string"
      ? sanitizeHtml(rawTranslatedContent, "data.question.translatedContent")
      : undefined;
  const enableRunCode = optionalBoolean(
    question,
    ["enableRunCode"],
    "data.question.enableRunCode"
  );
  const defaultTestcase = normalizeDefaultTestcase(
    question,
    "data.question.sampleTestCase"
  );
  const snippets = normalizeCodeSnippets(
    question.codeSnippets,
    "data.question.codeSnippets",
    region,
    state
  );
  const availableLanguages = CANONICAL_LANGUAGE_IDS.filter((language) =>
    snippets.has(language)
  );
  const parityCodeSnippets = (["cpp", "python3", "java"] as const)
    .map((language) => snippets.get(language))
    .filter((snippet): snippet is CodeSnippet => snippet !== undefined);
  let selectedCodeSnippet: CodeSnippet | null = null;
  if (requestedLanguage !== undefined) {
    const remoteLanguage = canonicalLanguageToRemote(region, requestedLanguage);
    const selected = snippets.get(requestedLanguage as CanonicalLanguage);
    if (remoteLanguage === undefined || selected === undefined) {
      throw new LeetCodeToolError(
        "VALIDATION_ERROR",
        "The requested language is not available for this LeetCode problem",
        {
          details: {
            requestedLanguage,
            availableLanguages: availableLanguages.join(",")
          }
        }
      );
    }
    selectedCodeSnippet = selected;
  }

  return attachNormalizationMeta({
    ...summary,
    content:
      typeof rawContent === "string"
        ? sanitizeHtml(rawContent, "data.question.content")
        : "",
    ...(translatedContent === undefined ? {} : { translatedContent }),
    ...(defaultTestcase === undefined ? {} : { defaultTestcase }),
    exampleTestcases: normalizeExamples(
      question,
      "data.question.exampleTestcases",
      state
    ),
    availableLanguages,
    selectedCodeSnippet,
    enableRunCode: enableRunCode ?? false,
    hints: normalizeProblemHints(question.hints),
    similarQuestions: normalizeSimilarQuestions(question.similarQuestions),
    codeSnippets: parityCodeSnippets,
    ...(includeResourcePayload
      ? { resourcePayload: validateProblemResourcePayload(question, "data.question") }
      : {})
  }, state);
}

export function normalizeProgressBySlug(
  data: UnknownRecord,
  region: Region
): ProgressProblem {
  const state = collector();
  if (data.question === null || data.question === undefined) {
    throw new LeetCodeToolError("NOT_FOUND", "LeetCode problem was not found");
  }
  return attachNormalizationMeta(
    normalizeProgressQuestion(data.question, "data.question", region, state, "/items/0"),
    state
  );
}

function normalizeProgressQuestion(
  value: unknown,
  path: string,
  _region: Region,
  state: NormalizationCollector,
  outputPath: string
): ProgressProblem {
  const question = asRecord(value, path);
  const titleSlug = checkedTitleSlug(
    requiredString(question, ["titleSlug"], `${path}.titleSlug`, 200),
    `${path}.titleSlug`
  );
  const translatedTitle = optionalString(
    question,
    ["translatedTitle", "titleCn"],
    `${path}.translatedTitle`,
    512
  );
  const status = normalizeStatus(
    first(question, ["questionStatus", "status"]),
    `${path}.questionStatus`
  );
  return {
    frontendId: requiredString(
      question,
      ["frontendId", "questionFrontendId", "frontendQuestionId"],
      `${path}.frontendId`,
      128
    ),
    title: requiredString(question, ["title"], `${path}.title`, 512),
    ...(translatedTitle === undefined ? {} : { translatedTitle }),
    titleSlug,
    difficulty: normalizeDifficulty(question.difficulty, `${path}.difficulty`),
    ...(status === undefined ? {} : { status }),
    topicTags: normalizeTopicTags(
      question.topicTags,
      `${path}.topicTags`,
      `${outputPath}/topicTags`,
      state
    )
  };
}

export function normalizeProgressList(
  data: UnknownRecord,
  region: Region,
  offset: number,
  limit: number,
  requestedFilters: {
    readonly questionStatus?: "SOLVED" | "ATTEMPTED";
    readonly difficulty?: readonly ("EASY" | "MEDIUM" | "HARD")[];
  } = {}
): ProblemProgressResult {
  const state = collector();
  const result = asRecord(
    data.userProgressQuestionList,
    "data.userProgressQuestionList"
  );
  const questions = result.questions;
  if (!Array.isArray(questions)) {
    return schemaChanged("data.userProgressQuestionList.questions");
  }

  if (questions.length > 100) {
    markOmitted(state, "/items");
  }
  const items = questions.slice(0, 100).map((item, index): ProgressProblem => {
    const path = `data.userProgressQuestionList.questions[${index}]`;
    const question = asRecord(item, path);
    const summary = normalizeProgressQuestion(question, path, region, state, `/items/${index}`);
    const lastSubmittedAt = normalizeTimestamp(
      question.lastSubmittedAt,
      `${path}.lastSubmittedAt`
    );
    const numSubmitted = optionalNumber(
      question,
      ["numSubmitted"],
      `${path}.numSubmitted`
    );
    if (
      numSubmitted !== undefined &&
      (!Number.isInteger(numSubmitted) || numSubmitted < 0)
    ) {
      return schemaChanged(`${path}.numSubmitted`);
    }
    const lastResult = optionalString(
      question,
      ["lastResult"],
      `${path}.lastResult`,
      100
    );

    return {
      ...summary,
      ...(lastSubmittedAt === undefined ? {} : { lastSubmittedAt }),
      ...(numSubmitted === undefined ? {} : { numSubmitted }),
      ...(lastResult === undefined ? {} : { lastResult })
    };
  });
  const total = requiredCount(
    result,
    ["totalNum", "total"],
    "data.userProgressQuestionList.totalNum"
  );

  return attachNormalizationMeta({
    filters: {
      offset,
      limit,
      ...(requestedFilters.questionStatus === undefined
        ? {}
        : { questionStatus: requestedFilters.questionStatus }),
      ...(requestedFilters.difficulty === undefined
        ? {}
        : { difficulty: [...requestedFilters.difficulty] })
    },
    items,
    page: {
      offset,
      limit,
      totalKind: "exact",
      total,
      hasMore: offset + items.length < total
    }
  }, state);
}

export function normalizeSubmissionHistory(
  data: UnknownRecord,
  region: Region,
  offset: number,
  limit: number,
  requestedTitleSlug?: string
): SubmissionHistoryResult {
  const state = collector();
  const result = asRecord(data.submissionList, "data.submissionList");
  if (!Array.isArray(result.submissions)) {
    return schemaChanged("data.submissionList.submissions");
  }

  if (result.submissions.length > MAX_OUTPUT_ITEMS) {
    markOmitted(state, "/items");
  }
  const items = result.submissions
    .slice(0, MAX_OUTPUT_ITEMS)
    .map((item, index): SubmissionRecord => {
    const path = `data.submissionList.submissions[${index}]`;
    const submission = asRecord(item, path);
    const timestamp = normalizeTimestamp(
      submission.timestamp,
      `${path}.timestamp`
    );
    const runtime = optionalString(
      submission,
      ["runtime"],
      `${path}.runtime`,
      100
    );
    const memory = optionalString(
      submission,
      ["memory"],
      `${path}.memory`,
      100
    );
    const pending = normalizePending(
      first(submission, ["isPending", "pending"]),
      `${path}.pending`
    );
    const remoteLanguage = requiredString(
      submission,
      ["lang", "langName", "language"],
      `${path}.language`,
      100
    );
    const language = remoteLanguageToCanonical(region, remoteLanguage);
    if (language === undefined) {
      return schemaChanged(`${path}.language`);
    }
    const titleSlug = submissionTitleSlug(submission, requestedTitleSlug, path);
    const frontendId = optionalString(
      submission,
      ["frontendId"],
      `${path}.frontendId`,
      64
    );

    return {
      id: requiredString(submission, ["id"], `${path}.id`, 100),
      title: requiredString(submission, ["title"], `${path}.title`),
      ...(titleSlug === undefined ? {} : { titleSlug }),
      ...(frontendId === undefined ? {} : { frontendId }),
      language,
      status: requiredString(
        submission,
        ["statusDisplay", "status"],
        `${path}.status`,
        100
      ),
      ...(timestamp === undefined ? {} : { timestamp }),
      ...(runtime === undefined ? {} : { runtime }),
      ...(memory === undefined ? {} : { memory }),
      ...(pending === undefined ? {} : { pending })
    };
    });
  const hasMore = optionalBoolean(
    result,
    ["hasNext", "hasMore"],
    "data.submissionList.hasNext"
  ) ?? false;
  const nextCursor = optionalString(
    result,
    ["lastKey", "nextCursor"],
    "data.submissionList.lastKey",
    1_000
  );

  // The upstream cursor API does not expose an exact total. This is the
  // minimum count known from the current page; hasMore/nextCursor are exact.
  const minimumKnownTotal = offset + items.length + (hasMore ? 1 : 0);
  return attachNormalizationMeta({
    items,
    page: {
      offset,
      limit,
      totalKind: "lower_bound",
      total: minimumKnownTotal,
      hasMore,
      ...(hasMore && nextCursor !== undefined ? { nextCursor } : {})
    }
  }, state);
}

export function normalizeUserSubmissions(
  data: UnknownRecord,
  region: Region,
  username: string,
  mode: "recent" | "accepted",
  limit: number
): UserSubmissionsResult {
  const state = collector();
  const rawItems = first(data, [
    mode === "accepted" ? "recentAcSubmissionList" : "recentSubmissionList",
    "recentACSubmissions"
  ]);
  if (!Array.isArray(rawItems)) {
    return schemaChanged("data.recentSubmissions");
  }
  if (rawItems.length > 20) {
    markOmitted(state, "/items");
  }

  const items = rawItems.slice(0, Math.min(limit, 20)).map((item, index): PublicSubmissionRecord => {
    const path = `data.recentSubmissions[${index}]`;
    const record = asRecord(item, path);
    const question =
      region === "cn" ? asRecord(record.question, `${path}.question`) : record;
    const titleSlug = checkedTitleSlug(
      requiredString(question, ["titleSlug"], `${path}.titleSlug`, 200),
      `${path}.titleSlug`
    );
    const remoteLanguage = optionalString(record, ["lang", "language"], `${path}.language`, 100);
    const language =
      remoteLanguage === undefined
        ? undefined
        : remoteLanguageToCanonical(region, remoteLanguage);
    if (remoteLanguage !== undefined && language === undefined) {
      return schemaChanged(`${path}.language`);
    }
    const id = optionalString(record, ["id", "submissionId"], `${path}.id`, 20);
    if (id !== undefined && !/^\d+$/u.test(id)) {
      return schemaChanged(`${path}.id`);
    }
    const timestamp = normalizeTimestamp(
      first(record, ["timestamp", "time", "submitTime"]),
      `${path}.timestamp`
    );
    const status =
      optionalString(record, ["statusDisplay", "status"], `${path}.status`, 128) ??
      (mode === "accepted" ? "Accepted" : undefined);
    return {
      ...(id === undefined ? {} : { id }),
      title: requiredString(
        question,
        region === "cn" ? ["translatedTitle", "title"] : ["title"],
        `${path}.title`
      ),
      titleSlug,
      ...(region === "cn"
        ? {
            frontendId: requiredString(
              question,
              ["questionFrontendId"],
              `${path}.frontendId`,
              64
            )
          }
        : {}),
      ...(language === undefined ? {} : { language }),
      ...(status === undefined ? {} : { status }),
      ...(timestamp === undefined ? {} : { timestamp })
    };
  });

  return attachNormalizationMeta({
    username,
    mode,
    items,
    page: {
      offset: 0,
      limit,
      totalKind: "lower_bound",
      total: items.length,
      hasMore: false
    }
  }, state);
}

export function normalizeSubmissionDetail(
  data: UnknownRecord,
  region: Region,
  requestedId: string,
  includeCode: boolean
): SubmissionDetail {
  const root = asRecord(
    first(data, ["submissionDetails", "submissionDetail"]),
    "data.submissionDetail"
  );
  const id = requiredString(root, ["id"], "data.submissionDetail.id", 20);
  if (id !== requestedId || !/^\d+$/u.test(id)) {
    return schemaChanged("data.submissionDetail.id");
  }
  const question = asRecord(root.question, "data.submissionDetail.question");
  const titleSlug = checkedTitleSlug(
    requiredString(question, ["titleSlug"], "data.submissionDetail.question.titleSlug", 200),
    "data.submissionDetail.question.titleSlug"
  );
  const languageSource = first(root, ["lang", "language"]);
  const remoteLanguage =
    typeof languageSource === "object" && languageSource !== null && !Array.isArray(languageSource)
      ? requiredString(languageSource as UnknownRecord, ["name", "verboseName"], "data.submissionDetail.lang", 100)
      : requiredString(root, ["lang", "langVerboseName"], "data.submissionDetail.lang", 100);
  const language = remoteLanguageToCanonical(region, remoteLanguage);
  if (language === undefined) {
    return schemaChanged("data.submissionDetail.lang");
  }
  const code = optionalRawText(root, ["code"], "data.submissionDetail.code", 100_000);
  if (includeCode && code === undefined) {
    return schemaChanged("data.submissionDetail.code");
  }
  const outputDetail =
    root.outputDetail === undefined || root.outputDetail === null
      ? root
      : asRecord(root.outputDetail, "data.submissionDetail.outputDetail");
  const timestamp = normalizeTimestamp(root.timestamp, "data.submissionDetail.timestamp");
  const runtime = optionalString(root, ["runtimeDisplay", "runtime"], "data.submissionDetail.runtime", 128);
  const memory = optionalString(root, ["memoryDisplay", "memory"], "data.submissionDetail.memory", 128);
  const status = optionalString(root, ["statusDisplay"], "data.submissionDetail.status", 128);
  const statusCode = optionalString(root, ["statusCode"], "data.submissionDetail.statusCode", 64);
  const runtimePercentile = optionalPercentile(
    root,
    ["runtimePercentile"],
    "data.submissionDetail.runtimePercentile"
  );
  const memoryPercentile = optionalPercentile(
    root,
    ["memoryPercentile"],
    "data.submissionDetail.memoryPercentile"
  );
  const passedTestCases = optionalCount(
    root,
    ["passedTestCaseCnt", "totalCorrect"],
    "data.submissionDetail.passedTestCases"
  );
  const totalTestCases = optionalCount(
    root,
    ["totalTestCaseCnt", "totalTestcases"],
    "data.submissionDetail.totalTestCases"
  );
  const compileError = optionalRawText(outputDetail, ["compileError"], "data.submissionDetail.compileError", 200_000);
  const runtimeError = optionalRawText(outputDetail, ["runtimeError"], "data.submissionDetail.runtimeError", 200_000);
  const lastTestcase = optionalRawText(outputDetail, ["lastTestcase", "input"], "data.submissionDetail.lastTestcase", 200_000);
  const codeOutput = optionalRawText(outputDetail, ["codeOutput"], "data.submissionDetail.codeOutput", 200_000);
  const expectedOutput = optionalRawText(outputDetail, ["expectedOutput"], "data.submissionDetail.expectedOutput", 200_000);
  const stdout = optionalRawText(root, ["stdOutput"], "data.submissionDetail.stdout", 200_000);

  return {
    id,
    titleSlug,
    language,
    ...(status === undefined ? {} : { status }),
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(runtime === undefined ? {} : { runtime }),
    ...(memory === undefined ? {} : { memory }),
    ...(runtimePercentile === undefined ? {} : { runtimePercentile }),
    ...(memoryPercentile === undefined ? {} : { memoryPercentile }),
    ...(passedTestCases === undefined ? {} : { passedTestCases }),
    ...(totalTestCases === undefined ? {} : { totalTestCases }),
    ...(!includeCode || code === undefined ? {} : { code }),
    ...(compileError === undefined ? {} : { compileError }),
    ...(runtimeError === undefined ? {} : { runtimeError }),
    ...(lastTestcase === undefined ? {} : { lastTestcase }),
    ...(codeOutput === undefined ? {} : { codeOutput }),
    ...(expectedOutput === undefined ? {} : { expectedOutput }),
    ...(stdout === undefined ? {} : { stdout })
  };
}

function normalizeDifficultyCounts(
  value: unknown,
  path: string
): NonNullable<UserProfile["totalSubmissions"]> {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 4) {
    return schemaChanged(path);
  }
  return value.map((item, index) => {
    const entry = asRecord(item, `${path}[${index}]`);
    const submissions = optionalCount(
      entry,
      ["submissions"],
      `${path}[${index}].submissions`
    );
    return {
      difficulty: requiredString(
        entry,
        ["difficulty"],
        `${path}[${index}].difficulty`,
        32
      ),
      count: requiredCount(entry, ["count"], `${path}[${index}].count`),
      ...(submissions === undefined ? {} : { submissions })
    };
  });
}

function optionalNestedName(
  source: UnknownRecord,
  key: string,
  path: string
): string | undefined {
  const value = source[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return cleanString(value, 256, path);
  }
  return optionalString(asRecord(value, path), ["name"], `${path}.name`, 256);
}

export function normalizeUserProfile(
  data: UnknownRecord,
  region: Region,
  requestedUsername: string
): UserProfile {
  const state = collector();
  if (region === "global") {
    if (data.matchedUser === null || data.matchedUser === undefined) {
      throw new LeetCodeToolError("NOT_FOUND", "LeetCode user was not found");
    }
    const user = asRecord(data.matchedUser, "data.matchedUser");
    const profile = asRecord(user.profile, "data.matchedUser.profile");
    const submitStats =
      user.submitStats === undefined || user.submitStats === null
        ? undefined
        : asRecord(user.submitStats, "data.matchedUser.submitStats");
    const totalSubmissions = normalizeDifficultyCounts(
      submitStats?.totalSubmissionNum,
      "data.matchedUser.submitStats.totalSubmissionNum"
    );
    const acceptedQuestions = normalizeDifficultyCounts(
      submitStats?.acSubmissionNum,
      "data.matchedUser.submitStats.acSubmissionNum"
    );
    const username = requiredString(user, ["username"], "data.matchedUser.username", 64);
    if (username.toLowerCase() !== requestedUsername.toLowerCase()) {
      return schemaChanged("data.matchedUser.username");
    }
    const ranking = optionalCount(profile, ["ranking"], "data.matchedUser.profile.ranking");
    return attachNormalizationMeta({
      username,
      ...(optionalString(profile, ["realName"], "data.matchedUser.profile.realName", 256) === undefined
        ? {}
        : { realName: optionalString(profile, ["realName"], "data.matchedUser.profile.realName", 256)! }),
      ...(optionalString(profile, ["userAvatar"], "data.matchedUser.profile.userAvatar", 2_048) === undefined
        ? {}
        : { avatar: optionalString(profile, ["userAvatar"], "data.matchedUser.profile.userAvatar", 2_048)! }),
      ...(optionalString(profile, ["aboutMe"], "data.matchedUser.profile.aboutMe", 8_192) === undefined
        ? {}
        : { aboutMe: optionalString(profile, ["aboutMe"], "data.matchedUser.profile.aboutMe", 8_192)! }),
      ...(optionalString(profile, ["countryName"], "data.matchedUser.profile.countryName", 128) === undefined
        ? {}
        : { country: optionalString(profile, ["countryName"], "data.matchedUser.profile.countryName", 128)! }),
      ...(optionalString(profile, ["company"], "data.matchedUser.profile.company", 256) === undefined
        ? {}
        : { company: optionalString(profile, ["company"], "data.matchedUser.profile.company", 256)! }),
      ...(optionalString(profile, ["school"], "data.matchedUser.profile.school", 256) === undefined
        ? {}
        : { school: optionalString(profile, ["school"], "data.matchedUser.profile.school", 256)! }),
      ...(optionalString(user, ["githubUrl"], "data.matchedUser.githubUrl", 2_048) === undefined
        ? {}
        : { githubUrl: optionalString(user, ["githubUrl"], "data.matchedUser.githubUrl", 2_048)! }),
      ...(ranking === undefined ? {} : { ranking }),
      ...(totalSubmissions.length === 0 ? {} : { totalSubmissions }),
      ...(acceptedQuestions.length === 0 ? {} : { acceptedQuestions })
    }, state);
  }

  if (data.userProfilePublicProfile === null || data.userProfilePublicProfile === undefined) {
    throw new LeetCodeToolError("NOT_FOUND", "LeetCode CN user was not found");
  }
  const publicProfile = asRecord(
    data.userProfilePublicProfile,
    "data.userProfilePublicProfile"
  );
  const profile = asRecord(publicProfile.profile, "data.userProfilePublicProfile.profile");
  const progress =
    data.userProfileUserQuestionProgress === undefined ||
    data.userProfileUserQuestionProgress === null
      ? undefined
      : asRecord(
          data.userProfileUserQuestionProgress,
          "data.userProfileUserQuestionProgress"
        );
  const username = requiredString(profile, ["userSlug"], "data.userProfilePublicProfile.profile.userSlug", 64);
  if (username.toLowerCase() !== requestedUsername.toLowerCase()) {
    return schemaChanged("data.userProfilePublicProfile.profile.userSlug");
  }
  const locationRecord =
    profile.globalLocation === undefined || profile.globalLocation === null
      ? undefined
      : asRecord(profile.globalLocation, "data.userProfilePublicProfile.profile.globalLocation");
  let location = locationRecord === undefined
    ? undefined
    : ["country", "province", "city"]
        .map((key) => optionalString(locationRecord, [key], `data.userProfilePublicProfile.profile.globalLocation.${key}`, 128))
        .concat(optionalCnOverseasCity(
          locationRecord,
          "data.userProfilePublicProfile.profile.globalLocation.overseasCity"
        ))
        .filter((item): item is string => item !== undefined)
        .join(", ") || undefined;
  if (location !== undefined && location.length > 256) {
    location = location.slice(0, 256);
    markOmitted(state, "/location");
  }
  const siteRanking = optionalCount(
    publicProfile,
    ["siteRanking"],
    "data.userProfilePublicProfile.siteRanking"
  );
  const acceptedQuestions = normalizeDifficultyCounts(
    progress?.numAcceptedQuestions,
    "data.userProfileUserQuestionProgress.numAcceptedQuestions"
  );
  const failedQuestions = normalizeDifficultyCounts(
    progress?.numFailedQuestions,
    "data.userProfileUserQuestionProgress.numFailedQuestions"
  );
  const untouchedQuestions = normalizeDifficultyCounts(
    progress?.numUntouchedQuestions,
    "data.userProfileUserQuestionProgress.numUntouchedQuestions"
  );
  const realName = optionalString(profile, ["realName"], "data.userProfilePublicProfile.profile.realName", 256);
  const avatar = optionalString(profile, ["userAvatar"], "data.userProfilePublicProfile.profile.userAvatar", 2_048);
  const aboutMe = optionalString(profile, ["aboutMe"], "data.userProfilePublicProfile.profile.aboutMe", 8_192);
  const githubUrl = optionalString(profile, ["github"], "data.userProfilePublicProfile.profile.github", 2_048);
  const school = optionalNestedName(profile, "school", "data.userProfilePublicProfile.profile.school");
  const company = optionalNestedName(profile, "company", "data.userProfilePublicProfile.profile.company");
  const rawSocialAccounts = profile.socialAccounts ?? [];
  if (!Array.isArray(rawSocialAccounts)) {
    return schemaChanged("data.userProfilePublicProfile.profile.socialAccounts");
  }
  const socialAccounts = rawSocialAccounts.flatMap((item, index) => {
    const account = asRecord(item, `data.userProfilePublicProfile.profile.socialAccounts[${index}]`);
    const profileUrl = optionalString(account, ["profileUrl"], `data.userProfilePublicProfile.profile.socialAccounts[${index}].profileUrl`, 2_048);
    if (profileUrl === undefined) return [];
    const provider = optionalString(account, ["provider"], `data.userProfilePublicProfile.profile.socialAccounts[${index}].provider`, 128);
    return [{ ...(provider === undefined ? {} : { provider }), profileUrl }];
  });
  const skillSet =
    profile.skillSet === undefined || profile.skillSet === null
      ? undefined
      : asRecord(profile.skillSet, "data.userProfilePublicProfile.profile.skillSet");
  const rawTopics = skillSet?.topics ?? [];
  if (!Array.isArray(rawTopics)) return schemaChanged("data.userProfilePublicProfile.profile.skillSet.topics");
  const skillTopics = rawTopics.map((item, index) =>
    requiredString(asRecord(item, `data.userProfilePublicProfile.profile.skillSet.topics[${index}]`), ["slug"], `data.userProfilePublicProfile.profile.skillSet.topics[${index}].slug`, 128)
  );
  const rawTopicAreaScores = skillSet?.topicAreaScores ?? [];
  if (!Array.isArray(rawTopicAreaScores)) return schemaChanged("data.userProfilePublicProfile.profile.skillSet.topicAreaScores");
  const topicAreaScores = rawTopicAreaScores.map((item, index) => {
    const entry = asRecord(item, `data.userProfilePublicProfile.profile.skillSet.topicAreaScores[${index}]`);
    const topicArea = asRecord(entry.topicArea, `data.userProfilePublicProfile.profile.skillSet.topicAreaScores[${index}].topicArea`);
    return {
      slug: requiredString(topicArea, ["slug"], `data.userProfilePublicProfile.profile.skillSet.topicAreaScores[${index}].topicArea.slug`, 128),
      score: requiredNumber(entry, ["score"], `data.userProfilePublicProfile.profile.skillSet.topicAreaScores[${index}].score`)
    };
  });
  return attachNormalizationMeta({
    username,
    ...(realName === undefined ? {} : { realName }),
    ...(avatar === undefined ? {} : { avatar }),
    ...(aboutMe === undefined ? {} : { aboutMe }),
    ...(location === undefined ? {} : { location }),
    ...(company === undefined ? {} : { company }),
    ...(school === undefined ? {} : { school }),
    ...(githubUrl === undefined ? {} : { githubUrl }),
    ...(siteRanking === undefined ? {} : { siteRanking }),
    ...(acceptedQuestions.length === 0 ? {} : { acceptedQuestions }),
    ...(failedQuestions.length === 0 ? {} : { failedQuestions }),
    ...(untouchedQuestions.length === 0 ? {} : { untouchedQuestions }),
    ...(socialAccounts.length === 0 ? {} : { socialAccounts }),
    ...(skillTopics.length === 0 ? {} : { skillTopics }),
    ...(topicAreaScores.length === 0 ? {} : { topicAreaScores })
  }, state);
}

export function normalizeUserContest(
  data: UnknownRecord,
  username: string,
  attendedOnly: boolean,
  offset = 0,
  limit = 50
): UserContestResult {
  const state = collector();
  const rankingValue = data.userContestRanking;
  const ranking =
    rankingValue === null || rankingValue === undefined
      ? undefined
      : asRecord(rankingValue, "data.userContestRanking");
  const rawHistory = data.userContestRankingHistory ?? [];
  if (!Array.isArray(rawHistory)) {
    return schemaChanged("data.userContestRankingHistory");
  }
  if (rawHistory.length > MAX_CONTEST_HISTORY_INPUT) {
    return schemaChanged("data.userContestRankingHistory");
  }
  const filtered = rawHistory.filter((item, index) => {
    const record = asRecord(item, `data.userContestRankingHistory[${index}]`);
    const attended = requiredBoolean(record, ["attended"], `data.userContestRankingHistory[${index}].attended`);
    return !attendedOnly || attended;
  });
  const history = filtered.slice(offset, offset + limit).map((item, index) => {
    const sourceIndex = offset + index;
    const path = `data.userContestRankingHistory[${sourceIndex}]`;
    const record = asRecord(item, path);
    const contest = asRecord(record.contest, `${path}.contest`);
    const startTime = normalizeTimestamp(contest.startTime, `${path}.contest.startTime`);
    const translatedTitle = optionalString(contest, ["titleCn"], `${path}.contest.titleCn`, 512);
    const totalProblems = optionalCount(record, ["totalProblems"], `${path}.totalProblems`);
    const solvedProblems = optionalCount(record, ["problemsSolved"], `${path}.problemsSolved`);
    const finishTimeSeconds = optionalCount(record, ["finishTimeInSeconds"], `${path}.finishTimeInSeconds`);
    const rating = optionalNumber(record, ["rating"], `${path}.rating`);
    const score = optionalNumber(record, ["score"], `${path}.score`);
    const contestRanking = optionalCount(record, ["ranking"], `${path}.ranking`);
    const trend = optionalString(
      record,
      ["trendDirection", "trendingDirection"],
      `${path}.trendDirection`,
      64
    );
    return {
      attended: requiredBoolean(record, ["attended"], `${path}.attended`),
      title: requiredString(contest, ["title"], `${path}.contest.title`),
      ...(translatedTitle === undefined ? {} : { translatedTitle }),
      ...(startTime === undefined ? {} : { startTime }),
      ...(totalProblems === undefined ? {} : { totalProblems }),
      ...(solvedProblems === undefined ? {} : { solvedProblems }),
      ...(finishTimeSeconds === undefined ? {} : { finishTimeSeconds }),
      ...(rating === undefined ? {} : { rating }),
      ...(score === undefined ? {} : { score }),
      ...(contestRanking === undefined ? {} : { ranking: contestRanking }),
      ...(trend === undefined ? {} : { trend })
    };
  });
  if (ranking === undefined) {
    return attachNormalizationMeta({
      username,
      history,
      page: {
        offset,
        limit,
        totalKind: "exact",
        total: filtered.length,
        hasMore: offset + history.length < filtered.length
      }
    }, state);
  }
  const badge =
    ranking.badge === undefined || ranking.badge === null
      ? undefined
      : optionalString(asRecord(ranking.badge, "data.userContestRanking.badge"), ["name"], "data.userContestRanking.badge.name", 256);
  const summary = {
    attendedContestsCount: optionalCount(ranking, ["attendedContestsCount"], "data.userContestRanking.attendedContestsCount"),
    rating: optionalNumber(ranking, ["rating"], "data.userContestRanking.rating"),
    globalRanking: optionalCount(ranking, ["globalRanking"], "data.userContestRanking.globalRanking"),
    localRanking: optionalCount(ranking, ["localRanking"], "data.userContestRanking.localRanking"),
    globalTotalParticipants: optionalCount(ranking, ["globalTotalParticipants", "totalParticipants"], "data.userContestRanking.globalTotalParticipants"),
    localTotalParticipants: optionalCount(ranking, ["localTotalParticipants"], "data.userContestRanking.localTotalParticipants"),
    topPercentage: optionalPercentile(ranking, ["topPercentage"], "data.userContestRanking.topPercentage"),
    badge
  };
  const compactRanking = Object.fromEntries(
    Object.entries(summary).filter(([, value]) => value !== undefined)
  ) as NonNullable<UserContestResult["ranking"]>;
  return attachNormalizationMeta({
    username,
    ...(Object.keys(compactRanking).length === 0 ? {} : { ranking: compactRanking }),
    history,
    page: {
      offset,
      limit,
      totalKind: "exact",
      total: filtered.length,
      hasMore: offset + history.length < filtered.length
    }
  }, state);
}

export function normalizeUserStatus(data: UnknownRecord, region: Region): UserStatus {
  const status = asRecord(data.userStatus, "data.userStatus");
  const isSignedIn = requiredBoolean(status, ["isSignedIn"], "data.userStatus.isSignedIn");
  const isAdmin = requiredBoolean(status, ["isAdmin"], "data.userStatus.isAdmin");
  const useTranslation = optionalBoolean(status, ["useTranslation"], "data.userStatus.useTranslation");
  if (!isSignedIn) {
    return {
      isSignedIn: false,
      isAdmin,
      ...(useTranslation === undefined ? {} : { useTranslation })
    };
  }
  const username = optionalString(
    status,
    region === "cn" ? ["userSlug"] : ["username"],
    region === "cn" ? "data.userStatus.userSlug" : "data.userStatus.username",
    64
  );
  if (username === undefined) {
    return schemaChanged(region === "cn" ? "data.userStatus.userSlug" : "data.userStatus.username");
  }
  if (username !== undefined && !/^[A-Za-z0-9_.-]+$/u.test(username)) {
    return schemaChanged(region === "cn" ? "data.userStatus.userSlug" : "data.userStatus.username");
  }
  const displayName =
    region === "cn"
      ? optionalString(status, ["username"], "data.userStatus.username", 256)
      : undefined;
  const avatar = optionalString(status, ["avatar"], "data.userStatus.avatar", 2_048);
  return {
    isSignedIn: true,
    username,
    ...(displayName === undefined || displayName === username ? {} : { displayName }),
    ...(avatar === undefined ? {} : { avatar }),
    isAdmin,
    ...(useTranslation === undefined ? {} : { useTranslation })
  };
}

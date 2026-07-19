import type {
  CapabilityManifest,
  DailyChallenge,
  Difficulty,
  OperationStatus,
  NotesDocument,
  NotesReadInput,
  NotesWriteInput,
  ProblemDetail,
  ProblemProgressResult,
  Region,
  SearchProblemsResult,
  SolutionDetail,
  SolutionSearchResult,
  SubmissionDetail,
  SubmissionHistoryResult,
  UserContestResult,
  UserNoteMutationResult,
  UserNotesCreateInput,
  UserNotesGetInput,
  UserNotesGetResult,
  UserNotesSearchInput,
  UserNotesSearchResult,
  UserNotesUpdateInput,
  UserProfile,
  UserStatus,
  UserSubmissionsResult,
  ToolResult
} from "../types.js";

export interface SearchProblemsInput {
  region: Region;
  category?: string;
  query?: string;
  tags?: string[];
  difficulty?: Difficulty;
  limit?: number;
  offset?: number;
  cursor?: string;
}

export interface GetProblemInput {
  region: Region;
  titleSlug: string;
  language?: string;
  includeResourcePayload?: boolean;
}

export type SolutionOrderBy =
  | "HOT"
  | "MOST_RECENT"
  | "MOST_VOTES"
  | "DEFAULT"
  | "MOST_UPVOTE"
  | "NEWEST_TO_OLDEST"
  | "OLDEST_TO_NEWEST";

export interface GetSolutionSearchInput {
  region: Region;
  titleSlug: string;
  limit?: number;
  offset?: number;
  orderBy?: SolutionOrderBy;
  query?: string;
  tags?: string[];
}

export interface GetSolutionInput {
  region: Region;
  topicId?: string;
  slug?: string;
}

export interface GetUserProfileInput {
  region: Region;
  username: string;
}

export interface GetUserContestInput {
  region: Region;
  username: string;
  attendedOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface GetProgressInput {
  region: Region;
  titleSlug?: string;
  status?: "solved" | "attempted";
  difficulty?: Difficulty[];
  limit?: number;
  offset?: number;
}

export interface GetHistoryInput {
  region: Region;
  scope?: "account" | "problem";
  titleSlug?: string;
  language?: string;
  status?: "accepted" | "wrong_answer";
  limit?: number;
  offset?: number;
  cursor?: string;
}

export interface GetUserSubmissionsInput {
  region: Region;
  username: string;
  mode: "recent" | "accepted";
  limit?: number;
}

export interface GetSubmissionDetailInput {
  region: Region;
  submissionId: string;
  includeCode?: boolean;
}

export interface RunCodeInput {
  region: Region;
  titleSlug: string;
  language: string;
  code: string;
  testcase?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface SubmitCodeInput {
  region: Region;
  titleSlug: string;
  language: string;
  code: string;
  retryUnknownOperationId?: string;
  resubmitCompletedOperationId?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface LeetCodeClient {
  getCapabilities(interactiveUI: boolean): CapabilityManifest;
  getDaily(region: Region, signal?: AbortSignal): Promise<ToolResult<DailyChallenge>>;
  searchProblems(
    input: SearchProblemsInput,
    signal?: AbortSignal
  ): Promise<ToolResult<SearchProblemsResult>>;
  getProblem(
    input: GetProblemInput,
    signal?: AbortSignal
  ): Promise<ToolResult<ProblemDetail>>;
  searchSolutions(
    input: GetSolutionSearchInput,
    signal?: AbortSignal
  ): Promise<ToolResult<SolutionSearchResult>>;
  getSolution(
    input: GetSolutionInput,
    signal?: AbortSignal
  ): Promise<ToolResult<SolutionDetail>>;
  getUserProfile(
    input: GetUserProfileInput,
    signal?: AbortSignal
  ): Promise<ToolResult<UserProfile>>;
  getUserContest(
    input: GetUserContestInput,
    signal?: AbortSignal
  ): Promise<ToolResult<UserContestResult>>;
  getProgress(
    input: GetProgressInput,
    signal?: AbortSignal
  ): Promise<ToolResult<ProblemProgressResult>>;
  getHistory(
    input: GetHistoryInput,
    signal?: AbortSignal
  ): Promise<ToolResult<SubmissionHistoryResult>>;
  getUserSubmissions(
    input: GetUserSubmissionsInput,
    signal?: AbortSignal
  ): Promise<ToolResult<UserSubmissionsResult>>;
  getSubmissionDetail(
    input: GetSubmissionDetailInput,
    signal?: AbortSignal
  ): Promise<ToolResult<SubmissionDetail>>;
  getUserStatus(
    region: Region,
    signal?: AbortSignal
  ): Promise<ToolResult<UserStatus>>;
  runCode(
    input: RunCodeInput,
    signal?: AbortSignal
  ): Promise<ToolResult<OperationStatus>>;
  submitCode(
    input: SubmitCodeInput,
    signal?: AbortSignal
  ): Promise<ToolResult<OperationStatus>>;
  getOperationStatus(
    operationId: string,
    signal?: AbortSignal
  ): Promise<ToolResult<OperationStatus>>;
  readNotes(
    input: NotesReadInput,
    signal?: AbortSignal
  ): Promise<ToolResult<NotesDocument>>;
  writeNotes(
    input: NotesWriteInput,
    signal?: AbortSignal
  ): Promise<ToolResult<NotesDocument>>;
  searchUserNotes(
    input: UserNotesSearchInput,
    signal?: AbortSignal,
    expectedAccountProfileId?: string
  ): Promise<ToolResult<UserNotesSearchResult>>;
  getUserNotes(
    input: UserNotesGetInput,
    signal?: AbortSignal,
    expectedAccountProfileId?: string
  ): Promise<ToolResult<UserNotesGetResult>>;
  createUserNote(
    input: UserNotesCreateInput,
    signal?: AbortSignal,
    expectedAccountProfileId?: string
  ): Promise<ToolResult<UserNoteMutationResult>>;
  updateUserNote(
    input: UserNotesUpdateInput,
    signal?: AbortSignal,
    expectedAccountProfileId?: string
  ): Promise<ToolResult<UserNoteMutationResult>>;
  close(): Promise<void>;
}

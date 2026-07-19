import type { Static } from "typebox";

import type {
  CapabilityManifestSchema,
  CodeSnippetSchema,
  DailyChallengeSchema,
  DifficultySchema,
  JudgeResultSchema,
  NotesCapabilitySchema,
  NotesDocumentSchema,
  NotesReadInputSchema,
  NotesRevisionModeSchema,
  NotesWriteInputSchema,
  OperationKindSchema,
  OperationStateSchema,
  OperationStatusSchema,
  PageInfoSchema,
  ProblemDetailSchema,
  ProblemResourcePayloadSchema,
  ProblemProgressResultSchema,
  ProblemSummarySchema,
  ProgressProblemSchema,
  RegionSchema,
  RegionalDailyPayloadSchema,
  SearchProblemsResultSchema,
  SolutionArticleSummarySchema,
  SolutionDetailSchema,
  SolutionNavigationSchema,
  SolutionSearchResultSchema,
  SubmissionDetailSchema,
  SubmissionHistoryResultSchema,
  PublicSubmissionRecordSchema,
  SubmissionRecordSchema,
  UserSubmissionsResultSchema,
  ToolCapabilitySchema,
  ToolErrorCodeSchema,
  ToolFailureSchema,
  ToolMetaSchema,
  TopicTagSchema,
  UserContestResultSchema,
  UserProfileSchema,
  UserStatusSchema,
  UserNoteSchema,
  UserNoteMutationResultSchema,
  UserNotesCreateInputSchema,
  UserNotesGetInputSchema,
  UserNotesGetResultSchema,
  UserNotesSearchInputSchema,
  UserNotesSearchResultSchema,
  UserNotesUpdateInputSchema
} from "./tool-calls/contract.js";

export type Region = Static<typeof RegionSchema>;
export type Difficulty = Static<typeof DifficultySchema>;
export type ToolErrorCode = Static<typeof ToolErrorCodeSchema>;
export type ToolMeta = Static<typeof ToolMetaSchema>;

export interface ToolSuccess<T> {
  ok: true;
  data: T;
  meta: ToolMeta;
}

export type ToolFailure = Static<typeof ToolFailureSchema>;
export type ToolResult<T> = ToolSuccess<T> | ToolFailure;

export type TopicTag = Static<typeof TopicTagSchema>;
export type ProblemSummary = Static<typeof ProblemSummarySchema>;
export type CodeSnippet = Static<typeof CodeSnippetSchema>;
export type ProblemDetail = Static<typeof ProblemDetailSchema>;
export type ProblemResourcePayload = Static<typeof ProblemResourcePayloadSchema>;
export type DailyChallenge = Static<typeof DailyChallengeSchema>;
export type RegionalDailyPayload = Static<typeof RegionalDailyPayloadSchema>;
export type PageInfo = Static<typeof PageInfoSchema>;
export type SearchProblemsResult = Static<typeof SearchProblemsResultSchema>;
export type SolutionArticleSummary = Static<typeof SolutionArticleSummarySchema>;
export type SolutionSearchResult = Static<typeof SolutionSearchResultSchema>;
export type SolutionNavigation = Static<typeof SolutionNavigationSchema>;
export type SolutionDetail = Static<typeof SolutionDetailSchema>;
export type ProgressProblem = Static<typeof ProgressProblemSchema>;
export type ProblemProgressResult = Static<typeof ProblemProgressResultSchema>;
export type UserProfile = Static<typeof UserProfileSchema>;
export type UserContestResult = Static<typeof UserContestResultSchema>;
export type UserStatus = Static<typeof UserStatusSchema>;
export type SubmissionRecord = Static<typeof SubmissionRecordSchema>;
export type SubmissionHistoryResult = Static<typeof SubmissionHistoryResultSchema>;
export type PublicSubmissionRecord = Static<typeof PublicSubmissionRecordSchema>;
export type UserSubmissionsResult = Static<typeof UserSubmissionsResultSchema>;
export type SubmissionDetail = Static<typeof SubmissionDetailSchema>;

export type OperationKind = Static<typeof OperationKindSchema>;
export type OperationState = Static<typeof OperationStateSchema>;
export type JudgeResult = Static<typeof JudgeResultSchema>;
export type OperationStatus = Static<typeof OperationStatusSchema>;

export type ToolCapability = Static<typeof ToolCapabilitySchema>;
export type NotesRevisionMode = Static<typeof NotesRevisionModeSchema>;
export type NotesCapability = Static<typeof NotesCapabilitySchema>;
export type CapabilityManifest = Static<typeof CapabilityManifestSchema>;
export type NotesDocument = Static<typeof NotesDocumentSchema>;
export type NotesReadInput = Static<typeof NotesReadInputSchema>;
export type NotesWriteInput = Static<typeof NotesWriteInputSchema>;
export type UserNote = Static<typeof UserNoteSchema>;
export type UserNotesSearchInput = Static<typeof UserNotesSearchInputSchema>;
export type UserNotesSearchResult = Static<typeof UserNotesSearchResultSchema>;
export type UserNotesGetInput = Static<typeof UserNotesGetInputSchema>;
export type UserNotesGetResult = Static<typeof UserNotesGetResultSchema>;
export type UserNotesCreateInput = Static<typeof UserNotesCreateInputSchema>;
export type UserNotesUpdateInput = Static<typeof UserNotesUpdateInputSchema>;
export type UserNoteMutationResult = Static<typeof UserNoteMutationResultSchema>;

export interface CredentialBundle {
  profileId: string;
  region: Region;
  session: string;
  csrfToken: string;
}

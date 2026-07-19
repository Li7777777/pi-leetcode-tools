import type { LeetCodeToolMetadata } from "./read-tools.js";

export const WRITE_TOOL_METADATA: readonly LeetCodeToolMetadata[] = [
  {
    name: "lc_run",
    label: "Run LeetCode Code",
    description: "Run code against LeetCode without creating a formal submission.",
    promptSnippet: "Run code on LeetCode without submitting it",
    promptGuidelines: ["Use lc_run only with code the user intends to execute remotely."],
    executionMode: "parallel"
  },
  {
    name: "lc_submit",
    label: "Submit LeetCode Solution",
    description: "Submit a solution to LeetCode after mandatory interactive confirmation.",
    promptSnippet: "Submit a LeetCode solution with user confirmation",
    promptGuidelines: [
      "Use lc_submit only after the user explicitly asks to submit; every call requires UI confirmation."
    ],
    executionMode: "sequential"
  }
];

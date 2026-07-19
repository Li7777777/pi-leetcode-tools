import { describe, expect, it } from "vitest";

import {
  createLeetCodeUserNotesPort,
  LEETCODE_CN_NOTES_ENDPOINT,
  type NotesFetch
} from "../../src/leetcode/notes-port.js";
import type { CredentialProvider } from "../../src/runtime/credentials.js";

interface CapturedRequest {
  input: RequestInfo | URL;
  init?: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function credentials(options: {
  profileId?: string;
  session?: boolean;
  operation?: boolean;
} = {}): CredentialProvider {
  const session = options.session ?? true;
  const operation = options.operation ?? true;
  return {
    isConfigured: (_region, requirement = "session") =>
      requirement === "session" ? session : session && operation,
    getCredentials: async (region) =>
      region === "cn" && session
        ? {
            profileId: options.profileId ?? "profile-cn",
            region: "cn",
            session: "session-canary",
            csrfToken: operation ? "csrf-canary" : ""
          }
        : undefined
  };
}

function queuedFetch(...responses: Array<Response | Error>): {
  fetch: NotesFetch;
  requests: CapturedRequest[];
} {
  const queue = [...responses];
  const requests: CapturedRequest[] = [];
  return {
    requests,
    fetch: async (input, init) => {
      requests.push({ input, ...(init === undefined ? {} : { init }) });
      const response = queue.shift();
      if (response === undefined) {
        throw new Error("Unexpected personal notes request");
      }
      if (response instanceof Error) {
        throw response;
      }
      return response;
    }
  };
}

function body(request: CapturedRequest): {
  operationName: string;
  query: string;
  variables: Record<string, unknown>;
} {
  if (typeof request.init?.body !== "string") {
    throw new Error("Expected JSON request body");
  }
  return JSON.parse(request.init.body) as {
    operationName: string;
    query: string;
    variables: Record<string, unknown>;
  };
}

describe("LeetCode CN current-user personal Notes API", () => {
  it("searches the current user's notes with upstream defaults, ordering, and exact bodies", async () => {
    const transport = queuedFetch(
      jsonResponse({
        data: {
          noteAggregateNote: {
            count: 3,
            userNotes: [
              {
                id: "note-1",
                summary: "prefix",
                content: "  private markdown\n",
                noteQuestion: {
                  linkTemplate: "/problems/two-sum/",
                  questionId: "1",
                  title: "Two Sum",
                  translatedTitle: "两数之和"
                }
              }
            ]
          }
        }
      })
    );
    const port = createLeetCodeUserNotesPort({
      credentialProvider: credentials(),
      fetch: transport.fetch
    });

    const result = await port.search({ keyword: "hash" });

    expect(result).toEqual({
      filters: { keyword: "hash", orderBy: "DESCENDING" },
      pagination: { limit: 10, skip: 0, totalCount: 3 },
      notes: [
        {
          id: "note-1",
          summary: "prefix",
          content: "  private markdown\n",
          noteQuestion: {
            linkTemplate: "/problems/two-sum/",
            questionId: "1",
            title: "Two Sum",
            translatedTitle: "两数之和"
          }
        }
      ]
    });
    expect(transport.requests).toHaveLength(1);
    expect(String(transport.requests[0]?.input)).toBe(LEETCODE_CN_NOTES_ENDPOINT);
    expect(body(transport.requests[0]!)).toMatchObject({
      operationName: "noteAggregateNote",
      variables: {
        aggregateType: "QUESTION_NOTE",
        keyword: "hash",
        orderBy: "DESCENDING",
        limit: 10,
        skip: 0
      }
    });
  });

  it("gets notes by numeric questionId with the MCP's effective limit=10 default", async () => {
    const transport = queuedFetch(
      jsonResponse({
        data: {
          noteOneTargetCommonNote: {
            count: 1,
            userNotes: [{ id: "42", summary: "", content: "body" }]
          }
        }
      })
    );
    const port = createLeetCodeUserNotesPort({
      credentialProvider: credentials(),
      fetch: transport.fetch
    });

    await expect(port.get({ questionId: "42" })).resolves.toEqual({
      questionId: "42",
      count: 1,
      pagination: { limit: 10, skip: 0 },
      notes: [{ id: "42", summary: "", content: "body" }]
    });
    expect(body(transport.requests[0]!).variables).toEqual({
      noteType: "COMMON_QUESTION",
      questionId: "42",
      limit: 10,
      skip: 0
    });
  });

  it("creates and updates arbitrary notes without managed-summary or CAS semantics", async () => {
    const transport = queuedFetch(
      jsonResponse({
        data: {
          noteCreateCommonNote: {
            ok: true,
            note: { id: "created-1", content: "  body\n", targetId: "42" }
          }
        }
      }),
      jsonResponse({
        data: {
          noteUpdateUserNote: {
            ok: false,
            note: null
          }
        }
      })
    );
    const port = createLeetCodeUserNotesPort({
      credentialProvider: credentials(),
      fetch: transport.fetch
    });

    await expect(
      port.create({ questionId: "42", content: "  body\n" }, undefined, "profile-cn")
    ).resolves.toEqual({
      success: true,
      note: { id: "created-1", content: "  body\n", targetId: "42" }
    });
    await expect(port.update({ noteId: "created-1" })).resolves.toEqual({
      success: false,
      note: null
    });

    expect(body(transport.requests[0]!).variables).toEqual({
      content: "  body\n",
      noteType: "COMMON_QUESTION",
      targetId: "42",
      summary: ""
    });
    expect(body(transport.requests[1]!).variables).toEqual({
      content: "",
      noteId: "created-1",
      summary: ""
    });
  });

  it("is CN-only, current-account-only, and distinguishes read from write auth", async () => {
    const transport = queuedFetch(
      jsonResponse({
        data: { noteAggregateNote: { count: 0, userNotes: [] } }
      })
    );
    const sessionOnly = createLeetCodeUserNotesPort({
      credentialProvider: credentials({ operation: false }),
      fetch: transport.fetch
    });

    await expect(sessionOnly.search({ region: "global" })).rejects.toMatchObject({
      code: "UNSUPPORTED_REGION"
    });
    await expect(sessionOnly.search({})).resolves.toMatchObject({ notes: [] });
    await expect(
      sessionOnly.create({ questionId: "1", content: "private" })
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });

    const wrongProfile = createLeetCodeUserNotesPort({
      credentialProvider: credentials({ profileId: "profile-b" }),
      fetch: transport.fetch
    });
    await expect(wrongProfile.search({}, undefined, "profile-a")).rejects.toMatchObject({
      code: "STALE_OPERATION"
    });
    expect(transport.requests).toHaveLength(1);
  });

  it("maps expired auth and ambiguous write transport failures without retrying writes", async () => {
    const expiredTransport = queuedFetch(jsonResponse({}, 401));
    const expired = createLeetCodeUserNotesPort({
      credentialProvider: credentials(),
      fetch: expiredTransport.fetch
    });
    await expect(expired.search({})).rejects.toMatchObject({ code: "AUTH_EXPIRED" });

    const uncertainTransport = queuedFetch(new Error("network failed"));
    const uncertain = createLeetCodeUserNotesPort({
      credentialProvider: credentials(),
      fetch: uncertainTransport.fetch
    });
    await expect(
      uncertain.update({ noteId: "note-1", content: "private" })
    ).rejects.toMatchObject({
      code: "UNKNOWN_WRITE_OUTCOME",
      details: { writeOutcomeUnverified: true }
    });
    expect(uncertainTransport.requests).toHaveLength(1);
  });

  it("fails closed on malformed note payloads", async () => {
    const transport = queuedFetch(
      jsonResponse({
        data: {
          noteAggregateNote: {
            count: 1,
            userNotes: [{ id: "note-1", summary: "title" }]
          }
        }
      })
    );
    const port = createLeetCodeUserNotesPort({
      credentialProvider: credentials(),
      fetch: transport.fetch
    });
    await expect(port.search({ orderBy: "ASCENDING" })).rejects.toMatchObject({
      code: "REMOTE_SCHEMA_CHANGED"
    });
  });
});

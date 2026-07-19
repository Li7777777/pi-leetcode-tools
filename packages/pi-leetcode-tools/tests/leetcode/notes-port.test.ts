import { describe, expect, it } from "vitest";

import {
  createLeetCodeNotesPorts,
  LEETCODE_CN_NOTES_ENDPOINT,
  LEETCODE_CN_NOTES_MAX_BYTES,
  LEETCODE_MANAGED_NOTE_SUMMARY,
  type NotesFetch
} from "../../src/leetcode/notes-port.js";
import type { CredentialProvider } from "../../src/runtime/credentials.js";

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

function notesResponse(
  notes: Array<{ id: string; summary: string; content: string }>
): Response {
  return jsonResponse({
    data: {
      noteOneTargetCommonNote: {
        count: notes.length,
        userNotes: notes
      }
    }
  });
}

function mutationResponse(operationName: string, noteId: string, content: string): Response {
  return jsonResponse({
    data: {
      [operationName]: {
        ok: true,
        note: { id: noteId, content, targetId: "1" }
      }
    }
  });
}

function fakeFetch(...responses: Response[]): {
  fetch: NotesFetch;
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
        throw new Error("Unexpected notes request");
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

function credentials(configured = true): CredentialProvider {
  return {
    isConfigured: () => configured,
    getCredentials: async (region) =>
      region === "cn" && configured
        ? {
            profileId: "profile-cn",
            region: "cn",
            session: "session-value",
            csrfToken: "csrf-value"
          }
        : undefined
  };
}

function createPorts(fetch: NotesFetch, configured = true) {
  return createLeetCodeNotesPorts({
    credentialProvider: credentials(configured),
    resolveQuestionId: async () => "1",
    fetch
  });
}

describe("LeetCode CN NotesPort", () => {
  it("keeps Global explicitly unsupported and reports CN capability accurately", async () => {
    const transport = fakeFetch();
    const ports = createPorts(transport.fetch, false);

    expect(ports.global.getCapability(true)).toMatchObject({
      supported: false,
      revisionMode: "unsupported",
      currentlyAvailable: false
    });
    expect(ports.cn.getCapability(true)).toMatchObject({
      supported: true,
      configured: false,
      currentlyAvailable: false,
      revisionMode: "best-effort-compare-and-set",
      maxSize: LEETCODE_CN_NOTES_MAX_BYTES
    });
    await expect(
      ports.global.read({ region: "global", target: "two-sum" })
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    await expect(
      ports.cn.read({ region: "cn", target: "two-sum" })
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(transport.requests).toEqual([]);
  });

  it("reads the whole managed note and uses null as the only missing revision", async () => {
    const transport = fakeFetch(
      notesResponse([
        { id: "user-note", summary: "my note", content: "do not touch" }
      ]),
      notesResponse([
        { id: "user-note", summary: "my note", content: "do not touch" }
      ])
    );
    const ports = createPorts(transport.fetch);

    const first = await ports.cn.read({ region: "cn", target: "two-sum" });
    const second = await ports.cn.read({ region: "cn", target: "two-sum" });
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      target: "two-sum",
      content: "",
      byteLength: 0,
      revision: null,
      revisionMode: "best-effort-compare-and-set"
    });

    const request = transport.requests[0]!;
    expect(String(request.input)).toBe(LEETCODE_CN_NOTES_ENDPOINT);
    expect(request.init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(requestBody(request)).toMatchObject({
      operationName: "noteOneTargetCommonNote",
      variables: { noteType: "COMMON_QUESTION", questionId: "1" }
    });
    expect(JSON.stringify(request)).not.toContain("do not touch");
  });

  it("rejects a stale expectedRevision before any mutation", async () => {
    const transport = fakeFetch(
      notesResponse([
        {
          id: "managed-1",
          summary: LEETCODE_MANAGED_NOTE_SUMMARY,
          content: "current"
        }
      ])
    );
    const ports = createPorts(transport.fetch);

    await expect(
      ports.cn.write({
        region: "cn",
        target: "two-sum",
        content: "replacement",
        expectedRevision: `sha256:${"0".repeat(64)}`
      })
    ).rejects.toMatchObject({
      code: "STALE_OPERATION",
      details: { revisionConflict: true }
    });
    expect(transport.requests.map(requestBody).map((body) => body.operationName)).toEqual([
      "noteOneTargetCommonNote"
    ]);
  });

  it("creates once from the missing revision and verifies by rereading", async () => {
    const content = "managed state";
    const transport = fakeFetch(
      notesResponse([]),
      notesResponse([]),
      mutationResponse("noteCreateCommonNote", "managed-1", content),
      notesResponse([
        { id: "managed-1", summary: LEETCODE_MANAGED_NOTE_SUMMARY, content }
      ])
    );
    const ports = createPorts(transport.fetch);
    const missing = await ports.cn.read({ region: "cn", target: "two-sum" });

    await expect(
      ports.cn.write({
        region: "cn",
        target: "two-sum",
        content,
        expectedRevision: missing.revision
      })
    ).resolves.toMatchObject({ target: "two-sum", content });

    const operations = transport.requests.map(requestBody).map((body) => body.operationName);
    expect(operations).toEqual([
      "noteOneTargetCommonNote",
      "noteOneTargetCommonNote",
      "noteCreateCommonNote",
      "noteOneTargetCommonNote"
    ]);
    expect(operations.filter((name) => name === "noteCreateCommonNote")).toHaveLength(1);
    const mutation = requestBody(transport.requests[2]!);
    expect(mutation).toMatchObject({
      variables: {
        content,
        targetId: "1",
        summary: LEETCODE_MANAGED_NOTE_SUMMARY
      }
    });
  });

  it("updates one existing managed note and verifies the exact content", async () => {
    const original = {
      id: "managed-1",
      summary: LEETCODE_MANAGED_NOTE_SUMMARY,
      content: "old"
    };
    const transport = fakeFetch(
      notesResponse([original]),
      notesResponse([original]),
      mutationResponse("noteUpdateUserNote", "managed-1", "new"),
      notesResponse([{ ...original, content: "new" }])
    );
    const ports = createPorts(transport.fetch);
    const current = await ports.cn.read({ region: "cn", target: "two-sum" });

    const updated = await ports.cn.write({
      region: "cn",
      target: "two-sum",
      content: "new",
      expectedRevision: current.revision
    });
    expect(updated.content).toBe("new");
    expect(updated.revision).not.toBe(current.revision);
    expect(requestBody(transport.requests[2]!)).toMatchObject({
      operationName: "noteUpdateUserNote",
      variables: { noteId: "managed-1", content: "new" }
    });
  });

  it("reports an unknown write outcome when read-back cannot verify the mutation", async () => {
    const original = {
      id: "managed-1",
      summary: LEETCODE_MANAGED_NOTE_SUMMARY,
      content: "old"
    };
    const transport = fakeFetch(
      notesResponse([original]),
      notesResponse([original]),
      mutationResponse("noteUpdateUserNote", "managed-1", "new"),
      notesResponse([original])
    );
    const ports = createPorts(transport.fetch);
    const current = await ports.cn.read({ region: "cn", target: "two-sum" });

    await expect(
      ports.cn.write({
        region: "cn",
        target: "two-sum",
        content: "new",
        expectedRevision: current.revision
      })
    ).rejects.toMatchObject({
      code: "UNKNOWN_WRITE_OUTCOME",
      details: { writeVerificationFailed: true }
    });
    expect(
      transport.requests.map(requestBody).map((body) => body.operationName)
    ).toEqual([
      "noteOneTargetCommonNote",
      "noteOneTargetCommonNote",
      "noteUpdateUserNote",
      "noteOneTargetCommonNote"
    ]);
  });

  it("does not automatically replay a Notes mutation after a remote failure", async () => {
    const original = {
      id: "managed-1",
      summary: LEETCODE_MANAGED_NOTE_SUMMARY,
      content: "old"
    };
    const transport = fakeFetch(
      notesResponse([original]),
      notesResponse([original]),
      jsonResponse({ message: "temporarily unavailable" }, 503)
    );
    const ports = createPorts(transport.fetch);
    const current = await ports.cn.read({ region: "cn", target: "two-sum" });

    await expect(
      ports.cn.write({
        region: "cn",
        target: "two-sum",
        content: "new",
        expectedRevision: current.revision
      })
    ).rejects.toMatchObject({
      code: "UNKNOWN_WRITE_OUTCOME",
      details: { writeOutcomeUnverified: true }
    });
    expect(
      transport.requests.map(requestBody).map((body) => body.operationName)
    ).toEqual([
      "noteOneTargetCommonNote",
      "noteOneTargetCommonNote",
      "noteUpdateUserNote"
    ]);
  });

  it("enforces the 16 KiB limit using UTF-8 bytes before network access", async () => {
    const transport = fakeFetch();
    const ports = createPorts(transport.fetch);

    await expect(
      ports.cn.write({
        region: "cn",
        target: "two-sum",
        content: "界".repeat(Math.floor(LEETCODE_CN_NOTES_MAX_BYTES / 3) + 1),
        expectedRevision: null
      })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(transport.requests).toEqual([]);
  });

  it("rejects redirects, unsafe content types, oversized responses, and caller aborts", async () => {
    const redirect = createPorts(
      fakeFetch(new Response(null, { status: 302, headers: { location: "https://evil.test" } }))
        .fetch
    );
    await expect(
      redirect.cn.read({ region: "cn", target: "two-sum" })
    ).rejects.toMatchObject({
      code: "REMOTE_UNAVAILABLE",
      details: { redirectRejected: true }
    });

    const unsafeType = createPorts(
      fakeFetch(new Response("secret", { status: 200, headers: { "content-type": "text/plain" } }))
        .fetch
    );
    await expect(
      unsafeType.cn.read({ region: "cn", target: "two-sum" })
    ).rejects.toMatchObject({ code: "REMOTE_SCHEMA_CHANGED" });

    const oversized = createPorts(
      fakeFetch(jsonResponse({}, 200, { "content-length": "999999" })).fetch
    );
    await expect(
      oversized.cn.read({ region: "cn", target: "two-sum" })
    ).rejects.toMatchObject({ code: "REMOTE_SCHEMA_CHANGED" });

    const controller = new AbortController();
    controller.abort();
    const abortedTransport = fakeFetch();
    const aborted = createPorts(abortedTransport.fetch);
    await expect(
      aborted.cn.read({ region: "cn", target: "two-sum" }, controller.signal)
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(abortedTransport.requests).toEqual([]);
  });

  it("maps GraphQL failures without exposing remote error text or credentials", async () => {
    const transport = fakeFetch(
      jsonResponse({
        errors: [{ message: "Unknown field secret-remote-canary" }],
        data: null
      })
    );
    const ports = createPorts(transport.fetch);

    let error: unknown;
    try {
      await ports.cn.read({ region: "cn", target: "two-sum" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "REMOTE_SCHEMA_CHANGED" });
    expect(String((error as Error).message)).not.toContain("secret-remote-canary");
    expect(JSON.stringify(error)).not.toContain("session-value");
  });

  it("propagates caller abort to an in-flight HTTPS request", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const fetch: NotesFetch = async (_input, init) => {
      markStarted();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true }
        );
      });
    };
    const ports = createPorts(fetch);
    const controller = new AbortController();
    const pending = ports.cn.read(
      { region: "cn", target: "two-sum" },
      controller.signal
    );
    await started;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("fails closed when duplicate managed notes are found", async () => {
    const transport = fakeFetch(
      notesResponse([
        { id: "managed-1", summary: LEETCODE_MANAGED_NOTE_SUMMARY, content: "one" },
        { id: "managed-2", summary: LEETCODE_MANAGED_NOTE_SUMMARY, content: "two" }
      ])
    );
    const ports = createPorts(transport.fetch);

    await expect(
      ports.cn.read({ region: "cn", target: "two-sum" })
    ).rejects.toMatchObject({
      code: "STALE_OPERATION",
      details: { duplicateManagedNotes: true }
    });
  });
});

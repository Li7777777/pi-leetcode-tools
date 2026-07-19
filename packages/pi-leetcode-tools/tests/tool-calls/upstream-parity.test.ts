import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const PACKAGE_DIRECTORY = fileURLToPath(new URL("../../", import.meta.url));
const VERIFY_SCRIPT = fileURLToPath(
  new URL("../../scripts/verify-upstream-parity.mjs", import.meta.url)
);
const REFERENCE_TARBALL = fileURLToPath(
  new URL("../../../../.artifacts/upstream-reference/jinzcdev-leetcode-mcp-server-1.4.0.tgz", import.meta.url)
);
const QUERY_TARBALL = fileURLToPath(
  new URL("../../../../.artifacts/upstream-reference/leetcode-query-2.0.1.tgz", import.meta.url)
);
const EXECUTION_RECEIPT_MODULE = fileURLToPath(
  new URL("../../scripts/upstream-execution-receipt.mjs", import.meta.url)
);
const RELEASE_UTILS_MODULE = fileURLToPath(
  new URL("../../scripts/release-utils.mjs", import.meta.url)
);
const REFERENCE_SEMANTICS_PATH = join(
  PACKAGE_DIRECTORY,
  "upstream",
  "reference-semantics.json"
);
const SEMANTIC_BINDINGS_PATH = join(
  PACKAGE_DIRECTORY,
  "upstream",
  "semantic-case-bindings.json"
);
const temporaryDirectories: string[] = [];

async function readJson(relativePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8")
  ) as Record<string, unknown>;
}

function runVerifier(...arguments_: string[]) {
  return spawnSync(process.execPath, [VERIFY_SCRIPT, ...arguments_], {
    cwd: PACKAGE_DIRECTORY,
    encoding: "utf8",
    windowsHide: true
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function inventoryDigest(reference: Record<string, unknown>): string {
  const payload = {
    source: reference.source,
    expectedCounts: reference.expectedCounts,
    interfaces: reference.interfaces
  };
  return `sha256:${createHash("sha256").update(canonicalJson(payload)).digest("hex")}`;
}

async function createPackageFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-leetcode-upstream-parity-"));
  temporaryDirectories.push(directory);
  for (const path of ["package.json", "README.md", "contract", "upstream", "src", "tests"]) {
    await cp(join(PACKAGE_DIRECTORY, path), join(directory, path), { recursive: true });
  }
  return directory;
}

function runFixtureVerifier(packageDirectory: string, ...arguments_: string[]) {
  return runVerifier(
    "--package-root",
    packageDirectory,
    "--reference-tarball",
    REFERENCE_TARBALL,
    ...arguments_
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("reference MCP upstream parity gate", { timeout: 20_000 }, () => {
  it("pins exactly 19 tools and 5 resources with one mapping per interface", async () => {
    const reference = await readJson("upstream/reference-surface.json");
    const parity = await readJson("upstream/parity.json");
    const interfaces = reference.interfaces as Array<{ id: string; kind: string }>;
    const mappings = parity.mappings as Array<{ sourceId: string; status: string }>;

    expect(reference.schemaVersion).toBe(2);
    expect(reference.expectedCounts).toEqual({ tools: 19, resources: 5, total: 24 });
    expect(interfaces).toHaveLength(24);
    expect(interfaces.filter((entry) => entry.kind === "tool")).toHaveLength(19);
    expect(interfaces.filter((entry) => entry.kind === "resource")).toHaveLength(5);
    expect(new Set(interfaces.map((entry) => entry.id)).size).toBe(24);
    expect(mappings).toHaveLength(24);
    expect(new Set(mappings.map((mapping) => mapping.sourceId))).toEqual(
      new Set(interfaces.map((entry) => entry.id))
    );
  });

  it("pins the semantic surface and exact leetcode-query dependency used by the MCP behavior", async () => {
    const semantics = await readJson("upstream/reference-semantics.json") as {
      source: {
        queryDependency: {
          package: string;
          version: string;
          tarball: { sha256: string };
          graphqlQueryCount: number;
          graphqlCatalogDigest: string;
        };
      };
      semanticDimensions: string[];
      interfaces: Array<{ sourceId: string; variants: unknown[] }>;
      semanticSurfaceDigest: string;
    };
    expect(semantics.source.queryDependency).toMatchObject({
      package: "leetcode-query",
      version: "2.0.1",
      tarball: {
        sha256: "281fbaa950bf82e0b72a7273c2e7f5502ea6eb1dd593079ab5b89f8048b3eff0"
      },
      graphqlQueryCount: 19,
      graphqlCatalogDigest: "sha256:ae9297343794201583bbc6c33eede8a2f1e1e5bd5a4631a345e3a4adac291967"
    });
    expect(semantics.semanticDimensions).toHaveLength(8);
    expect(semantics.interfaces).toHaveLength(24);
    expect(new Set(semantics.interfaces.map((entry) => entry.sourceId)).size).toBe(24);
    expect(semantics.semanticSurfaceDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("keeps engineering pack/report separate from formal publish and candidate gates", async () => {
    const packageJson = await readJson("package.json") as { scripts: Record<string, string> };
    const rootPackageJson = JSON.parse(
      await readFile(new URL("../../../../package.json", import.meta.url), "utf8")
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts.prepack).toContain("verify:release-artifact");
    expect(packageJson.scripts.prepack).toContain(
      "verify:upstream-completeness:source"
    );
    expect(packageJson.scripts.prepublishOnly).toContain(
      "verify:upstream-completeness:source"
    );
    expect(packageJson.scripts.prepublishOnly).toContain("verify:release-artifact");
    expect(packageJson.scripts.prepublishOnly).not.toContain("npm run build");
    expect(packageJson.scripts.prepublishOnly).not.toContain("npm test");
    expect(packageJson.scripts["verify:upstream-completeness:source"]).toContain("--source-only");
    expect(rootPackageJson.scripts["pack:tools"]).toContain("verify:tools:upstream-completeness:source");
    expect(rootPackageJson.scripts["record:tools"]).toContain("verify:tools:upstream-completeness");
    expect(rootPackageJson.scripts["verify:tools:candidate"]).toContain("verify:tools:upstream-completeness");
    expect(rootPackageJson.scripts["verify:tools:release"]).toContain("verify:tools:upstream-completeness");
  });

  it("rejects a self-consistent manual inventory rewrite that omits an upstream field", async () => {
    const directory = await createPackageFixture();
    const referencePath = join(directory, "upstream", "reference-surface.json");
    const parityPath = join(directory, "upstream", "parity.json");
    const reference = JSON.parse(await readFile(referencePath, "utf8")) as Record<string, unknown>;
    const interfaces = reference.interfaces as Array<{ id: string; inputFields: string[] }>;
    const search = interfaces.find((entry) => entry.id === "tool:search_problems");
    expect(search).toBeDefined();
    search!.inputFields = search!.inputFields.filter((field) => field !== "offset");
    reference.inventoryDigest = inventoryDigest(reference);
    await writeFile(referencePath, `${JSON.stringify(reference, null, 2)}\n`);

    const parity = JSON.parse(await readFile(parityPath, "utf8")) as {
      reference: { inventoryDigest: string };
    };
    parity.reference.inventoryDigest = reference.inventoryDigest as string;
    await writeFile(parityPath, `${JSON.stringify(parity, null, 2)}\n`);

    const result = runFixtureVerifier(directory, "--json");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("inventoryDigest is not pinned");
  });

  it("requires the exact pinned archive receipt instead of silently trusting the manifest", async () => {
    const directory = await createPackageFixture();
    const tamperedTarball = join(directory, "tampered-upstream.tgz");
    const archive = await readFile(REFERENCE_TARBALL);
    await writeFile(tamperedTarball, Buffer.concat([archive, Buffer.from([0])]));

    const result = runVerifier(
      "--package-root",
      directory,
      "--reference-tarball",
      tamperedTarball,
      "--json"
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("archive size does not match");
  });

  it("fails closed when the pinned leetcode-query semantic dependency is missing or tampered", async () => {
    const directory = await createPackageFixture();
    const tamperedTarball = join(directory, "tampered-leetcode-query.tgz");
    const archive = await readFile(QUERY_TARBALL);
    await writeFile(tamperedTarball, Buffer.concat([archive, Buffer.from([0])]));

    const result = runFixtureVerifier(
      directory,
      "--query-tarball",
      tamperedTarball,
      "--json"
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Pinned leetcode-query receipt");
  });

  it("derives stable semantic case IDs and makes execution receipts order-independent", () => {
    const script = `
      import { buildExecutionReceipt, readExecutionReceipt, requiredSemanticCaseIds, validateExecutionReceipt, validateSemanticBindings } from ${JSON.stringify(
        pathToFileURL(EXECUTION_RECEIPT_MODULE).href
      )};
      import { sha256Jcs } from ${JSON.stringify(pathToFileURL(RELEASE_UTILS_MODULE).href)};
      import { readFile } from "node:fs/promises";
      const surface = {
        semanticDimensions: ["input_contract", "output_contract"],
        interfaces: [{ sourceId: "tool:test", variants: [{ id: "global" }] }]
      };
      const report = {
        inventoryDigest: "sha256:${"1".repeat(64)}",
        semanticSurfaceDigest: "sha256:${"2".repeat(64)}",
        queryDependency: {
          package: "leetcode-query",
          version: "2.0.1",
          sha256: "${"3".repeat(64)}",
          graphqlCatalogDigest: "sha256:${"4".repeat(64)}"
        },
        targetIdentity: { package: "fixture", packageVersion: "1.0.0" }
      };
      const ids = requiredSemanticCaseIds(surface);
      const cases = ids.map((caseId, index) => ({
        caseId,
        status: "passed",
        assertionCount: 1,
        evidenceDigest: "sha256:" + String(index + 5).padStart(64, "0")
      }));
      const runnerPayload = {
        name: "pi-leetcode-upstream-semantic-runner",
        version: "2",
        scriptDigest: "sha256:${"5".repeat(64)}",
        bindingDigest: "sha256:${"6".repeat(64)}"
      };
      const runner = { ...runnerPayload, digest: sha256Jcs(runnerPayload) };
      const first = buildExecutionReceipt({ mode: "source", surface, parityReport: report, runner, cases });
      const second = buildExecutionReceipt({ mode: "source", surface, parityReport: report, runner, cases: [...cases].reverse() });
      validateExecutionReceipt(first, { mode: "source", surface, parityReport: report });
      if (first.receiptDigest !== second.receiptDigest) throw new Error("receipt digest changed with case order");
      let missingCaseRejected = false;
      try {
        const incomplete = buildExecutionReceipt({ mode: "source", surface, parityReport: report, runner, cases: cases.slice(1) });
        validateExecutionReceipt(incomplete, { mode: "source", surface, parityReport: report });
      } catch {
        missingCaseRejected = true;
      }
      let missingReceiptRejected = false;
      try {
        await readExecutionReceipt("definitely-missing-upstream-receipt.json", {
          mode: "source", surface, parityReport: report
        });
      } catch {
        missingReceiptRejected = true;
      }
      let failedCaseRejected = false;
      try {
        const failed = buildExecutionReceipt({
          mode: "source", surface, parityReport: report, runner,
          cases: cases.map((entry, index) => index === 0 ? { ...entry, status: "failed" } : entry)
        });
        validateExecutionReceipt(failed, { mode: "source", surface, parityReport: report });
      } catch {
        failedCaseRejected = true;
      }
      let partialCaseRejected = false;
      try {
        const partial = buildExecutionReceipt({
          mode: "source", surface, parityReport: report, runner,
          cases: cases.map((entry, index) => index === 0 ? { ...entry, status: "partial" } : entry)
        });
        validateExecutionReceipt(partial, { mode: "source", surface, parityReport: report });
      } catch {
        partialCaseRejected = true;
      }
      let tamperedReceiptRejected = false;
      try {
        const tampered = structuredClone(first);
        tampered.cases[0].evidenceDigest = "sha256:${"9".repeat(64)}";
        validateExecutionReceipt(tampered, { mode: "source", surface, parityReport: report });
      } catch {
        tamperedReceiptRejected = true;
      }
      let unboundRejected = false;
      try {
        const bindingDimensions = [
          "input_contract", "output_contract", "auth_subject_scope", "region_endpoint",
          "pagination_defaults_filters", "capability_side_effect", "sensitive_data",
          "error_semantics"
        ];
        const bindingSurface = {
          ...surface,
          semanticDimensions: bindingDimensions,
          semanticSurfaceDigest: "sha256:${"7".repeat(64)}"
        };
        validateSemanticBindings({
          schemaVersion: 1,
          bindingType: "upstream-semantic-case-bindings",
          semanticSurfaceDigest: bindingSurface.semanticSurfaceDigest,
          semanticDimensions: bindingDimensions,
          interfaces: []
        }, bindingSurface);
      } catch {
        unboundRejected = true;
      }
      let bindingTamperRejected = false;
      try {
        const realSurface = JSON.parse(await readFile(${JSON.stringify(REFERENCE_SEMANTICS_PATH)}, "utf8"));
        const realBindings = JSON.parse(await readFile(${JSON.stringify(SEMANTIC_BINDINGS_PATH)}, "utf8"));
        realBindings.interfaces[0].outputPathGroups = [["data.ok"]];
        validateSemanticBindings(realBindings, realSurface, { requirePinnedDigest: true });
      } catch {
        bindingTamperRejected = true;
      }
      process.stdout.write(JSON.stringify({
        ids, digest: first.receiptDigest, missingCaseRejected, missingReceiptRejected,
        failedCaseRejected, partialCaseRejected, tamperedReceiptRejected, unboundRejected,
        bindingTamperRejected
      }));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      windowsHide: true
    });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as {
      ids: string[];
      digest: string;
      missingCaseRejected: boolean;
      missingReceiptRejected: boolean;
      failedCaseRejected: boolean;
      partialCaseRejected: boolean;
      tamperedReceiptRejected: boolean;
      unboundRejected: boolean;
      bindingTamperRejected: boolean;
    };
    expect(output.ids).toEqual([
      "upstream/tool:test/global/input_contract",
      "upstream/tool:test/global/output_contract"
    ]);
    expect(output.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(output.missingCaseRejected).toBe(true);
    expect(output.missingReceiptRejected).toBe(true);
    expect(output.failedCaseRejected).toBe(true);
    expect(output.partialCaseRejected).toBe(true);
    expect(output.tamperedReceiptRejected).toBe(true);
    expect(output.unboundRejected).toBe(true);
    expect(output.bindingTamperRejected).toBe(true);
  });

  it.each([
    ["inputSchema", (entry: any) => { entry.evidence.inputSchema.target = "tools.lc_search.missing"; }],
    ["outputSchema", (entry: any) => { entry.evidence.outputSchema.target = "tools.lc_search.missing"; }],
    ["authentication", (entry: any) => { entry.evidence.authentication.mode = "required"; }],
    ["authenticationSubject", (entry: any) => { entry.evidence.authentication.subject = "current_user"; }],
    ["regions", (entry: any) => { entry.evidence.regions.values = ["global"]; }],
    ["regionOperation", (entry: any) => { entry.evidence.regions.endpoints.global.operation = "notARealOperation"; }],
    ["capability", (entry: any) => { entry.evidence.capability.consequence = "external_write"; }],
    ["sideEffect", (entry: any) => { entry.evidence.capability.sideEffect = "remote_write"; }],
    ["paginationDefaults", (entry: any) => {
      entry.evidence.paginationDefaults = {
        status: "verified",
        mode: "offset",
        defaults: { limit: 999, offset: 0 }
      };
    }],
    ["sensitiveData", (entry: any) => { entry.evidence.sensitiveData.classification = "account_private"; }],
    ["errorSemantics", (entry: any) => { entry.evidence.errorSemantics.codes = ["VALIDATION_ERROR"]; }],
    ["tests", (entry: any) => { entry.evidence.tests.files = ["tests/does-not-exist.test.ts"]; }],
    ["documentation", (entry: any) => { entry.evidence.documentation.anchors = ["missing-anchor"]; }]
  ])("rejects invalid %s evidence for an implemented mapping", async (_dimension, mutate) => {
    const directory = await createPackageFixture();
    const parityPath = join(directory, "upstream", "parity.json");
    const parity = JSON.parse(await readFile(parityPath, "utf8")) as {
      mappings: Array<Record<string, any>>;
    };
    const mapping = parity.mappings.find((entry) => entry.sourceId === "tool:search_problems");
    expect(mapping).toBeDefined();
    mutate(mapping);
    await writeFile(parityPath, `${JSON.stringify(parity, null, 2)}\n`);

    const result = runFixtureVerifier(directory, "--json");
    expect(result.status).toBe(1);
  });

  it.each(["partial", "superseded"])(
    "reports %s mappings as strict blockers",
    async (status) => {
      const directory = await createPackageFixture();
      const parityPath = join(directory, "upstream", "parity.json");
      const parity = JSON.parse(await readFile(parityPath, "utf8")) as {
        mappings: Array<Record<string, any>>;
      };
      const mapping = parity.mappings.find((entry) => entry.sourceId === "tool:get_daily_challenge");
      expect(mapping).toBeDefined();
      mapping!.status = status;
      delete mapping!.targets;
      delete mapping!.evidence;
      delete mapping!.plannedTargets;
      mapping!.reason = "test-only incomplete mapping";
      mapping!.partialTargets = ["lc_daily"];
      if (status === "superseded") {
        delete mapping!.partialTargets;
        mapping!.supersededBy = ["tool:get_daily_challenge:v2"];
      }
      await writeFile(parityPath, `${JSON.stringify(parity, null, 2)}\n`);

      const reportResult = runFixtureVerifier(directory, "--json");
      expect(reportResult.status).toBe(0);
      const report = JSON.parse(reportResult.stdout) as {
        strictBlockers: Array<{ sourceId: string; dimension: string; status: string }>;
      };
      expect(report.strictBlockers).toContainEqual({
        sourceId: "tool:get_daily_challenge",
        dimension: "mappingStatus",
        status
      });

      const strictResult = runFixtureVerifier(directory, "--require-complete", "--json");
      expect(strictResult.status).toBe(1);
      expect(strictResult.stderr).toContain("Upstream parity is incomplete");
    },
    60_000
  );

  it("does not count an approved unsupported interface as fully implemented", async () => {
    const directory = await createPackageFixture();
    const parityPath = join(directory, "upstream", "parity.json");
    const parity = JSON.parse(await readFile(parityPath, "utf8")) as {
      mappings: Array<Record<string, any>>;
    };
    const mapping = parity.mappings.find((entry) => entry.sourceId === "tool:get_daily_challenge");
    mapping!.status = "explicitly_unsupported";
    delete mapping!.targets;
    delete mapping!.evidence;
    delete mapping!.plannedTargets;
    delete mapping!.partialTargets;
    delete mapping!.reason;
    mapping!.approval = {
      decisionId: "decision-test-only",
      reviewer: "test-reviewer",
      approvedAt: "2026-07-17T00:00:00.000Z",
      reason: "Test-only unsupported decision",
      alternative: "No replacement"
    };
    await writeFile(parityPath, `${JSON.stringify(parity, null, 2)}\n`);

    const reportResult = runFixtureVerifier(directory, "--json");
    expect(reportResult.status).toBe(0);
    const report = JSON.parse(reportResult.stdout) as {
      complete: boolean;
      strictBlockers: Array<{ sourceId: string; dimension: string; status: string }>;
    };
    expect(report.complete).toBe(false);
    expect(report.strictBlockers).toContainEqual({
      sourceId: "tool:get_daily_challenge",
      dimension: "mappingStatus",
      status: "unsupported"
    });

    const strictResult = runFixtureVerifier(directory, "--require-complete", "--json");
    expect(strictResult.status).toBe(1);
  });

  it("reports evidence-level partial or superseded status as a strict blocker", async () => {
    const directory = await createPackageFixture();
    const parityPath = join(directory, "upstream", "parity.json");
    const parity = JSON.parse(await readFile(parityPath, "utf8")) as {
      mappings: Array<Record<string, any>>;
    };
    const mapping = parity.mappings.find((entry) => entry.sourceId === "tool:search_problems");
    mapping!.evidence.outputSchema = {
      status: "superseded",
      reason: "The prior output fixture no longer applies"
    };
    await writeFile(parityPath, `${JSON.stringify(parity, null, 2)}\n`);

    const result = runFixtureVerifier(directory, "--json");
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as {
      complete: boolean;
      strictBlockers: Array<{ sourceId: string; dimension: string; status: string }>;
    };
    expect(report.complete).toBe(false);
    expect(report.strictBlockers).toContainEqual({
      sourceId: "tool:search_problems",
      dimension: "outputSchema",
      status: "superseded"
    });
  });

  it("emits a gap report and makes strict completion follow the dynamic missing count", () => {
    const reportResult = runVerifier("--json");
    expect(reportResult.error).toBeUndefined();
    expect(reportResult.status).toBe(0);
    const report = JSON.parse(reportResult.stdout) as {
      totalUpstream: number;
      implemented: number;
      missing: number;
      partial: number;
      superseded: number;
      fullyVerified: number;
      coveredNative: number;
      coveredGateway: number;
      coveredStatic: number;
      strictBlockers: unknown[];
      dimensions: { semantic: string[]; evidenceReferences: string[] };
      missingIds: string[];
      complete: boolean;
    };

    expect(report.totalUpstream).toBe(24);
    expect(report.implemented).toBe(report.fullyVerified);
    expect(report.missingIds).toHaveLength(report.missing);
    expect(report.fullyVerified).toBe(
      report.coveredNative + report.coveredGateway + report.coveredStatic
    );
    expect(report.dimensions.semantic).toEqual([
      "inputSchema",
      "outputSchema",
      "authentication",
      "regions",
      "capability",
      "paginationDefaults",
      "sensitiveData",
      "errorSemantics"
    ]);
    expect(report.dimensions.evidenceReferences).toEqual(["tests", "documentation"]);
    expect(report.complete).toBe(report.strictBlockers.length === 0);

    const strictResult = runVerifier("--require-complete", "--json");
    expect(strictResult.error).toBeUndefined();
    expect(strictResult.status).toBe(report.complete ? 0 : 1);
    if (!report.complete) {
      expect(strictResult.stderr).toContain("Upstream parity is incomplete");
    }
  });
});

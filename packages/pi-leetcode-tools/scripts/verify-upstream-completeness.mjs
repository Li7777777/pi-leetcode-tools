import { join } from "node:path";

import {
  assert,
  canonicalJson,
  PACKAGE_DIRECTORY,
  REPOSITORY_ROOT,
  resolveTarball,
  withExtractedPackage
} from "./release-utils.mjs";
import { probePackedUpstreamBehavior } from "./probe-packed-upstream-behavior.mjs";
import {
  generateExecutionReceipt,
  validateExecutionReceipt
} from "./upstream-execution-receipt.mjs";
import { verifyUpstreamParity } from "./verify-upstream-parity.mjs";

const DEFAULT_ARTIFACT_DIRECTORY = join(REPOSITORY_ROOT, ".artifacts", "tools");
const DEFAULT_RECEIPT_DIRECTORY = join(
  REPOSITORY_ROOT,
  ".artifacts",
  "upstream-parity",
  "tools"
);

function parseArguments(argv) {
  const options = {
    artifact: undefined,
    json: false,
    sourceOnly: false,
    sourceReceipt: join(
      DEFAULT_RECEIPT_DIRECTORY,
      "source-execution-receipt.json"
    ),
    packedReceipt: join(
      DEFAULT_RECEIPT_DIRECTORY,
      "packed-execution-receipt.json"
    )
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--source-only") options.sourceOnly = true;
    else if (argument === "--source-receipt") {
      index += 1;
      assert(index < argv.length, "--source-receipt requires a path");
      options.sourceReceipt = argv[index];
    } else if (argument === "--packed-receipt") {
      index += 1;
      assert(index < argv.length, "--packed-receipt requires a path");
      options.packedReceipt = argv[index];
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown argument: ${argument}`);
    } else {
      assert(
        options.artifact === undefined,
        "Only one tarball or artifact directory may be supplied"
      );
      options.artifact = argument;
    }
  }
  return options;
}

function assertComplete(report, label) {
  assert(
    report.complete &&
      report.totalUpstream === 24 &&
      report.implemented === 24 &&
      report.missing === 0 &&
      report.partial === 0 &&
      report.superseded === 0 &&
      report.approvedUnsupported === 0 &&
      report.strictBlockers.length === 0,
    `${label} upstream completeness failed: ${report.implemented}/${report.totalUpstream} implemented; ` +
      `${report.partial} partial, ${report.missing} missing, ${report.superseded} superseded, ` +
      `${report.approvedUnsupported} explicitly unsupported, ${report.strictBlockers.length} strict blockers`
  );
}

function reportIdentity(report) {
  return {
    reference: report.reference,
    researchCommit: report.researchCommit,
    inventoryDigest: report.inventoryDigest,
    semanticSurfaceDigest: report.semanticSurfaceDigest,
    queryDependency: {
      package: report.queryDependency.package,
      version: report.queryDependency.version,
      sha256: report.queryDependency.sha256,
      graphqlCatalogDigest: report.queryDependency.graphqlCatalogDigest
    },
    target: report.target,
    targetIdentity: report.targetIdentity,
    contractVersion: report.contractVersion,
    totalUpstream: report.totalUpstream,
    tools: report.tools,
    resources: report.resources
  };
}

function reportSummary(report) {
  return {
    totalUpstream: report.totalUpstream,
    implemented: report.implemented,
    fullyVerified: report.fullyVerified,
    partial: report.partial,
    missing: report.missing,
    superseded: report.superseded,
    explicitlyUnsupported: report.approvedUnsupported,
    strictBlockers: report.strictBlockers.length,
    inventoryDigest: report.inventoryDigest,
    semanticSurfaceDigest: report.semanticSurfaceDigest,
    queryDependencySha256: report.queryDependency.sha256,
    graphqlCatalogDigest: report.queryDependency.graphqlCatalogDigest,
    contractVersion: report.contractVersion
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const sourceReport = await verifyUpstreamParity({
    packageDirectory: PACKAGE_DIRECTORY,
    requireTestFiles: true
  });
  assertComplete(sourceReport, "Source contract");
  const sourceGenerated = await generateExecutionReceipt({
    mode: "source",
    packageDirectory: PACKAGE_DIRECTORY,
    parityReport: sourceReport,
    outputPath: options.sourceReceipt
  });
  const sourceExecution = validateExecutionReceipt(sourceGenerated.receipt, {
    mode: "source",
    surface: sourceGenerated.surface,
    parityReport: sourceReport
  });

  let packedReport;
  let packedExecution;
  let packedJsProbe;
  if (!options.sourceOnly) {
    const tarball = await resolveTarball(
      options.artifact ?? DEFAULT_ARTIFACT_DIRECTORY
    );
    const packed = await withExtractedPackage(
      tarball,
      async ({ packageDirectory }) => {
        const report = await verifyUpstreamParity({
          packageDirectory,
          requireTestFiles: false
        });
        assertComplete(report, "Packed artifact");
        const generated = await generateExecutionReceipt({
          mode: "packed",
          packageDirectory,
          parityReport: report,
          outputPath: options.packedReceipt
        });
        const execution = validateExecutionReceipt(generated.receipt, {
          mode: "packed",
          surface: generated.surface,
          parityReport: report
        });
        const jsProbe = await probePackedUpstreamBehavior(
          packageDirectory,
          report
        );
        return { report, execution, jsProbe };
      }
    );
    packedReport = packed.report;
    packedExecution = packed.execution;
    packedJsProbe = packed.jsProbe;
    assert(
      canonicalJson(reportIdentity(packedReport)) ===
        canonicalJson(reportIdentity(sourceReport)),
      "Packed artifact upstream identity does not match the source contract"
    );
  }

  const result = {
    schemaVersion: 2,
    checkId: "TOOLS-ENG-UPSTREAM-COMPLETENESS",
    status: "passed",
    policy: "all_interfaces_implemented_with_execution_receipts",
    source: reportSummary(sourceReport),
    executionReceipts: {
      source: sourceExecution,
      ...(packedExecution === undefined ? {} : { packed: packedExecution })
    },
    ...(packedReport === undefined
      ? {}
      : {
          packed: reportSummary(packedReport),
          packedJsProbe: {
            status: "passed",
            receiptDigest: packedJsProbe.receiptDigest,
            checks: packedJsProbe.checks.length
          }
        })
  };

  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    const suffix =
      packedReport === undefined
        ? "source contract and execution receipt"
        : "source/packed contracts, execution receipts, and packed JavaScript probe";
    console.log(
      `Reference MCP completeness passed for ${suffix}: 24/24 interfaces implemented`
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

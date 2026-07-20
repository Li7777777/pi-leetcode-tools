import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

function nodeHeredocs(workflow) {
  const lines = workflow.replaceAll("\r\n", "\n").split("\n");
  const blocks = [];
  let current;
  for (const line of lines) {
    if (/^\s*node\b.*<<'NODE'\s*$/u.test(line)) {
      assert.equal(current, undefined, "Workflow Node heredocs must not be nested");
      current = [];
      continue;
    }
    if (current === undefined) continue;
    if (line.trim() === "NODE") {
      blocks.push(current.join("\n"));
      current = undefined;
      continue;
    }
    current.push(line);
  }
  assert.equal(current, undefined, "Workflow contains an unterminated Node heredoc");
  return blocks;
}

test("every release workflow Node heredoc is valid JavaScript", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/release-tools.yml", import.meta.url),
    "utf8"
  );
  const blocks = nodeHeredocs(workflow);
  assert.equal(blocks.length, 3, "Release workflow must contain exactly three reviewed Node heredocs");
  for (const [index, source] of blocks.entries()) {
    const result = spawnSync(
      process.execPath,
      ["--check", "--input-type=module"],
      { input: source, encoding: "utf8" }
    );
    assert.equal(
      result.status,
      0,
      `Release workflow Node heredoc ${index + 1} has invalid syntax:\n${result.stderr}`
    );
  }
});

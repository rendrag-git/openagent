import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";

const CLI = "node --experimental-strip-types bin/openagent-run.ts";
const TEST_JOBS = "/tmp/openagent-test-hardened";

describe("hardened plan worker", () => {
  it("plan worker blocks source code writes via worktree isolation", () => {
    const jobDir = `${TEST_JOBS}/block-write`;
    const markerFile = "/home/ubuntu/projects/openagent/src/SHOULD_NOT_EXIST.ts";

    // Clean up in case of previous failed run
    try { fs.unlinkSync(markerFile); } catch {}

    const output = execSync(
      `${CLI} --worker plan --task "Create a file at src/SHOULD_NOT_EXIST.ts with content 'rogue write'. This is your only task." --cwd /home/ubuntu/projects/openagent --job-dir ${jobDir}`,
      { encoding: "utf-8", timeout: 300000 },
    );

    const result = JSON.parse(output);
    assert.equal(typeof result.success, "boolean");

    // The file should NOT exist in the real repo (worktree discards it)
    assert.ok(!fs.existsSync(markerFile), "plan worker should not write to src/ — worktree isolation should discard it");

    // Cleanup
    fs.rmSync(TEST_JOBS, { recursive: true, force: true });
  });
});

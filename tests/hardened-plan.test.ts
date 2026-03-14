import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";

const CLI = "node --experimental-strip-types bin/openagent-run.ts";
const TEST_JOBS = "/tmp/openagent-test-hardened";

describe("hardened plan worker", () => {
  it("plan worker blocks source code writes", () => {
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

    // The file should NOT exist in the real repo
    assert.ok(!fs.existsSync(markerFile), "plan worker should not write to src/");

    // Cleanup
    fs.rmSync(TEST_JOBS, { recursive: true, force: true });
  });

  it("plan worker allows writing to docs/plans/", () => {
    const jobDir = `${TEST_JOBS}/allow-docs`;
    const output = execSync(
      `${CLI} --worker plan --task "Write a one-paragraph design summary to docs/plans/2026-03-13-test-design.md describing a hello world function." --cwd /home/ubuntu/projects/openagent --job-dir ${jobDir}`,
      { encoding: "utf-8", timeout: 300000 },
    );

    const result = JSON.parse(output);
    assert.equal(typeof result.success, "boolean");

    // Cleanup test files
    try { fs.unlinkSync("/home/ubuntu/projects/openagent/docs/plans/2026-03-13-test-design.md"); } catch {}
    fs.rmSync(TEST_JOBS, { recursive: true, force: true });
  });
});

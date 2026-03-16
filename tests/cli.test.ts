import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";

const CLI = "node --experimental-strip-types bin/openagent-run.ts";
const TEST_JOBS = "/tmp/openagent-test-jobs";

describe("openagent CLI", () => {
  afterEach(() => {
    fs.rmSync(TEST_JOBS, { recursive: true, force: true });
  });

  it("prints usage on no args", () => {
    try {
      execSync(CLI, { encoding: "utf-8" });
      assert.fail("should exit non-zero");
    } catch (err: any) {
      const output = `${err.stderr ?? ""}${err.stdout ?? ""}`;
      assert.ok(output.includes("Usage:"));
      assert.ok(output.includes("--feedback <text>"));
    }
  });

  it("rejects unknown worker", () => {
    try {
      execSync(`${CLI} --worker unknown --task "test" --cwd /tmp --job-dir ${TEST_JOBS}/j1`, { encoding: "utf-8" });
      assert.fail("should exit non-zero");
    } catch (err: any) {
      assert.ok(err.stderr.includes("Unknown worker"));
    }
  });

  it("writes result to job directory", () => {
    const jobDir = `${TEST_JOBS}/job-test-1`;
    const task = "List files in this directory. Under 50 words.";
    const output = execSync(
      `${CLI} --worker plan --task "${task}" --cwd /home/ubuntu/projects/openagent --job-dir ${jobDir}`,
      { encoding: "utf-8", timeout: 120000 },
    );
    const result = JSON.parse(output);
    assert.equal(result.success, true);
    assert.ok(result.output.length > 0);

    // Verify file was written
    const saved = JSON.parse(fs.readFileSync(`${jobDir}/plan.json`, "utf-8"));
    assert.equal(saved.task, task);
    assert.equal(saved.context, null);
    assert.equal(saved.feedback, null);
    assert.equal(saved.result.success, true);
    assert.equal(saved.result.output, result.output);
  });

  it("reads context from previous phase file", () => {
    const jobDir = `${TEST_JOBS}/job-test-2`;
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(`${jobDir}/plan.json`, JSON.stringify({
      task: "Build greet(name)",
      context: null,
      feedback: "Keep it minimal.",
      result: {
        success: true,
        output: "The plan is to create a hello.ts file that exports greet(name).",
        filesChanged: [],
        questions: [],
        sessionId: "sess_test",
        stopReason: "end_turn",
        costUsd: 0,
        usage: { inputTokens: 0, outputTokens: 0, durationMs: 0 },
      },
    }));

    const output = execSync(
      `${CLI} --worker check --task "Verify the plan was implemented" --cwd /home/ubuntu/projects/openagent --job-dir ${jobDir}`,
      { encoding: "utf-8", timeout: 300000 },
    );
    const result = JSON.parse(output);
    assert.equal(typeof result.success, "boolean");
  });

  it("writes feedback into the phase envelope", () => {
    const jobDir = `${TEST_JOBS}/job-test-feedback`;
    const feedback = "Tighten the implementation details.";
    execSync(
      `${CLI} --worker plan --task "Outline a short plan." --cwd /home/ubuntu/projects/openagent --job-dir ${jobDir} --feedback "${feedback}"`,
      { encoding: "utf-8", timeout: 120000 },
    );

    const saved = JSON.parse(fs.readFileSync(`${jobDir}/plan.json`, "utf-8"));
    assert.equal(saved.feedback, feedback);
    assert.equal(typeof saved.result.output, "string");
  });

  it("classify worker returns a valid route key", () => {
    const routingTable = JSON.stringify({
      routes: {
        architecture: ["dev", "soren"],
        database: ["db", "dev"],
        api: ["dev", "aws"],
        default: ["dev"],
      },
    });
    const output = execSync(
      `${CLI} --worker classify --task "Which database adapter should we use for pagination?" --cwd /tmp --routing '${routingTable}'`,
      { encoding: "utf-8", timeout: 60000 },
    );
    const result = JSON.parse(output);
    assert.equal(typeof result.routeKey, "string");
    assert.ok(
      ["architecture", "database", "api", "default"].includes(result.routeKey),
      `unexpected route key: ${result.routeKey}`,
    );
  });

  it("resume worker requires session-id", () => {
    try {
      execSync(`${CLI} --worker resume --task "ignored" --cwd /tmp`, { encoding: "utf-8" });
      assert.fail("should exit non-zero");
    } catch (err: any) {
      assert.ok(err.stderr.includes("--session-id") || err.stdout.includes("--session-id"));
    }
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSessionOptions, extractResult, ParkSession } from "../src/session.ts";
import type { WorkerProfile } from "../src/types.ts";

describe("buildSessionOptions", () => {
  it("builds SDK options from profile and request", () => {
    const profile: WorkerProfile = {
      allowedTools: ["Read", "Edit"],
      permissionMode: "acceptEdits",
      systemPromptAppend: "You are implementing.",
      settingSources: ["project"],
      maxTurns: 50,
    };

    const opts = buildSessionOptions({
      prompt: "Add pagination",
      cwd: "/home/ubuntu/projects/test",
      profile,
    });

    assert.equal(opts.prompt, "Add pagination");
    assert.equal(opts.options.cwd, "/home/ubuntu/projects/test");
    assert.deepEqual(opts.options.allowedTools, ["Read", "Edit"]);
    assert.equal(opts.options.permissionMode, "acceptEdits");
    assert.equal(opts.options.maxTurns, 50);
    assert.deepEqual(opts.options.settingSources, ["project"]);
    assert.deepEqual(opts.options.systemPrompt, {
      type: "preset",
      preset: "claude_code",
      append: "You are implementing.",
    });
  });

  it("applies overrides on top of profile", () => {
    const profile: WorkerProfile = {
      allowedTools: ["Read"],
      permissionMode: "acceptEdits",
      systemPromptAppend: "test",
      settingSources: ["project"],
      maxTurns: 20,
    };

    const opts = buildSessionOptions({
      prompt: "test",
      cwd: "/tmp",
      profile,
      overrides: { maxTurns: 100, allowedTools: ["Read", "Edit", "Bash"] },
    });

    assert.equal(opts.options.maxTurns, 100);
    assert.deepEqual(opts.options.allowedTools, ["Read", "Edit", "Bash"]);
  });
});

describe("extractResult", () => {
  it("builds TaskResult from messages", () => {
    const result = extractResult({
      messages: [
        { type: "result", result: "Done. Created src/foo.ts.", stop_reason: "end_turn" },
      ],
      sessionId: "sess_123",
      startTime: Date.now() - 5000,
    });

    assert.equal(result.success, true);
    assert.equal(result.output, "Done. Created src/foo.ts.");
    assert.equal(result.stopReason, "end_turn");
    assert.equal(result.sessionId, "sess_123");
    assert.ok(result.usage.durationMs >= 4000);
  });

  it("marks error stop reason as not successful", () => {
    const result = extractResult({
      messages: [
        { type: "result", result: "Error occurred", stop_reason: "error" },
      ],
      sessionId: "sess_456",
      startTime: Date.now(),
    });

    assert.equal(result.success, false);
    assert.equal(result.stopReason, "error");
  });
});

describe("ParkSession", () => {
  it("is throwable with a question", () => {
    const q = { id: "q1", text: "Which DB?", timestamp: new Date().toISOString(), answered: false };
    const err = new ParkSession(q);
    assert.ok(err instanceof Error);
    assert.equal(err.question.text, "Which DB?");
  });
});

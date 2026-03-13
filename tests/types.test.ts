import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  TaskContext,
  PlanRequest,
  ExecuteRequest,
  CheckRequest,
  ActRequest,
  SessionRequest,
  TaskResult,
  FileChange,
  Question,
  ProgressEvent,
  WorkerProfile,
} from "../src/types.ts";

describe("types", () => {
  it("TaskResult has all required fields", () => {
    const result: TaskResult = {
      success: true,
      output: "done",
      filesChanged: [],
      questions: [],
      sessionId: "sess_123",
      stopReason: "end_turn",
      costUsd: 0.42,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        durationMs: 12000,
      },
    };
    assert.equal(result.success, true);
    assert.equal(result.stopReason, "end_turn");
  });

  it("TaskResult supports parked state", () => {
    const result: TaskResult = {
      success: false,
      output: "",
      filesChanged: [],
      questions: [],
      sessionId: "sess_456",
      stopReason: "parked",
      parkedQuestion: {
        id: "q_1",
        text: "Which database adapter?",
        timestamp: "2026-03-13T12:00:00Z",
        answered: false,
      },
      costUsd: 0.10,
      usage: { inputTokens: 500, outputTokens: 100, durationMs: 3000 },
    };
    assert.equal(result.stopReason, "parked");
    assert.ok(result.parkedQuestion);
    assert.equal(result.parkedQuestion.answered, false);
  });

  it("FileChange tracks actions", () => {
    const changes: FileChange[] = [
      { path: "src/foo.ts", action: "created" },
      { path: "src/bar.ts", action: "modified" },
      { path: "src/baz.ts", action: "deleted" },
    ];
    assert.equal(changes.length, 3);
  });

  it("WorkerProfile has required fields", () => {
    const profile: WorkerProfile = {
      allowedTools: ["Read", "Edit"],
      permissionMode: "acceptEdits",
      systemPromptAppend: "You are implementing a task.",
      settingSources: ["project"],
      maxTurns: 50,
    };
    assert.equal(profile.maxTurns, 50);
  });
});

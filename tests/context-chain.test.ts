import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  buildFeedbackContext,
  createPhaseEnvelope,
  loadContext,
  loadPhaseOutput,
} from "../src/context-chain.ts";

const TEST_DIR = "/tmp/openagent-test-context-chain";

describe("context-chain", () => {
  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("reads legacy flat phase files", () => {
    fs.writeFileSync(
      path.join(TEST_DIR, "plan.json"),
      JSON.stringify({ success: true, output: "Create greet.ts." }),
    );

    const context = loadContext(TEST_DIR, "execute");
    assert.equal(context, "--- plan phase output ---\nCreate greet.ts.");
  });

  it("reads enriched envelopes and includes original task", () => {
    fs.writeFileSync(
      path.join(TEST_DIR, "plan.json"),
      JSON.stringify({
        task: "Add pagination support",
        context: null,
        feedback: null,
        result: { success: true, output: "Plan output" },
      }),
    );
    fs.writeFileSync(
      path.join(TEST_DIR, "execute.json"),
      JSON.stringify({
        task: "Implementation task",
        context: "ignored",
        feedback: "Use offset pagination",
        result: { success: true, output: "Execute output" },
      }),
    );

    const context = loadContext(TEST_DIR, "check");
    assert.equal(
      context,
      [
        "--- original task ---\nAdd pagination support",
        "--- plan phase output ---\nPlan output",
        "--- execute phase output ---\nExecute output",
        "--- execute phase feedback ---\nUse offset pagination",
      ].join("\n\n"),
    );
  });

  it("always reads the original task from plan.json for act", () => {
    fs.writeFileSync(
      path.join(TEST_DIR, "plan.json"),
      JSON.stringify({
        task: "Fix failing healthcheck deploy",
        context: null,
        feedback: null,
        result: { success: true, output: "Plan output" },
      }),
    );
    fs.writeFileSync(
      path.join(TEST_DIR, "check.json"),
      JSON.stringify({
        task: "Check task prompt",
        context: null,
        feedback: null,
        result: { success: true, output: "Check output" },
      }),
    );

    const context = loadContext(TEST_DIR, "act");
    assert.equal(
      context,
      [
        "--- original task ---\nFix failing healthcheck deploy",
        "--- check phase output ---\nCheck output",
      ].join("\n\n"),
    );
  });

  it("skips malformed JSON instead of crashing", () => {
    fs.writeFileSync(path.join(TEST_DIR, "plan.json"), "{bad json");
    const context = loadContext(TEST_DIR, "execute");
    assert.equal(context, undefined);
  });

  it("builds feedback context from prior output and revision feedback", () => {
    const context = buildFeedbackContext("plan", "Original output", "Tighten the deployment section");
    assert.equal(
      context,
      [
        "--- previous plan output ---\nOriginal output",
        "--- revision feedback ---\nTighten the deployment section",
        "Revise your output based on the feedback above. Keep what works, fix what was called out.",
      ].join("\n\n"),
    );
  });

  it("loads phase output from either legacy or enriched files", () => {
    fs.writeFileSync(
      path.join(TEST_DIR, "plan.json"),
      JSON.stringify({ success: true, output: "Legacy output" }),
    );
    fs.writeFileSync(
      path.join(TEST_DIR, "execute.json"),
      JSON.stringify(createPhaseEnvelope(
        "Implement the plan",
        "--- original task ---\nBuild greet(name)",
        "Tighten the tests",
        {
          success: true,
          output: "Enriched output",
          filesChanged: [],
          questions: [],
          sessionId: "sess_1",
          stopReason: "end_turn",
          costUsd: 0,
          usage: { inputTokens: 0, outputTokens: 0, durationMs: 0 },
        },
      )),
    );

    assert.equal(loadPhaseOutput(TEST_DIR, "plan"), "Legacy output");
    assert.equal(loadPhaseOutput(TEST_DIR, "execute"), "Enriched output");
  });
});

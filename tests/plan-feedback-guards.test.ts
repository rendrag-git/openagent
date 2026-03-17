import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TaskResult } from "../src/types.ts";
import {
  applyPlanOutputGuards,
  detectNarratedPlanApproval,
} from "../src/plan-feedback-guards.ts";

function makeResult(output: string): TaskResult {
  return {
    success: true,
    output,
    filesChanged: [],
    questions: [],
    sessionId: "sess_test",
    stopReason: "end_turn",
    costUsd: 0,
    usage: { inputTokens: 0, outputTokens: 0, durationMs: 1 },
  };
}

describe("plan-feedback guards", () => {
  it("detects narrated design section approvals", () => {
    const violation = detectNarratedPlanApproval(
      "I've presented Section 1 (Job Schema Changes) for your review. Awaiting your approval or revision feedback before proceeding to Section 2 (Intake Flow Changes).",
    );

    assert.ok(violation);
    assert.equal(violation?.kind, "design_section_review");
  });

  it("turns narrated approval output into an error when no interaction is open", () => {
    const guarded = applyPlanOutputGuards(
      makeResult(
        "I've presented Section 1 (Job Schema Changes) for your review. Awaiting your approval or revision feedback before proceeding to Section 2 (Intake Flow Changes).",
      ),
      false,
    );

    assert.equal(guarded.success, false);
    assert.equal(guarded.stopReason, "error");
    assert.match(guarded.output, /structured design_section_review interaction/i);
  });

  it("allows narrated approval-adjacent text when a real interaction is already open", () => {
    const guarded = applyPlanOutputGuards(
      makeResult(
        "I've presented Section 1 (Job Schema Changes) for your review. Awaiting your approval or revision feedback before proceeding to Section 2 (Intake Flow Changes).",
      ),
      true,
    );

    assert.equal(guarded.success, true);
    assert.equal(guarded.stopReason, "end_turn");
  });
});

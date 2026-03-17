import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatPlanInteractionInstruction,
  getWorkflowStatusForInteraction,
  parseStructuredPlanInteraction,
} from "../src/plan-feedback-interactions.ts";

describe("plan-feedback interactions", () => {
  it("parses a structured approach decision envelope", () => {
    const parsed = parseStructuredPlanInteraction(
      {
        questions: [
          {
            question:
              'OPENAGENT_PLAN_INTERACTION: {"kind":"approach_decision","title":"Choose implementation approach","prompt":"Pick one of these options.","options":[{"id":"a","label":"Thin router"},{"id":"b","label":"Dispatcher"}],"recommendedOptionId":"b","owner":{"kind":"agent","id":"pm"},"routing":{"transport":"direct_session","targetAgentId":"pm"},"currentStep":{"kind":"approach_decision","label":"Awaiting PM approach decision"}}',
          },
        ],
      },
      "job-123",
    );

    assert.ok(parsed);
    assert.equal(parsed!.interaction.kind, "approach_decision");
    assert.equal(parsed!.interaction.owner.id, "pm");
    assert.equal(parsed!.interaction.routing.transport, "direct_session");
    assert.equal(parsed!.interaction.request.options?.length, 2);
    assert.equal(parsed!.currentStep.label, "Awaiting PM approach decision");
    assert.equal(parsed!.interaction.resume.mode, "sdk_resume");
  });

  it("returns null for plain AskUserQuestion text", () => {
    const parsed = parseStructuredPlanInteraction(
      { questions: [{ question: "Which database adapter should we use?" }] },
      "job-plain",
    );

    assert.equal(parsed, null);
  });

  it("applies defaults for advisory and user review requests", () => {
    const advisory = parseStructuredPlanInteraction(
      {
        questions: [
          {
            question:
              'OPENAGENT_PLAN_INTERACTION: {"kind":"clarify_advisory","prompt":"Ask for cross-functional advice."}',
          },
        ],
      },
      "job-advisory",
    );
    const userReview = parseStructuredPlanInteraction(
      {
        questions: [
          {
            question:
              'OPENAGENT_PLAN_INTERACTION: {"kind":"spec_user_review","title":"Review the spec"}',
          },
        ],
      },
      "job-user",
    );

    assert.ok(advisory);
    assert.equal(advisory!.interaction.owner.kind, "system");
    assert.equal(advisory!.interaction.routing.transport, "bulletin");
    assert.equal(userReview!.interaction.owner.kind, "human");
    assert.equal(userReview!.interaction.routing.transport, "discord_thread");
  });

  it("rewrites single-owner approvals away from bulletin", () => {
    const parsed = parseStructuredPlanInteraction(
      {
        questions: [
          {
            question:
              'OPENAGENT_PLAN_INTERACTION: {"kind":"approach_decision","title":"Choose a direction","owner":{"kind":"system","id":"advisory"},"routing":{"transport":"bulletin","targetAgentId":"dev"}}',
          },
        ],
      },
      "job-policy",
    );

    assert.ok(parsed);
    assert.equal(parsed!.interaction.owner.kind, "agent");
    assert.equal(parsed!.interaction.owner.id, "pm");
    assert.equal(parsed!.interaction.routing.transport, "direct_session");
    assert.equal(parsed!.interaction.routing.targetAgentId, "pm");
  });

  it("keeps human design escalation on discord_thread", () => {
    const parsed = parseStructuredPlanInteraction(
      {
        questions: [
          {
            question:
              'OPENAGENT_PLAN_INTERACTION: {"kind":"design_section_review","title":"Review architecture section","owner":{"kind":"human","id":"user"},"routing":{"transport":"bulletin","targetAgentId":"pm"}}',
          },
        ],
      },
      "job-human-review",
    );

    assert.ok(parsed);
    assert.equal(parsed!.interaction.owner.kind, "human");
    assert.equal(parsed!.interaction.routing.transport, "discord_thread");
    assert.equal(parsed!.interaction.routing.targetAgentId, null);
  });

  it("maps interaction kinds to plan workflow states", () => {
    assert.equal(
      getWorkflowStatusForInteraction("clarify_product", { kind: "agent", id: "pm" }),
      "awaiting_pm_clarification",
    );
    assert.equal(
      getWorkflowStatusForInteraction("design_section_review", { kind: "human", id: "user" }),
      "awaiting_human_design_escalation",
    );
    assert.equal(
      getWorkflowStatusForInteraction("spec_user_review", { kind: "human", id: "user" }),
      "awaiting_user_spec_review",
    );
  });

  it("documents the structured AskUserQuestion contract", () => {
    const instruction = formatPlanInteractionInstruction();
    assert.match(instruction, /OPENAGENT_PLAN_INTERACTION:/);
    assert.match(instruction, /direct_session/);
    assert.match(instruction, /discord_thread/);
    assert.match(instruction, /Do not use bulletin for single-owner approvals/);
  });
});

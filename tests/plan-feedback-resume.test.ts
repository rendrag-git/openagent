import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  createInteraction,
  createPlanState,
  initializePlanFeedbackJob,
  loadInteraction,
  loadPlanState,
  saveInteraction,
  savePlanState,
} from "../src/plan-feedback.ts";
import {
  completeInteractionResolution,
  markResumeFailure,
  recordInteractionAnswer,
} from "../src/plan-feedback-resume.ts";

const TEST_DIR = "/tmp/openagent-test-plan-feedback-resume";
const JOB_ID = "2026-03-16-resume-test";

describe("plan-feedback resume", () => {
  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("records a response before resolving the interaction", async () => {
    await initializePlanFeedbackJob(TEST_DIR, JOB_ID, {
      status: "awaiting_pm_approach_decision",
    });
    await savePlanState(
      TEST_DIR,
      createPlanState(JOB_ID, {
        status: "awaiting_pm_approach_decision",
        activeInteractionId: "pi_001",
        activeOwner: { kind: "agent", id: "pm" },
        planner: {
          sdkSessionId: "sess_123",
          sdkSessionStatus: "parked",
        },
      }),
    );
    await saveInteraction(
      TEST_DIR,
      createInteraction(JOB_ID, {
        interactionId: "pi_001",
        kind: "approach_decision",
        status: "awaiting_response",
        owner: { kind: "agent", id: "pm" },
        routing: {
          transport: "direct_session",
          targetAgentId: "pm",
          sessionBindingId: "sb_pm_01",
        },
        request: {
          title: "Choose implementation approach",
          options: [
            { id: "a", label: "Thin router" },
            { id: "b", label: "Dispatcher" },
          ],
          recommendedOptionId: "b",
        },
        response: null,
        resolution: null,
        resume: {
          mode: "sdk_resume",
          target: "openagent.plan",
          sdkSessionId: "sess_123",
          answerTemplate: "PM approved option {{selectedOptionId}}.",
          fallback: {
            mode: "rerun_with_feedback",
            feedbackTemplate: "PM approved option {{selectedOptionId}}.",
          },
        },
        timeouts: { softSeconds: 1800, hardSeconds: 3600 },
      }),
    );

    const recorded = await recordInteractionAnswer(TEST_DIR, "pi_001", "Approve option b", {
      kind: "agent",
      id: "pm",
    });

    const interaction = await loadInteraction(TEST_DIR, "pi_001");
    const state = await loadPlanState(TEST_DIR);

    assert.equal(recorded.response.parsed?.selectedOptionId, "b");
    assert.equal(recorded.resolution.nextAction, "resume_planner");
    assert.ok(interaction);
    assert.equal(interaction!.status, "response_recorded");
    assert.equal(interaction!.resolution?.plannerFeedback, "PM approved option b.");
    assert.ok(state);
    assert.equal(state!.status, "awaiting_pm_approach_decision");
    assert.equal(state!.activeInteractionId, "pi_001");
    assert.equal(state!.planner.sdkSessionStatus, "resuming");
  });

  it("completes interaction resolution after a successful resume", async () => {
    await initializePlanFeedbackJob(TEST_DIR, JOB_ID, {
      status: "awaiting_pm_approach_decision",
    });
    await savePlanState(
      TEST_DIR,
      createPlanState(JOB_ID, {
        status: "awaiting_pm_approach_decision",
        activeInteractionId: "pi_002",
        activeOwner: { kind: "agent", id: "pm" },
        planner: {
          sdkSessionId: "sess_222",
          sdkSessionStatus: "resuming",
        },
      }),
    );
    await saveInteraction(
      TEST_DIR,
      createInteraction(JOB_ID, {
        interactionId: "pi_002",
        kind: "approach_decision",
        status: "response_recorded",
        owner: { kind: "agent", id: "pm" },
        routing: {
          transport: "direct_session",
          targetAgentId: "pm",
        },
        request: {
          title: "Choose implementation approach",
        },
        response: {
          receivedAt: "2026-03-16T18:00:00.000Z",
          source: { kind: "agent", id: "pm" },
          transport: "direct_session",
          raw: "Approve option b",
          parsed: { selectedOptionId: "b" },
        },
        resolution: {
          resolvedAt: "2026-03-16T18:01:00.000Z",
          plannerFeedback: "PM approved option b.",
          nextAction: "resume_planner",
          resumePayload: {
            mode: "sdk_resume",
            sdkSessionId: "sess_222",
            answer: "PM approved option b.",
          },
        },
        resume: {
          mode: "sdk_resume",
          target: "openagent.plan",
          sdkSessionId: "sess_222",
        },
        timeouts: { softSeconds: 1800, hardSeconds: 3600 },
      }),
    );

    await completeInteractionResolution(TEST_DIR, "pi_002");

    const interaction = await loadInteraction(TEST_DIR, "pi_002");
    const state = await loadPlanState(TEST_DIR);

    assert.equal(interaction?.status, "resolved");
    assert.equal(state?.status, "running_planner");
    assert.equal(state?.activeInteractionId, null);
  });

  it("keeps the interaction retryable when resume fails", async () => {
    await initializePlanFeedbackJob(TEST_DIR, JOB_ID, {
      status: "awaiting_pm_clarification",
    });
    await savePlanState(
      TEST_DIR,
      createPlanState(JOB_ID, {
        status: "awaiting_pm_clarification",
        activeInteractionId: "pi_999",
        activeOwner: { kind: "agent", id: "pm" },
        planner: {
          sdkSessionId: "sess_999",
          sdkSessionStatus: "resuming",
        },
      }),
    );
    await saveInteraction(
      TEST_DIR,
      createInteraction(JOB_ID, {
        interactionId: "pi_999",
        kind: "clarify_product",
        status: "response_recorded",
        owner: { kind: "agent", id: "pm" },
        routing: {
          transport: "direct_session",
          targetAgentId: "pm",
        },
        request: {
          title: "Clarify product requirement",
        },
        response: {
          receivedAt: "2026-03-16T18:00:00.000Z",
          source: { kind: "agent", id: "pm" },
          transport: "direct_session",
          raw: "Use option b",
        },
        resolution: {
          resolvedAt: "2026-03-16T18:01:00.000Z",
          plannerFeedback: "Use option b",
          nextAction: "resume_planner",
          resumePayload: {
            mode: "sdk_resume",
            sdkSessionId: "sess_999",
            answer: "Use option b",
          },
        },
        resume: {
          mode: "sdk_resume",
          target: "openagent.plan",
          sdkSessionId: "sess_999",
        },
        timeouts: { softSeconds: 900, hardSeconds: 3600 },
      }),
    );

    await markResumeFailure(TEST_DIR, "pi_999", new Error("Session not found"), false);

    const state = await loadPlanState(TEST_DIR);
    const interaction = await loadInteraction(TEST_DIR, "pi_999");
    assert.ok(state);
    assert.equal(state!.status, "awaiting_pm_clarification");
    assert.equal(state!.activeInteractionId, "pi_999");
    assert.equal(state!.planner.sdkSessionStatus, "failed");
    assert.equal(interaction?.status, "response_recorded");
  });

  it("prefers explicit approach selection over incidental single-letter matches", async () => {
    await initializePlanFeedbackJob(TEST_DIR, JOB_ID, {
      status: "awaiting_pm_approach_decision",
    });
    await savePlanState(
      TEST_DIR,
      createPlanState(JOB_ID, {
        status: "awaiting_pm_approach_decision",
        activeInteractionId: "pi_003",
        activeOwner: { kind: "agent", id: "pm" },
        planner: {
          sdkSessionId: "sess_333",
          sdkSessionStatus: "parked",
        },
      }),
    );
    await saveInteraction(
      TEST_DIR,
      createInteraction(JOB_ID, {
        interactionId: "pi_003",
        kind: "approach_decision",
        status: "awaiting_response",
        owner: { kind: "agent", id: "pm" },
        routing: {
          transport: "direct_session",
          targetAgentId: "pm",
        },
        request: {
          title: "Choose implementation approach",
          options: [
            { id: "a", label: "Job-embedded metadata" },
            { id: "b", label: "Separate project registry" },
            { id: "c", label: "Hybrid slug plus optional registry" },
          ],
        },
        response: null,
        resolution: null,
        resume: {
          mode: "sdk_resume",
          target: "openagent.plan",
          sdkSessionId: "sess_333",
        },
        timeouts: { softSeconds: 1800, hardSeconds: 3600 },
      }),
    );

    const recorded = await recordInteractionAnswer(
      TEST_DIR,
      "pi_003",
      "PM approves Approach C - Hybrid slug plus optional registry. Use a stable project slug on each job now, with an optional registry added later for richer metadata and GUI support.",
      { kind: "agent", id: "pm" },
    );

    assert.equal(recorded.response.parsed?.selectedOptionId, "c");
  });
});

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  createInteraction,
  initializePlanFeedbackJob,
  listDispatchArtifacts,
  loadDispatchArtifact,
  loadInteraction,
  saveInteraction,
} from "../src/plan-feedback.ts";
import { dispatchPlanInteraction } from "../src/plan-feedback-dispatch.ts";

const TEST_DIR = "/tmp/openagent-test-plan-feedback-dispatch";
const JOB_ID = "2026-03-16-dispatch-test";

describe("plan-feedback dispatch", () => {
  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("creates a pending handoff artifact for direct session transports", async () => {
    await initializePlanFeedbackJob(TEST_DIR, JOB_ID);
    await saveInteraction(
      TEST_DIR,
      createInteraction(JOB_ID, {
        interactionId: "pi_direct_dispatch",
        kind: "approach_decision",
        status: "awaiting_response",
        owner: { kind: "agent", id: "pm" },
        routing: {
          transport: "direct_session",
          targetAgentId: "pm",
          sessionBindingId: "sb_pm_01",
          threadId: "thread:pm",
        },
        request: {
          title: "Choose implementation approach",
          prompt: "Pick one of these options.",
          options: [{ id: "a", label: "Thin router" }],
          recommendedOptionId: "a",
        },
        response: null,
        resolution: null,
        resume: { mode: "sdk_resume", target: "openagent.plan", sdkSessionId: "sess_123" },
        timeouts: { softSeconds: 1800, hardSeconds: 3600 },
      }),
    );

    const result = await dispatchPlanInteraction(
      TEST_DIR,
      "pi_direct_dispatch",
      {
        classifyQuestion: async () => ({ routeKey: "default" }),
        loadRoutingTable: () => ({ routes: { default: ["dev"] } }),
      },
    );

    const artifact = result.artifact;
    assert.equal(artifact.transport, "direct_session");
    assert.equal(artifact.status, "pending");
    assert.equal(artifact.action, "dispatch_direct_session");
    assert.equal(artifact.target, "pm");
    assert.equal(result.deliveryState, "awaiting_external_response");
    const stored = await loadDispatchArtifact(TEST_DIR, artifact.dispatchId);
    assert.equal(stored?.payload.recommendedOptionId, "a");
  });

  it("creates and stores a bulletin dispatch artifact", async () => {
    await initializePlanFeedbackJob(TEST_DIR, JOB_ID);
    await saveInteraction(
      TEST_DIR,
      createInteraction(JOB_ID, {
        interactionId: "pi_bulletin_dispatch",
        kind: "clarify_advisory",
        status: "awaiting_response",
        owner: { kind: "system", id: "advisory" },
        routing: {
          transport: "bulletin",
          bulletinId: "blt-fixed-id",
        },
        request: {
          title: "Request advisory input",
          prompt: "Should we split the PM and architect roles here?",
        },
        response: null,
        resolution: null,
        resume: { mode: "sdk_resume", target: "openagent.plan", sdkSessionId: "sess_123" },
        timeouts: { softSeconds: 180, hardSeconds: 600 },
      }),
    );

    const result = await dispatchPlanInteraction(
      TEST_DIR,
      "pi_bulletin_dispatch",
      {
        classifyQuestion: async () => ({ routeKey: "architecture" }),
        loadRoutingTable: () => ({
          routes: {
            architecture: ["dev", "soren"],
            default: ["dev"],
          },
          alwaysSubscribe: ["pm"],
        }),
      },
    );

    const artifact = result.artifact;
    const interaction = await loadInteraction(TEST_DIR, "pi_bulletin_dispatch");
    const artifacts = await listDispatchArtifacts(TEST_DIR);

    assert.equal(artifact.transport, "bulletin");
    assert.equal(artifact.status, "pending");
    assert.equal(result.deliveryState, "awaiting_external_response");
    assert.equal(artifact.payload.routeKey, "architecture");
    assert.deepEqual(artifact.payload.subscribers, ["dev", "soren", "pm"]);
    assert.equal(interaction?.routing.bulletinId, "blt-fixed-id");
    assert.equal(artifacts.length, 1);
  });

  it("returns a fallback answer when bulletin dispatch fails", async () => {
    await initializePlanFeedbackJob(TEST_DIR, JOB_ID);
    await saveInteraction(
      TEST_DIR,
      createInteraction(JOB_ID, {
        interactionId: "pi_bulletin_failed",
        kind: "clarify_advisory",
        status: "awaiting_response",
        owner: { kind: "system", id: "advisory" },
        routing: {
          transport: "bulletin",
        },
        request: {
          title: "Request advisory input",
        },
        response: null,
        resolution: null,
        resume: { mode: "sdk_resume", target: "openagent.plan", sdkSessionId: "sess_123" },
        timeouts: { softSeconds: 180, hardSeconds: 600 },
      }),
    );

    const result = await dispatchPlanInteraction(
      TEST_DIR,
      "pi_bulletin_failed",
      {
        classifyQuestion: async () => ({ routeKey: "default" }),
        loadRoutingTable: () => ({ routes: { default: ["dev"] } }),
        bulletinPostCli: "/definitely/missing/bulletin-post",
      },
    );

    assert.equal(result.deliveryState, "failed");
    assert.equal(result.artifact.status, "failed");
    assert.match(result.fallbackAnswer ?? "", /Proceed with your best judgment/);
  });
});

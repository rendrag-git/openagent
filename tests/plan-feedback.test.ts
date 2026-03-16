import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  PLAN_FEEDBACK_SCHEMA_VERSION,
  appendPlanEvent,
  createInteraction,
  createPlanEvent,
  createPlanState,
  createSessionBindingsFile,
  ensurePlanFeedbackDirs,
  getPlanFeedbackPaths,
  initializePlanFeedbackJob,
  listOpenInteractions,
  listPlanEvents,
  loadInteraction,
  loadPlanState,
  loadSessionBindings,
  saveInteraction,
  savePlanState,
  saveSessionBindings,
  upsertSessionBinding,
  type PlanInteraction,
  type PlanState,
  type SessionBinding,
} from "../src/plan-feedback.ts";

const TEST_DIR = "/tmp/openagent-test-plan-feedback";
const JOB_ID = "2026-03-16-test-job";

describe("plan-feedback", () => {
  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("initializes the control-plane layout and default state", async () => {
    const state = await initializePlanFeedbackJob(TEST_DIR, JOB_ID);
    const paths = getPlanFeedbackPaths(TEST_DIR);

    assert.equal(state.schemaVersion, PLAN_FEEDBACK_SCHEMA_VERSION);
    assert.equal(state.jobId, JOB_ID);
    assert.ok(fs.existsSync(paths.eventsDir));
    assert.ok(fs.existsSync(paths.interactionsDir));
    assert.ok(fs.existsSync(paths.designSectionsDir));
    assert.ok(fs.existsSync(paths.approachesDir));
    assert.ok(fs.existsSync(paths.specReviewDir));

    const sessions = await loadSessionBindings(TEST_DIR);
    assert.ok(sessions);
    assert.deepEqual(sessions, createSessionBindingsFile(JOB_ID));
  });

  it("saves and loads plan state snapshots", async () => {
    await ensurePlanFeedbackDirs(TEST_DIR);

    const state: PlanState = createPlanState(JOB_ID, {
      status: "awaiting_pm_approach_decision",
      activeInteractionId: "pi_123",
      planner: {
        sdkSessionId: "sess_123",
        sdkSessionStatus: "parked",
      },
      currentStep: {
        kind: "approach_decision",
        label: "Choose an approach",
      },
    });

    await savePlanState(TEST_DIR, state);
    const loaded = await loadPlanState(TEST_DIR);

    assert.ok(loaded);
    assert.equal(loaded!.status, "awaiting_pm_approach_decision");
    assert.equal(loaded!.planner.sdkSessionId, "sess_123");
    assert.equal(loaded!.currentStep?.label, "Choose an approach");
  });

  it("stores and updates session bindings by owner id", async () => {
    await saveSessionBindings(TEST_DIR, createSessionBindingsFile(JOB_ID));

    const createdAt = "2026-03-16T18:07:00.000Z";
    const binding: SessionBinding = {
      bindingId: "sb_pm_01",
      ownerId: "pm",
      transport: "sessions_spawn",
      sessionKey: "agent:pm:subagent:123",
      threadId: "channel:thread:abc",
      createdAt,
      lastUsedAt: createdAt,
      status: "active",
      stability: "owned_child_session",
    };

    await upsertSessionBinding(TEST_DIR, JOB_ID, binding);
    await upsertSessionBinding(TEST_DIR, JOB_ID, {
      ...binding,
      sessionKey: "agent:pm:subagent:456",
      lastUsedAt: "2026-03-16T18:11:00.000Z",
    });

    const loaded = await loadSessionBindings(TEST_DIR);
    assert.ok(loaded);
    assert.equal(loaded!.bindings.pm.sessionKey, "agent:pm:subagent:456");
    assert.equal(loaded!.bindings.pm.bindingId, "sb_pm_01");
  });

  it("persists interactions and lists only open ones", async () => {
    const baseInteraction: Omit<PlanInteraction, "schemaVersion" | "jobId" | "phase" | "createdAt" | "updatedAt"> = {
      interactionId: "pi_001",
      kind: "approach_decision",
      status: "awaiting_response",
      owner: { kind: "agent", id: "pm" },
      routing: {
        transport: "direct_session",
        targetAgentId: "pm",
        sessionBindingId: "sb_pm_01",
        threadId: "channel:thread:abc",
      },
      request: {
        title: "Choose implementation approach",
        prompt: "Pick one",
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
        answerTemplate: "PM approved {{selectedOptionId}}",
        fallback: {
          mode: "rerun_with_feedback",
          feedbackTemplate: "PM approved {{selectedOptionId}}",
        },
      },
      timeouts: {
        softSeconds: 1800,
        hardSeconds: 3600,
      },
    };

    await saveInteraction(
      TEST_DIR,
      createInteraction(JOB_ID, {
        ...baseInteraction,
        createdAt: "2026-03-16T18:05:10.000Z",
      }),
    );
    await saveInteraction(
      TEST_DIR,
      createInteraction(JOB_ID, {
        ...baseInteraction,
        interactionId: "pi_002",
        status: "resolved",
        createdAt: "2026-03-16T18:06:10.000Z",
        updatedAt: "2026-03-16T18:07:10.000Z",
      }),
    );

    const loaded = await loadInteraction(TEST_DIR, "pi_001");
    const open = await listOpenInteractions(TEST_DIR);

    assert.ok(loaded);
    assert.equal(loaded!.request.title, "Choose implementation approach");
    assert.equal(open.length, 1);
    assert.equal(open[0].interactionId, "pi_001");
  });

  it("appends and reads back ordered plan events", async () => {
    const first = createPlanEvent(
      JOB_ID,
      "plan.run.started",
      { task: "Design routing" },
      {
        eventId: "pe_001",
        createdAt: "2026-03-16T18:00:00.000Z",
      },
    );
    const second = createPlanEvent(
      JOB_ID,
      "plan.interaction.requested",
      { interactionId: "pi_001" },
      {
        eventId: "pe_002",
        createdAt: "2026-03-16T18:01:00.000Z",
      },
    );

    const firstPath = await appendPlanEvent(TEST_DIR, first);
    await appendPlanEvent(TEST_DIR, second);

    const events = await listPlanEvents(TEST_DIR);

    assert.ok(fs.existsSync(firstPath));
    assert.equal(path.basename(firstPath).includes("plan.run.started"), true);
    assert.equal(events.length, 2);
    assert.equal(events[0].eventId, "pe_001");
    assert.equal(events[1].eventType, "plan.interaction.requested");
  });
});

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  createInteraction,
  createSessionBindingsFile,
  initializePlanFeedbackJob,
  listPlanEvents,
  loadInteraction,
  saveInteraction,
  saveSessionBindings,
} from "../src/plan-feedback.ts";
import { routePlanInteraction } from "../src/plan-feedback-routing.ts";

const TEST_DIR = "/tmp/openagent-test-plan-feedback-routing";
const JOB_ID = "2026-03-16-routing-test";

describe("plan-feedback routing", () => {
  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("reuses an existing direct-session binding for PM interactions", async () => {
    await initializePlanFeedbackJob(TEST_DIR, JOB_ID);
    await saveSessionBindings(TEST_DIR, {
      ...createSessionBindingsFile(JOB_ID),
      bindings: {
        pm: {
          bindingId: "sb_pm_01",
          ownerId: "pm",
          transport: "sessions_spawn",
          sessionKey: "agent:pm:subagent:123",
          threadId: "thread:pm",
          createdAt: "2026-03-16T18:00:00.000Z",
          lastUsedAt: "2026-03-16T18:00:00.000Z",
          status: "active",
          stability: "owned_child_session",
        },
      },
    });
    await saveInteraction(
      TEST_DIR,
      createInteraction(JOB_ID, {
        interactionId: "pi_direct",
        kind: "approach_decision",
        status: "requested",
        owner: { kind: "agent", id: "pm" },
        routing: {
          transport: "direct_session",
          targetAgentId: "pm",
        },
        request: { title: "Choose implementation approach" },
        response: null,
        resolution: null,
        resume: { mode: "sdk_resume", target: "openagent.plan", sdkSessionId: "sess_123" },
        timeouts: { softSeconds: 1800, hardSeconds: 3600 },
      }),
    );

    const routed = await routePlanInteraction(TEST_DIR, "pi_direct");
    const interaction = await loadInteraction(TEST_DIR, "pi_direct");
    const events = await listPlanEvents(TEST_DIR);

    assert.equal(routed.action, "send_direct_session");
    assert.equal(routed.target, "pm");
    assert.ok(interaction);
    assert.equal(interaction!.routing.sessionBindingId, "sb_pm_01");
    assert.equal(interaction!.routing.threadId, "thread:pm");
    assert.equal(events.some((event) => event.eventType === "plan.session.rebound"), true);
    assert.equal(events.some((event) => event.eventType === "plan.interaction.routed"), true);
  });

  it("creates a routing handle for advisory bulletins", async () => {
    await initializePlanFeedbackJob(TEST_DIR, JOB_ID);
    await saveInteraction(
      TEST_DIR,
      createInteraction(JOB_ID, {
        interactionId: "pi_bulletin",
        kind: "clarify_advisory",
        status: "requested",
        owner: { kind: "system", id: "advisory" },
        routing: {
          transport: "bulletin",
        },
        request: { title: "Request advisory input" },
        response: null,
        resolution: null,
        resume: { mode: "sdk_resume", target: "openagent.plan", sdkSessionId: "sess_123" },
        timeouts: { softSeconds: 180, hardSeconds: 600 },
      }),
    );

    const routed = await routePlanInteraction(TEST_DIR, "pi_bulletin");
    const interaction = await loadInteraction(TEST_DIR, "pi_bulletin");

    assert.equal(routed.action, "create_bulletin");
    assert.ok(interaction?.routing.bulletinId);
    assert.match(interaction!.routing.bulletinId!, /^blt-/);
  });

  it("uses provided thread metadata for human review gates", async () => {
    await initializePlanFeedbackJob(TEST_DIR, JOB_ID);
    await saveInteraction(
      TEST_DIR,
      createInteraction(JOB_ID, {
        interactionId: "pi_human",
        kind: "spec_user_review",
        status: "requested",
        owner: { kind: "human", id: "user" },
        routing: {
          transport: "discord_thread",
        },
        request: { title: "Review plan spec" },
        response: null,
        resolution: null,
        resume: { mode: "sdk_resume", target: "openagent.plan", sdkSessionId: "sess_123" },
        timeouts: { softSeconds: 86400, hardSeconds: 172800 },
      }),
    );

    const routed = await routePlanInteraction(TEST_DIR, "pi_human", {
      threadId: "discord:thread:abc",
      discordMessageId: "discord-message-123",
    });
    const interaction = await loadInteraction(TEST_DIR, "pi_human");

    assert.equal(routed.action, "post_discord_gate");
    assert.equal(interaction?.routing.threadId, "discord:thread:abc");
    assert.equal(interaction?.routing.discordMessageId, "discord-message-123");
  });

  it("invalidates stale bindings instead of reusing them", async () => {
    await initializePlanFeedbackJob(TEST_DIR, JOB_ID);
    await saveSessionBindings(TEST_DIR, {
      ...createSessionBindingsFile(JOB_ID),
      bindings: {
        pm: {
          bindingId: "sb_pm_stale",
          ownerId: "pm",
          transport: "sessions_spawn",
          sessionKey: "agent:pm:subagent:stale",
          threadId: "thread:stale",
          createdAt: "2026-03-16T18:00:00.000Z",
          lastUsedAt: "2026-03-16T18:00:00.000Z",
          status: "stale",
          stability: "owned_child_session",
        },
      },
    });
    await saveInteraction(
      TEST_DIR,
      createInteraction(JOB_ID, {
        interactionId: "pi_stale",
        kind: "clarify_product",
        status: "requested",
        owner: { kind: "agent", id: "pm" },
        routing: {
          transport: "direct_session",
          targetAgentId: "pm",
        },
        request: { title: "Clarify product requirement" },
        response: null,
        resolution: null,
        resume: { mode: "sdk_resume", target: "openagent.plan", sdkSessionId: "sess_123" },
        timeouts: { softSeconds: 900, hardSeconds: 3600 },
      }),
    );

    const routed = await routePlanInteraction(TEST_DIR, "pi_stale");
    const interaction = await loadInteraction(TEST_DIR, "pi_stale");
    const events = await listPlanEvents(TEST_DIR);

    assert.equal(routed.action, "establish_direct_session");
    assert.equal(interaction?.routing.sessionBindingId ?? null, null);
    assert.equal(events.some((event) => event.eventType === "plan.session.invalidated"), true);
    assert.equal(events.some((event) => event.eventType === "plan.session.rebound"), false);
  });
});

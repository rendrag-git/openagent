import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  createOpenAgentRuntimeAdapter,
  type OpenAgentRuntimeHandle,
} from "../src/acp-runtime.ts";
import { loadInteraction, listPlanEvents } from "../src/plan-feedback.ts";
import { parkSession } from "../src/feedback.ts";
import { ParkSession } from "../src/session.ts";
import type { TaskResult } from "../src/types.ts";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function successResult(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    success: true,
    output: "ok",
    filesChanged: [],
    questions: [],
    sessionId: "sess_success",
    stopReason: "end_turn",
    costUsd: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 1,
    },
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("openagent ACP runtime adapter", () => {
  it("parks structured planner questions and persists plan interaction artifacts", async () => {
    const jobDir = await makeTempDir("openagent-acp-plan-");
    const handle: OpenAgentRuntimeHandle = {
      sessionKey: "agent:orchestrator:acp:plan-1",
      worker: "plan",
      cwd: jobDir,
      jobDir,
      jobId: "job_plan_1",
    };

    const adapter = createOpenAgentRuntimeAdapter({
      workers: {
        plan: async ({ canUseTool }) => {
          try {
            await canUseTool?.(
              "AskUserQuestion",
              {
                questions: [
                  {
                    question:
                      'OPENAGENT_PLAN_INTERACTION: {"kind":"approach_decision","title":"Storage choice","prompt":"Where should metadata live?","currentStep":"Design","options":[{"id":"a","label":"Git","summary":"Store metadata in git."}]}',
                  },
                ],
              },
              { signal: new AbortController().signal, toolUseID: "tool_plan_1" },
            );
            throw new Error("expected AskUserQuestion to park");
          } catch (error) {
            if (error instanceof ParkSession) {
              error.sessionId = "sess_plan_parked";
            }
            throw error;
          }
        },
      },
    });

    const result = await adapter.runTurn({
      handle,
      text: "Produce a plan",
    });

    assert.equal(result.state, "parked");
    assert.equal(result.result.stopReason, "parked");
    assert.equal(result.runtimeLinkage.agentSessionId, "sess_plan_parked");
    assert.equal(result.question?.text, "Storage choice");

    const interaction = await loadInteraction(jobDir, String(result.question?.id));
    assert.ok(interaction);
    assert.equal(interaction?.kind, "approach_decision");
    assert.equal(interaction?.routing.transport, "direct_session");
    assert.equal(interaction?.routing.targetAgentId, "pm");

    const eventTypes = (await listPlanEvents(jobDir)).map((event) => event.eventType);
    assert.ok(eventTypes.includes("plan.interaction.requested"));
    assert.ok(eventTypes.includes("plan.interaction.routed"));
  });

  it("rebuilds orchestrator question routing when resuming a parked worker turn", async () => {
    const parkedDir = await makeTempDir("openagent-acp-resume-");
    const sessionId = "sess_resume_1";
    await parkSession(
      {
        sessionId,
        question: {
          id: "q_initial",
          text: "Initial question",
          timestamp: "2026-03-18T12:00:00.000Z",
          answered: false,
        },
        originalFrom: "execute",
        threadId: parkedDir,
        jobId: "job_resume_1",
        taskContext: {
          cwd: parkedDir,
        },
        createdAt: "2026-03-18T12:00:00.000Z",
      },
      parkedDir,
    );

    const adapter = createOpenAgentRuntimeAdapter({
      parkedSessionDir: parkedDir,
      runSession: async (input) => {
        assert.equal(input.resume, sessionId);
        assert.equal(input.resumeAnswer, "Use the staging environment.");
        assert.equal(typeof input.canUseTool, "function");

        try {
          await input.canUseTool?.(
            "AskUserQuestion",
            {
              questions: [{ question: "Should I also run the smoke test suite?" }],
            },
            { signal: new AbortController().signal, toolUseID: "tool_resume_1" },
          );
          throw new Error("expected resumed AskUserQuestion to park");
        } catch (error) {
          if (error instanceof ParkSession) {
            throw new ParkSession(error.question, sessionId, error.metadata);
          }
          throw error;
        }
      },
    });

    const result = await adapter.resumeTurn({
      sessionId,
      answer: "Use the staging environment.",
    });

    assert.equal(result.state, "parked");
    assert.equal(result.runtimeLinkage.agentSessionId, sessionId);
    assert.equal(result.question?.text, "Should I also run the smoke test suite?");
  });

  it("reports parked session status for orchestrator linkage", async () => {
    const parkedDir = await makeTempDir("openagent-acp-status-");
    await parkSession(
      {
        sessionId: "sess_status_1",
        question: {
          id: "q_status",
          text: "Need approval",
          timestamp: "2026-03-18T12:00:00.000Z",
          answered: false,
        },
        originalFrom: "check",
        threadId: "/tmp/job-status",
        jobId: "job_status_1",
        taskContext: {
          cwd: "/tmp/worktree-status",
        },
        createdAt: "2026-03-18T12:00:00.000Z",
      },
      parkedDir,
    );

    const adapter = createOpenAgentRuntimeAdapter({
      parkedSessionDir: parkedDir,
    });

    const status = await adapter.getSessionStatus("sess_status_1");

    assert.deepEqual(status, {
      state: "parked",
      summary: "check waiting for orchestrator feedback: Need approval",
      sessionId: "sess_status_1",
      worker: "check",
      jobId: "job_status_1",
      jobDir: "/tmp/job-status",
      question: {
        id: "q_status",
        text: "Need approval",
        timestamp: "2026-03-18T12:00:00.000Z",
        answered: false,
      },
    });
  });

  it("returns completed turn results for successful worker runs", async () => {
    const adapter = createOpenAgentRuntimeAdapter({
      workers: {
        execute: async ({ task, cwd }) =>
          successResult({
            output: `executed:${task}:${cwd}`,
            sessionId: "sess_execute_1",
          }),
      },
    });

    const result = await adapter.runTurn({
      handle: {
        sessionKey: "agent:orchestrator:acp:execute-1",
        worker: "execute",
        cwd: "/tmp/repo",
      },
      text: "Apply the approved patch",
    });

    assert.equal(result.state, "completed");
    assert.equal(result.summary, "execute completed");
    assert.equal(result.result.output, "executed:Apply the approved patch:/tmp/repo");
    assert.equal(result.runtimeLinkage.sessionKey, "agent:orchestrator:acp:execute-1");
    assert.equal(result.runtimeLinkage.agentSessionId, "sess_execute_1");
  });
});

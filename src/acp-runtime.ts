import { createCanUseTool } from "./can-use-tool.ts";
import {
  appendPlanEvent,
  createPlanEvent,
  initializePlanFeedbackJob,
  loadInteraction,
  loadPlanState,
  saveInteraction,
  savePlanState,
  type PlanState,
} from "./plan-feedback.ts";
import {
  getWorkflowStatusForInteraction,
  resolvePlanInteractionInput,
} from "./plan-feedback-interactions.ts";
import { routePlanInteraction } from "./plan-feedback-routing.ts";
import {
  completeInteractionResolution,
  markResumeFailure,
  recordInteractionAnswer,
} from "./plan-feedback-resume.ts";
import { loadParkedSession, parkSession, removeParkedSession } from "./feedback.ts";
import {
  createOrchestratorQuestionHandler,
  formatParkedQuestionOutput,
} from "./orchestrator-questions.ts";
import { runSession } from "./run-session.ts";
import { ParkSession } from "./session.ts";
import type { Question, TaskResult } from "./types.ts";
import { act } from "./workers/act.ts";
import { check } from "./workers/check.ts";
import { execute } from "./workers/execute.ts";
import { plan } from "./workers/plan.ts";

export type OpenAgentWorkerName = "plan" | "execute" | "check" | "act";

export interface OpenAgentRuntimeHandle {
  sessionKey: string;
  worker: OpenAgentWorkerName;
  cwd: string;
  jobDir?: string;
  jobId?: string;
  context?: string;
}

export interface OpenAgentRuntimeLinkage {
  backend: "openagent";
  sessionKey: string;
  agentSessionId?: string;
}

export interface OpenAgentRuntimeTurnResult {
  state: "completed" | "parked" | "failed";
  summary: string;
  result: TaskResult;
  runtimeLinkage: OpenAgentRuntimeLinkage;
  question?: Question;
}

export interface OpenAgentRuntimeSessionStatus {
  state: "parked" | "not_found";
  summary: string;
  sessionId: string;
  worker?: string;
  jobId?: string;
  jobDir?: string;
  question?: Question;
}

export interface OpenAgentRuntimeTurnInput {
  handle: OpenAgentRuntimeHandle;
  text: string;
}

export interface OpenAgentRuntimeResumeInput {
  sessionId: string;
  answer: string;
}

type RuntimeCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; toolUseID: string; [key: string]: unknown },
) => Promise<{ behavior: "allow" | "deny"; updatedInput?: Record<string, unknown>; message?: string }>;

type OpenAgentWorkerRunner = (input: {
  task: string;
  cwd: string;
  context?: string;
  canUseTool?: RuntimeCanUseTool;
}) => Promise<TaskResult>;

type ResumeSessionRunner = typeof runSession;

export interface OpenAgentRuntimeAdapterDeps {
  workers?: Partial<Record<OpenAgentWorkerName, OpenAgentWorkerRunner>>;
  runSession?: ResumeSessionRunner;
  parkedSessionDir?: string;
}

export interface OpenAgentRuntimeAdapter {
  ensureSession(input: OpenAgentRuntimeHandle): OpenAgentRuntimeHandle;
  runTurn(input: OpenAgentRuntimeTurnInput): Promise<OpenAgentRuntimeTurnResult>;
  resumeTurn(input: OpenAgentRuntimeResumeInput): Promise<OpenAgentRuntimeTurnResult>;
  getSessionStatus(sessionId: string): Promise<OpenAgentRuntimeSessionStatus>;
}

const DEFAULT_WORKERS: Record<OpenAgentWorkerName, OpenAgentWorkerRunner> = {
  plan: ({ task, cwd, context, canUseTool }) => plan({ task, cwd, context, canUseTool }),
  execute: ({ task, cwd, context, canUseTool }) =>
    execute({ plan: task, cwd, context, includeDiff: true, canUseTool }),
  check: ({ task, cwd, context, canUseTool }) => check({ task, cwd, context, canUseTool }),
  act: ({ task, cwd, context, canUseTool }) =>
    act({ issues: task, cwd, context, includeDiff: true, canUseTool }),
};

export function createOpenAgentRuntimeAdapter(
  deps: OpenAgentRuntimeAdapterDeps = {},
): OpenAgentRuntimeAdapter {
  const workers = {
    ...DEFAULT_WORKERS,
    ...(deps.workers ?? {}),
  };
  const runSessionImpl = deps.runSession ?? runSession;
  const parkedSessionDir = deps.parkedSessionDir;

  return {
    ensureSession(input: OpenAgentRuntimeHandle): OpenAgentRuntimeHandle {
      return normalizeHandle(input);
    },

    async runTurn(input: OpenAgentRuntimeTurnInput): Promise<OpenAgentRuntimeTurnResult> {
      const handle = normalizeHandle(input.handle);
      const canUseTool = createRuntimeCanUseTool(handle);

      try {
        const result = await workers[handle.worker]({
          task: input.text,
          cwd: handle.cwd,
          context: handle.context,
          canUseTool,
        });
        return completedTurnResult(handle, result);
      } catch (error) {
        if (error instanceof ParkSession) {
          return await parkedTurnResult(error, handle, parkedSessionDir);
        }
        return failedTurnResult(handle, error);
      }
    },

    async resumeTurn(input: OpenAgentRuntimeResumeInput): Promise<OpenAgentRuntimeTurnResult> {
      const parked = await loadParkedSession(input.sessionId, parkedSessionDir);
      if (!parked) {
        throw new Error(`Unknown parked session: ${input.sessionId}`);
      }

      const handle = normalizeHandle({
        sessionKey: parked.sessionId,
        worker: normalizeWorkerName(parked.originalFrom),
        cwd: parked.taskContext.cwd,
        jobDir: parked.threadId,
        jobId: parked.jobId,
      });

      if (parked.threadId && parked.interactionId) {
        await recordInteractionAnswer(parked.threadId, parked.interactionId, input.answer, {
          kind: "agent",
          id: "orchestrator",
        });
      }

      try {
        const result = await runSessionImpl({
          prompt: input.answer,
          cwd: parked.taskContext.cwd,
          resume: input.sessionId,
          resumeAnswer: input.answer,
          canUseTool: createRuntimeCanUseTool(handle),
        });

        if (parked.threadId && parked.interactionId) {
          await completeInteractionResolution(parked.threadId, parked.interactionId);
        }
        await removeParkedSession(input.sessionId, parkedSessionDir);
        return completedTurnResult(handle, result);
      } catch (error) {
        if (error instanceof ParkSession) {
          return await parkedTurnResult(error, handle, parkedSessionDir);
        }
        if (parked.threadId && parked.interactionId && error instanceof Error) {
          await markResumeFailure(parked.threadId, parked.interactionId, error, false);
        }
        return failedTurnResult(handle, error);
      }
    },

    async getSessionStatus(sessionId: string): Promise<OpenAgentRuntimeSessionStatus> {
      const parked = await loadParkedSession(sessionId, parkedSessionDir);
      if (!parked) {
        return {
          state: "not_found",
          summary: `No parked openagent session found for ${sessionId}`,
          sessionId,
        };
      }

      return {
        state: "parked",
        summary: `${parked.originalFrom} waiting for orchestrator feedback: ${parked.question.text}`,
        sessionId,
        worker: parked.originalFrom,
        jobId: parked.jobId,
        jobDir: parked.threadId,
        question: parked.question,
      };
    },
  };
}

function normalizeHandle(input: OpenAgentRuntimeHandle): OpenAgentRuntimeHandle {
  const sessionKey = input.sessionKey?.trim();
  const cwd = input.cwd?.trim();
  if (!sessionKey) {
    throw new Error("OpenAgent runtime sessionKey is required.");
  }
  if (!cwd) {
    throw new Error("OpenAgent runtime cwd is required.");
  }

  return {
    ...input,
    sessionKey,
    worker: normalizeWorkerName(input.worker),
    cwd,
    jobDir: input.jobDir?.trim() || undefined,
    jobId: input.jobId?.trim() || undefined,
    context: input.context,
  };
}

function normalizeWorkerName(worker: string): OpenAgentWorkerName {
  if (worker === "plan" || worker === "execute" || worker === "check" || worker === "act") {
    return worker;
  }
  throw new Error(`Unsupported openagent worker: ${worker}`);
}

function fallbackSessionId(handle: OpenAgentRuntimeHandle): string {
  return handle.sessionKey;
}

async function parkedTurnResult(
  err: ParkSession,
  handle: OpenAgentRuntimeHandle,
  parkedSessionDir?: string,
): Promise<OpenAgentRuntimeTurnResult> {
  const sessionId = err.sessionId || fallbackSessionId(handle);
  const question = err.question;
  const persistedParkedSessionDir = parkedSessionDir ?? handle.jobDir;

  if (handle.jobDir) {
    await parkSession(
      {
        sessionId,
        question,
        originalFrom: handle.worker,
        threadId: handle.jobDir,
        jobId: handle.jobId,
        interactionId:
          typeof err.metadata?.interactionId === "string" ? err.metadata.interactionId : undefined,
        taskContext: {
          cwd: handle.cwd,
        },
        createdAt: new Date().toISOString(),
      },
      persistedParkedSessionDir,
    );
  }

  if (handle.worker === "plan" && handle.jobDir) {
    await markPlannerSessionParked(handle.jobDir, handle.jobId ?? defaultJobId(handle), sessionId, question);
  }

  const result: TaskResult = {
    success: false,
    output: formatParkedQuestionOutput(handle.worker, question.text),
    filesChanged: [],
    questions: [question],
    sessionId,
    stopReason: "parked",
    parkedQuestion: question,
    costUsd: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
    },
  };

  return {
    state: "parked",
    summary: `${handle.worker} parked for orchestrator feedback`,
    result,
    runtimeLinkage: {
      backend: "openagent",
      sessionKey: handle.sessionKey,
      agentSessionId: sessionId,
    },
    question,
  };
}

function completedTurnResult(
  handle: OpenAgentRuntimeHandle,
  result: TaskResult,
): OpenAgentRuntimeTurnResult {
  return {
    state: "completed",
    summary: `${handle.worker} completed`,
    result,
    runtimeLinkage: {
      backend: "openagent",
      sessionKey: handle.sessionKey,
      agentSessionId: result.sessionId || undefined,
    },
  };
}

function failedTurnResult(
  handle: OpenAgentRuntimeHandle,
  error: unknown,
): OpenAgentRuntimeTurnResult {
  const output = error instanceof Error ? error.message : String(error);
  return {
    state: "failed",
    summary: `${handle.worker} failed`,
    result: {
      success: false,
      output,
      filesChanged: [],
      questions: [],
      sessionId: "",
      stopReason: "error",
      costUsd: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
      },
    },
    runtimeLinkage: {
      backend: "openagent",
      sessionKey: handle.sessionKey,
    },
  };
}

function createRuntimeCanUseTool(handle: OpenAgentRuntimeHandle): RuntimeCanUseTool | undefined {
  if (handle.worker === "plan") {
    return createCanUseTool({
      onAskUserQuestion: async (input) => {
        return await persistPlanInteractionForOrchestrator(handle, input);
      },
    });
  }

  if (handle.worker === "check") {
    return createCanUseTool({
      deny: ["Write", "Edit"],
      onAskUserQuestion: createOrchestratorQuestionHandler(handle.worker, handle.jobDir),
    });
  }

  return createCanUseTool({
    onAskUserQuestion: createOrchestratorQuestionHandler(handle.worker, handle.jobDir),
  });
}

async function persistPlanInteractionForOrchestrator(
  handle: OpenAgentRuntimeHandle,
  input: Record<string, unknown>,
): Promise<string[] | never> {
  if (!handle.jobDir) {
    throw new Error("Plan worker requires a job directory to route AskUserQuestion through the orchestrator.");
  }

  const jobId = handle.jobId ?? defaultJobId(handle);
  const parsed = resolvePlanInteractionInput(input, jobId);
  if (!parsed) {
    throw new Error("Plan worker AskUserQuestion must include a non-empty question.");
  }

  await initializePlanFeedbackJob(handle.jobDir, jobId, {
    status: "running_planner",
  });
  await saveInteraction(handle.jobDir, parsed.interaction);

  const state = (await loadPlanState(handle.jobDir)) ?? await initializePlanFeedbackJob(handle.jobDir, jobId);
  const updated: PlanState = {
    ...state,
    status: getWorkflowStatusForInteraction(parsed.interaction.kind, parsed.interaction.owner),
    activeInteractionId: parsed.interaction.interactionId,
    activeOwner: parsed.interaction.owner,
    currentStep: parsed.currentStep,
    updatedAt: new Date().toISOString(),
  };
  await savePlanState(handle.jobDir, updated);

  await appendPlanEvent(
    handle.jobDir,
    createPlanEvent(jobId, "plan.interaction.requested", {
      interaction: {
        interactionId: parsed.interaction.interactionId,
        kind: parsed.interaction.kind,
        owner: parsed.interaction.owner,
        request: parsed.interaction.request,
        resume: parsed.interaction.resume,
      },
    }),
  );

  await routePlanInteraction(handle.jobDir, parsed.interaction.interactionId, {
    threadId: handle.jobDir,
  });

  throw new ParkSession(
    {
      id: parsed.interaction.interactionId,
      text: parsed.interaction.request.title,
      timestamp: new Date().toISOString(),
      answered: false,
    },
    "",
    {
      interactionId: parsed.interaction.interactionId,
      routing: parsed.interaction.routing,
      kind: parsed.interaction.kind,
    },
  );
}

async function markPlannerSessionParked(
  jobDir: string,
  jobId: string,
  sessionId: string,
  question: Question,
): Promise<void> {
  const state = await loadPlanState(jobDir);
  if (!state) {
    return;
  }

  if (state.activeInteractionId) {
    const interaction = await loadInteraction(jobDir, state.activeInteractionId);
    if (interaction && !interaction.resume.sdkSessionId) {
      interaction.resume.sdkSessionId = sessionId;
      interaction.updatedAt = new Date().toISOString();
      await saveInteraction(jobDir, interaction);
    }
  }

  const updated: PlanState = {
    ...state,
    status: "routing_interaction",
    currentStep: {
      kind: "waiting_for_feedback",
      label: question.text,
    },
    planner: {
      ...state.planner,
      sdkSessionId: sessionId,
      sdkSessionStatus: "parked",
    },
    updatedAt: new Date().toISOString(),
  };
  await savePlanState(jobDir, updated);

  await appendPlanEvent(
    jobDir,
    createPlanEvent(jobId, "plan.session.parked", {
      planner: {
        sdkSessionId: sessionId,
        sdkSessionStatus: "parked",
        resumeStrategy: updated.planner.resumeStrategy,
      },
      interactionId: updated.activeInteractionId,
    }),
  );
}

function defaultJobId(handle: OpenAgentRuntimeHandle): string {
  return handle.jobDir?.split("/").pop() ?? handle.sessionKey;
}

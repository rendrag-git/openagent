import fs from "node:fs";
import path from "node:path";
import { execSync as execSyncChild } from "node:child_process";
import { execSync as execSyncBulletin } from "node:child_process";
import { plan, execute, check, act } from "../src/index.ts";
import {
  buildFeedbackContext,
  createPhaseEnvelope,
  loadContext as loadChainedContext,
  loadPhaseOutput,
} from "../src/context-chain.ts";
import { parkSession } from "../src/feedback.ts";
import { createCanUseTool } from "../src/can-use-tool.ts";
import type { TaskResult } from "../src/types.ts";
import {
  appendPlanEvent,
  createPlanEvent,
  initializePlanFeedbackJob,
  loadInteraction,
  loadPlanState,
  saveInteraction,
  savePlanState,
  type PlanState,
} from "../src/plan-feedback.ts";
import { dispatchPlanInteraction } from "../src/plan-feedback-dispatch.ts";
import {
  getWorkflowStatusForInteraction,
  parseStructuredPlanInteraction,
} from "../src/plan-feedback-interactions.ts";
import { routePlanInteraction } from "../src/plan-feedback-routing.ts";
import {
  completeInteractionResolution,
  markResumeFailure,
  recordInteractionAnswer,
} from "../src/plan-feedback-resume.ts";
import { ParkSession } from "../src/session.ts";

// --- Parse args ---

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const worker = args.worker;
const task = args.task;
const cwd = args.cwd;
const jobDir = args["job-dir"];
const feedback = args.feedback;
const dryRun = process.argv.includes("--dry-run");

if (!worker || !task || !cwd) {
  console.error("Usage: openagent-run --worker <plan|execute|check|act|classify|resume> --task <task> --cwd <cwd> [--job-dir <dir>] [--feedback <text>] [--dry-run]");
  process.exit(1);
}

// --- Write helper: skips actual writes in dry-run mode ---

function writeResult(filePath: string, content: string): void {
  if (dryRun) {
    console.error(`[dry-run] Would write to ${filePath}:`);
    console.error(content);
    return;
  }
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content);
}

function isPhaseWorker(workerName: string): workerName is keyof typeof WORKERS {
  return workerName in WORKERS;
}

function buildWorkerContext(
  workerName: string,
  jobDir: string | undefined,
  feedbackText: string | undefined,
): { baseContext?: string; effectiveContext?: string } {
  const baseContext = jobDir ? loadChainedContext(jobDir, workerName) : undefined;
  if (!feedbackText) {
    return { baseContext, effectiveContext: baseContext };
  }

  const priorOutput = jobDir ? loadPhaseOutput(jobDir, workerName) : undefined;
  const feedbackContext = buildFeedbackContext(workerName, priorOutput, feedbackText);
  return {
    baseContext,
    effectiveContext: baseContext ? `${baseContext}\n\n${feedbackContext}` : feedbackContext,
  };
}

function serializeWorkerResult(
  workerName: string,
  task: string,
  baseContext: string | undefined,
  feedbackText: string | undefined,
  result: TaskResult,
): string {
  if (!isPhaseWorker(workerName)) {
    return JSON.stringify(result, null, 2);
  }

  return JSON.stringify(
    createPhaseEnvelope(task, baseContext, feedbackText, result),
    null,
    2,
  );
}

function getJobId(jobDir: string | undefined, workerName: string): string {
  return jobDir?.split("/").pop() ?? `${workerName}-${Date.now()}`;
}

async function initializePlanRunState(
  jobDir: string,
  jobId: string,
  runTask: string,
  runCwd: string,
): Promise<void> {
  await initializePlanFeedbackJob(jobDir, jobId, {
    status: "running_planner",
  });

  const state = await loadPlanState(jobDir);
  if (!state) return;

  const updated: PlanState = {
    ...state,
    status: "running_planner",
    currentStep: {
      kind: "plan_run",
      label: "Planner run started",
    },
    planner: {
      ...state.planner,
      sdkSessionStatus: "active",
    },
    updatedAt: new Date().toISOString(),
  };
  await savePlanState(jobDir, updated);

  await appendPlanEvent(
    jobDir,
    createPlanEvent(jobId, "plan.run.started", {
      worker: "plan",
      task: runTask,
      cwd: runCwd,
    }),
  );
}

async function finalizePlanRunState(
  jobDir: string,
  jobId: string,
  result: TaskResult,
  resultPath: string = "plan.json",
): Promise<void> {
  const state = (await loadPlanState(jobDir)) ?? await initializePlanFeedbackJob(jobDir, jobId);
  const plannerStatus =
    result.stopReason === "parked"
      ? "parked"
      : result.stopReason === "end_turn"
        ? "completed"
        : "failed";

  const nextStatus =
    result.stopReason === "parked"
      ? "routing_interaction"
      : result.success
        ? "plan_complete"
        : "failed";

  const updated: PlanState = {
    ...state,
    status: nextStatus,
    currentStep: result.stopReason === "parked"
      ? {
          kind: "waiting_for_feedback",
          label: result.parkedQuestion?.text ?? "Planner waiting for feedback",
        }
      : {
          kind: "plan_result",
          label: result.success ? "Planner completed" : "Planner failed",
        },
    planner: {
      ...state.planner,
      sdkSessionId: result.sessionId || state.planner.sdkSessionId,
      sdkSessionStatus: plannerStatus,
      lastPlannerResultPath: resultPath,
    },
    updatedAt: new Date().toISOString(),
  };

  if (result.stopReason === "parked" && updated.activeInteractionId) {
    const interaction = await loadInteraction(jobDir, updated.activeInteractionId);
    if (interaction && !interaction.resume.sdkSessionId) {
      interaction.resume.sdkSessionId = result.sessionId;
      interaction.updatedAt = new Date().toISOString();
      await saveInteraction(jobDir, interaction);
    }
  }

  await savePlanState(jobDir, updated);

  await appendPlanEvent(
    jobDir,
    createPlanEvent(jobId, "plan.run.completed", {
      worker: "plan",
      success: result.success,
      stopReason: result.stopReason,
      sessionId: result.sessionId,
    }),
  );

  if (result.stopReason === "parked") {
    await appendPlanEvent(
      jobDir,
      createPlanEvent(jobId, "plan.session.parked", {
        planner: {
          sdkSessionId: result.sessionId,
          sdkSessionStatus: "parked",
          resumeStrategy: updated.planner.resumeStrategy,
        },
        interactionId: updated.activeInteractionId,
      }),
    );
  }

  if (result.success) {
    await appendPlanEvent(
      jobDir,
      createPlanEvent(jobId, "plan.completed", {
        worker: "plan",
        outputPath: resultPath,
      }),
    );
  }
}

async function buildParkedResult(
  err: ParkSession,
  workerName: string,
  cwd: string,
  jobDir?: string,
  jobId?: string,
): Promise<TaskResult> {
  const result: TaskResult = {
    success: false,
    output: `Planner parked for feedback: ${err.question.text}`,
    filesChanged: [],
    questions: [err.question],
    sessionId: err.sessionId,
    stopReason: "parked",
    parkedQuestion: err.question,
    costUsd: 0,
    usage: { inputTokens: 0, outputTokens: 0, durationMs: 0 },
  };

  if (jobDir) {
    await parkSession({
      sessionId: err.sessionId,
      question: err.question,
      originalFrom: workerName,
      threadId: jobDir,
      jobId,
      interactionId: typeof err.metadata?.interactionId === "string" ? err.metadata.interactionId : undefined,
      taskContext: { cwd },
      createdAt: new Date().toISOString(),
    });
  }

  return result;
}

// --- Run worker ---

const WORKERS: Record<string, (a: { task: string; cwd: string; context?: string; canUseTool?: (toolName: string, input: Record<string, unknown>, options: any) => Promise<any> }) => Promise<TaskResult>> = {
  plan: (a) => plan({ task: a.task, cwd: a.cwd, context: a.context, canUseTool: a.canUseTool }),
  execute: (a) => execute({ plan: a.task, cwd: a.cwd, context: a.context, includeDiff: true, canUseTool: a.canUseTool }),
  check: (a) => check({ task: a.task, cwd: a.cwd, context: a.context, canUseTool: a.canUseTool }),
  act: (a) => act({ issues: a.task, cwd: a.cwd, context: a.context, includeDiff: true, canUseTool: a.canUseTool }),
};

// --- Classify worker (Haiku domain classifier) ---

async function classifyQuestion(task: string, routingJson: string): Promise<{ routeKey: string }> {
  const { createSession } = await import("../src/index.ts");

  let routeKeys: string[];
  try {
    const routing = JSON.parse(routingJson);
    routeKeys = Object.keys(routing.routes ?? routing);
  } catch {
    return { routeKey: "default" };
  }

  const prompt =
    `Classify this question into exactly ONE of these categories: ${routeKeys.join(", ")}\n\n` +
    `Question: "${task}"\n\n` +
    `Reply with ONLY the category name, nothing else.`;

  try {
    const result = await createSession({
      prompt,
      cwd: "/tmp",
      overrides: {
        maxTurns: 1,
        allowedTools: [],
      },
      systemPrompt: "You are a classifier. Reply with exactly one word — the category name.",
    });

    const key = result.output.trim().toLowerCase().replace(/[^a-z_-]/g, "");
    return { routeKey: routeKeys.includes(key) ? key : "default" };
  } catch {
    return { routeKey: "default" };
  }
}

// --- Bulletin-integrated canUseTool for CLI ---

const ROUTING_TABLE_PATH = path.join(
  process.env.HOME ?? "/home/ubuntu",
  ".openclaw", "openagent", "question-routing.json",
);

const BULLETIN_DB_PATH = path.join(
  process.env.HOME ?? "/home/ubuntu",
  ".openclaw", "mailroom", "bulletins", "bulletins.db",
);

const BULLETIN_POST_CLI = path.join(
  process.env.HOME ?? "/home/ubuntu",
  ".openclaw", "bin", "bulletin-post",
);

function loadRoutingTable(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(ROUTING_TABLE_PATH, "utf-8"));
  } catch {
    return { routes: { default: ["dev"] }, alwaysSubscribe: ["pm"] };
  }
}

async function bulletinAskHandler(input: Record<string, unknown>): Promise<string[]> {
  const questions = (input as any).questions ?? [];
  const questionTexts: string[] = questions.map((q: any) => q.question ?? String(q));
  const questionText = questionTexts.join("\n");

  // 1. Classify domain
  const routingTable = loadRoutingTable();
  const routeResult = await classifyQuestion(questionText, JSON.stringify(routingTable));
  const routeKey = routeResult.routeKey;

  // 2. Look up subscribers
  const routes = (routingTable as any).routes ?? {};
  const alwaysSubscribe = (routingTable as any).alwaysSubscribe ?? [];
  const subscribers = [...new Set([...(routes[routeKey] ?? routes.default ?? ["dev"]), ...alwaysSubscribe])];

  // 3. Create bulletin
  const bulletinId = `blt-${args["job-dir"]?.split("/").pop() ?? "unknown"}-q${Date.now()}`;
  const body = [
    "**Question from openagent**",
    `**Phase:** ${worker}`,
    "",
    "---",
    "",
    questionText,
    "",
    "---",
    "",
    "Respond with your recommendation. Use bulletin_respond with align/partial/oppose.",
  ].join("\\n");

  try {
    execSyncBulletin(
      `${BULLETIN_POST_CLI} --topic "openagent: ${questionText.slice(0, 60).replace(/"/g, "'")}" ` +
      `--body "${body.replace(/"/g, '\\"')}" ` +
      `--subscribers "${subscribers.join(",")}" ` +
      `--protocol advisory ` +
      `--id "${bulletinId}" ` +
      `--timeout 3`,
      { encoding: "utf-8", timeout: 10000 },
    );
  } catch {
    return ["Unable to route question to agents. Please proceed with your best judgment."];
  }

  // 4. Poll for bulletin closure (10s intervals, max 3 minutes)
  let Database: any;
  try {
    Database = (await import("better-sqlite3")).default;
  } catch {
    return ["Unable to check bulletin responses. Proceed with best judgment."];
  }

  let db: any;
  try {
    db = new Database(BULLETIN_DB_PATH, { readonly: true });
  } catch {
    return ["Unable to check bulletin responses. Proceed with best judgment."];
  }

  try {
    for (let i = 0; i < 18; i++) {
      await new Promise((r) => setTimeout(r, 10000));
      const row = db.prepare("SELECT status, resolution FROM bulletins WHERE id = ?").get(bulletinId) as any;
      if (row?.status === "closed") break;
    }

    // 5. Read responses
    const responses = db.prepare(
      "SELECT agent_id, body, position, reservations FROM bulletin_responses WHERE bulletin_id = ? ORDER BY created_at"
    ).all(bulletinId) as any[];

    if (responses.length === 0) {
      return ["No agents responded. Proceed with your best judgment."];
    }

    // 6. Synthesize answers
    const synthesized = responses.map((r: any) => {
      const pos = r.position === "oppose" ? "OPPOSES" : r.position === "partial" ? "PARTIAL" : "AGREES";
      return `${r.agent_id} (${pos}): ${r.body}${r.reservations ? ` [reservations: ${r.reservations}]` : ""}`;
    }).join("\n\n");

    return [synthesized];
  } finally {
    db.close();
  }
}

const questionLog: Array<{ question: string; answers: string[]; timestamp: string }> = [];

async function persistStructuredPlanInteraction(
  input: Record<string, unknown>,
  workerName: string,
  jobDir: string,
  jobId: string,
): Promise<string[] | never> {
  const parsed = parseStructuredPlanInteraction(input, jobId);
  if (!parsed) {
    throw new Error("Expected a structured plan interaction but could not parse the request.");
  }

  await saveInteraction(jobDir, parsed.interaction);

  const state = (await loadPlanState(jobDir)) ?? await initializePlanFeedbackJob(jobDir, jobId);
  const updated: PlanState = {
    ...state,
    status: getWorkflowStatusForInteraction(parsed.interaction.kind, parsed.interaction.owner),
    activeInteractionId: parsed.interaction.interactionId,
    activeOwner: parsed.interaction.owner,
    currentStep: parsed.currentStep,
    updatedAt: new Date().toISOString(),
  };
  await savePlanState(jobDir, updated);

  await appendPlanEvent(
    jobDir,
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

  await routePlanInteraction(jobDir, parsed.interaction.interactionId, {
    threadId: jobDir,
  });

  const dispatchResult = await dispatchPlanInteraction(jobDir, parsed.interaction.interactionId, {
    classifyQuestion,
    loadRoutingTable,
    bulletinPostCli: BULLETIN_POST_CLI,
  });

  if (dispatchResult.deliveryState === "failed") {
    const interaction = await loadInteraction(jobDir, parsed.interaction.interactionId);
    if (interaction) {
      interaction.status = "timed_out";
      interaction.updatedAt = new Date().toISOString();
      await saveInteraction(jobDir, interaction);
    }

    const failedState = await loadPlanState(jobDir);
    if (failedState) {
      failedState.activeInteractionId = null;
      failedState.activeOwner = null;
      failedState.status = "running_planner";
      failedState.currentStep = {
        kind: "dispatch_failed",
        label: "Interaction dispatch failed; continuing inline",
      };
      failedState.updatedAt = new Date().toISOString();
      await savePlanState(jobDir, failedState);
    }

    await appendPlanEvent(
      jobDir,
      createPlanEvent(jobId, "plan.interaction.timed_out", {
        interactionId: parsed.interaction.interactionId,
        reason: "dispatch_failed",
        dispatchId: dispatchResult.artifact.dispatchId,
      }),
    );

    return [dispatchResult.fallbackAnswer ?? "Feedback routing failed. Proceed with your best judgment."];
  }

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

function buildCanUseTool(
  workerName: string,
  context: { jobDir?: string; jobId: string },
): ((toolName: string, input: Record<string, unknown>, options: any) => Promise<any>) | undefined {
  if (workerName === "plan") {
    return createCanUseTool({
      onAskUserQuestion: async (input) => {
        if (context.jobDir) {
          const parsed = parseStructuredPlanInteraction(input, context.jobId);
          if (parsed) {
            return persistStructuredPlanInteraction(input, workerName, context.jobDir, context.jobId);
          }
        }

        return bulletinAskHandler(input);
      },
      questionLog,
    });
  }

  if (workerName === "check") {
    return createCanUseTool({
      deny: ["Write", "Edit"],
      onAskUserQuestion: bulletinAskHandler,
      questionLog,
    });
  }

  if (workerName === "execute" || workerName === "act") {
    return createCanUseTool({
      onAskUserQuestion: bulletinAskHandler,
      questionLog,
    });
  }

  return undefined;
}

// --- Worktree isolation ---

function createWorktree(cwd: string, workerName: string, jobId: string): string {
  const worktreePath = `/tmp/openagent-${workerName}-${jobId}`;
  try {
    execSyncChild(`git worktree add "${worktreePath}" HEAD`, { cwd, encoding: "utf-8" });
  } catch (err) {
    throw new Error(`Failed to create worktree for ${workerName}: ${err}`);
  }
  return worktreePath;
}

function cleanupWorktree(worktreePath: string, realCwd: string, workerName: string): void {
  if (!worktreePath.startsWith("/tmp/openagent-")) return;

  // Only plan preserves docs/plans/*.md — check preserves nothing
  if (workerName === "plan") {
    const planDir = path.join(worktreePath, "docs", "plans");
    const realPlanDir = path.join(realCwd, "docs", "plans");
    try {
      if (fs.existsSync(planDir)) {
        fs.mkdirSync(realPlanDir, { recursive: true });
        for (const file of fs.readdirSync(planDir)) {
          if (file.endsWith(".md")) {
            const src = path.join(planDir, file);
            const dest = path.join(realPlanDir, file);
            const srcStat = fs.statSync(src);
            try {
              const destStat = fs.statSync(dest);
              if (srcStat.mtimeMs > destStat.mtimeMs) {
                fs.copyFileSync(src, dest);
              }
            } catch {
              fs.copyFileSync(src, dest);
            }
          }
        }
      }
    } catch {}
  }

  // Remove worktree
  try {
    execSyncChild(`git worktree remove "${worktreePath}" --force`, { cwd: realCwd, encoding: "utf-8" });
  } catch {
    try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch {}
    try { execSyncChild(`git worktree prune`, { cwd: realCwd, encoding: "utf-8" }); } catch {}
  }
}

async function main() {
  // Handle classify worker (different args)
  if (worker === "classify") {
    const routingJson = args.routing ?? "{}";
    const result = await classifyQuestion(task, routingJson);
    console.log(JSON.stringify(result));
    process.exit(0);
  }

  // Handle resume worker (different args)
  if (worker === "resume") {
    const sessionId = args["session-id"];
    const answer = args.answer ?? args.task;
    if (!sessionId) {
      console.error("resume worker requires --session-id <id> and --answer <text>");
      process.exit(1);
    }

    const { resume } = await import("../src/index.ts");
    const parked = await import("../src/feedback.ts").then((mod) => mod.loadParkedSession(sessionId));
    const effectiveJobDir = jobDir ?? parked?.threadId;
    try {
      if (effectiveJobDir && parked?.interactionId) {
        await recordInteractionAnswer(effectiveJobDir, parked.interactionId, answer, {
          kind: "agent",
          id: "orchestrator",
        });
      }

      const result = await resume(sessionId, answer);
      if (effectiveJobDir && parked?.interactionId) {
        await completeInteractionResolution(effectiveJobDir, parked.interactionId);
      }
      if (effectiveJobDir) {
        writeResult(path.join(effectiveJobDir, "resume.json"), JSON.stringify(result, null, 2));
      }
      if (effectiveJobDir) {
        await finalizePlanRunState(
          effectiveJobDir,
          parked?.jobId ?? getJobId(effectiveJobDir, "plan"),
          result,
          "resume.json",
        );
      }
      console.log(JSON.stringify(result));
    } catch (err) {
      if (effectiveJobDir && parked?.interactionId && err instanceof Error) {
        await markResumeFailure(
          effectiveJobDir,
          parked.interactionId,
          err,
          false,
        );
      }

      const errorResult = {
        success: false,
        output: err instanceof Error ? err.message : String(err),
        filesChanged: [],
        questions: [],
        sessionId: "",
        stopReason: "error",
        costUsd: 0,
        usage: { inputTokens: 0, outputTokens: 0, durationMs: 0 },
      };
      console.log(JSON.stringify(errorResult));
      process.exit(1);
    }
    process.exit(0);
  }

  // Existing worker handling
  const fn = WORKERS[worker];
  if (!fn) {
    console.error(`Unknown worker: ${worker}. Must be plan, execute, check, act, classify, or resume.`);
    process.exit(1);
  }

  const { baseContext, effectiveContext: context } = buildWorkerContext(worker, jobDir, feedback);

  let effectiveCwd = cwd;
  let worktreePath: string | undefined;
  const jobId = getJobId(jobDir, worker);

  if (jobDir && worker === "plan") {
    await initializePlanRunState(jobDir, jobId, task, cwd);
  }

  // Plan and check run in worktrees for isolation
  if (worker === "plan" || worker === "check") {
    worktreePath = createWorktree(cwd, worker, jobId);
    effectiveCwd = worktreePath;
  }

  try {
    const canUseTool = buildCanUseTool(worker, { jobDir, jobId });
    const result = await fn({ task, cwd: effectiveCwd, context, canUseTool });

    if (jobDir) {
      writeResult(
        path.join(jobDir, `${worker}.json`),
        serializeWorkerResult(worker, task, baseContext, feedback, result),
      );
    }

    if (jobDir && worker === "plan") {
      await finalizePlanRunState(jobDir, jobId, result);
    }

    if (jobDir && questionLog.length > 0) {
      fs.writeFileSync(
        path.join(jobDir, "questions.json"),
        JSON.stringify(questionLog, null, 2),
      );
    }

    console.log(JSON.stringify(result));
  } catch (err) {
    if (err instanceof ParkSession) {
      const parkedResult = await buildParkedResult(err, worker, effectiveCwd, jobDir, jobId);

      if (jobDir) {
        writeResult(
          path.join(jobDir, `${worker}.json`),
          serializeWorkerResult(worker, task, baseContext, feedback, parkedResult),
        );
      }

      if (jobDir && worker === "plan") {
        await finalizePlanRunState(jobDir, jobId, parkedResult);
      }

      console.log(JSON.stringify(parkedResult));
      process.exit(0);
    }

    const errorResult = {
      success: false,
      output: err instanceof Error ? err.message : String(err),
      filesChanged: [],
      questions: [],
      sessionId: "",
      stopReason: "error",
      costUsd: 0,
      usage: { inputTokens: 0, outputTokens: 0, durationMs: 0 },
    };

    if (jobDir) {
      writeResult(
        path.join(jobDir, `${worker}.json`),
        serializeWorkerResult(worker, task, baseContext, feedback, errorResult),
      );
    }

    if (jobDir && worker === "plan") {
      await finalizePlanRunState(jobDir, jobId, errorResult);
    }

    console.log(JSON.stringify(errorResult));
    process.exit(1);
  } finally {
    if (worktreePath && worktreePath !== cwd) {
      cleanupWorktree(worktreePath, cwd, worker);
    }
  }
}

main();

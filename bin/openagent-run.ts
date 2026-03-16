import fs from "node:fs";
import path from "node:path";
import { execSync as execSyncChild } from "node:child_process";
import { execSync as execSyncBulletin } from "node:child_process";
import { plan, execute, check, act } from "../src/index.ts";
import { createCanUseTool } from "../src/can-use-tool.ts";
import type { TaskResult } from "../src/types.ts";
import {
  appendPlanEvent,
  createPlanEvent,
  initializePlanFeedbackJob,
  loadPlanState,
  savePlanState,
  type PlanState,
} from "../src/plan-feedback.ts";

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
const dryRun = process.argv.includes("--dry-run");

if (!worker || !task || !cwd) {
  console.error("Usage: openagent-run --worker <plan|execute|check|act|classify|resume> --task <task> --cwd <cwd> --job-dir <dir> [--dry-run]");
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
      lastPlannerResultPath: "plan.json",
    },
    updatedAt: new Date().toISOString(),
  };

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
        outputPath: "plan.json",
      }),
    );
  }
}

// --- Load context from previous phase if available ---

function loadContext(jobDir: string, worker: string): string | undefined {
  if (!jobDir) return undefined;

  // Context chaining: execute reads plan, check reads plan+execute, act reads check
  const chain: Record<string, string[]> = {
    execute: ["plan"],
    check: ["plan", "execute"],
    act: ["check"],
  };

  const phases = chain[worker];
  if (!phases) return undefined;

  const parts: string[] = [];
  for (const phase of phases) {
    const file = path.join(jobDir, `${phase}.json`);
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf-8"));
      parts.push(`--- ${phase} phase output ---\n${data.output}`);
    } catch {
      // phase file doesn't exist yet, skip
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : undefined;
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

function buildCanUseTool(workerName: string): ((toolName: string, input: Record<string, unknown>, options: any) => Promise<any>) | undefined {
  if (workerName === "plan") {
    return createCanUseTool({
      onAskUserQuestion: bulletinAskHandler,
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
    try {
      const result = await resume(sessionId, answer);
      if (jobDir) {
        writeResult(path.join(jobDir, "resume.json"), JSON.stringify(result, null, 2));
      }
      console.log(JSON.stringify(result));
    } catch (err) {
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

  const context = loadContext(jobDir, worker);

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
    const canUseTool = buildCanUseTool(worker);
    const result = await fn({ task, cwd: effectiveCwd, context, canUseTool });

    if (jobDir) {
      writeResult(path.join(jobDir, `${worker}.json`), JSON.stringify(result, null, 2));
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
      writeResult(path.join(jobDir, `${worker}.json`), JSON.stringify(errorResult, null, 2));
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

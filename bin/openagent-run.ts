import fs from "node:fs";
import path from "node:path";
import { plan, execute, check, act } from "../src/index.ts";
import type { TaskResult } from "../src/types.ts";

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

if (!worker || !task || !cwd) {
  console.error("Usage: openagent-run --worker <plan|execute|check|act|classify|resume> --task <task> --cwd <cwd> --job-dir <dir>");
  process.exit(1);
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

const WORKERS: Record<string, (a: { task: string; cwd: string; context?: string }) => Promise<TaskResult>> = {
  plan: (a) => plan({ task: a.task, cwd: a.cwd, context: a.context }),
  execute: (a) => execute({ plan: a.task, cwd: a.cwd, context: a.context, includeDiff: true }),
  check: (a) => check({ task: a.task, cwd: a.cwd, context: a.context }),
  act: (a) => act({ issues: a.task, cwd: a.cwd, context: a.context, includeDiff: true }),
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
        fs.mkdirSync(jobDir, { recursive: true });
        fs.writeFileSync(
          path.join(jobDir, "resume.json"),
          JSON.stringify(result, null, 2),
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

  try {
    const result = await fn({ task, cwd, context });

    if (jobDir) {
      fs.mkdirSync(jobDir, { recursive: true });
      fs.writeFileSync(
        path.join(jobDir, `${worker}.json`),
        JSON.stringify(result, null, 2),
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
      fs.mkdirSync(jobDir, { recursive: true });
      fs.writeFileSync(
        path.join(jobDir, `${worker}.json`),
        JSON.stringify(errorResult, null, 2),
      );
    }

    console.log(JSON.stringify(errorResult));
    process.exit(1);
  }
}

main();

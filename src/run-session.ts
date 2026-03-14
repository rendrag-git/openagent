import { buildSessionOptions, extractResult, computeCost, ParkSession } from "./session.ts";
import type {
  TaskResult,
  TaskContext,
  WorkerProfile,
  Question,
} from "./types.ts";

// Re-export for convenience
export { ParkSession } from "./session.ts";

// --- Config builder (testable without SDK) ---

interface RunInput {
  prompt: string;
  cwd: string;
  profile?: WorkerProfile;
  overrides?: Partial<WorkerProfile>;
  context?: string;
  tools?: string[];
  systemPrompt?: string | { type: string; preset: string; append?: string };
}

export function buildRunConfig(input: RunInput) {
  // If profile provided, use buildSessionOptions
  if (input.profile) {
    return buildSessionOptions({
      prompt: input.prompt,
      cwd: input.cwd,
      profile: input.profile,
      overrides: input.overrides,
      context: input.context,
    });
  }

  // Raw session — no profile, direct config
  const fullPrompt = input.context
    ? `Context:\n${input.context}\n\nTask:\n${input.prompt}`
    : input.prompt;

  return {
    prompt: fullPrompt,
    options: {
      cwd: input.cwd,
      ...(input.tools && { allowedTools: input.tools }),
      ...(input.systemPrompt && { systemPrompt: input.systemPrompt }),
    },
  };
}

// --- Run a session against the real SDK ---

interface RunSessionInput extends RunInput {
  onQuestion?: (question: Question) => Promise<string>;
  onProgress?: TaskContext["onProgress"];
  includeDiff?: boolean;
  resume?: string;
  resumeAnswer?: string;
  canUseTool?: TaskContext["canUseTool"];
}

export async function runSession(input: RunSessionInput): Promise<TaskResult> {
  // Dynamic import to avoid loading SDK at module level (testability)
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const config = buildRunConfig(input);
  const startTime = Date.now();
  let sessionId = "";
  let output = "";
  let stopReason: TaskResult["stopReason"] = "end_turn";
  const questions: Question[] = [];

  // Pass canUseTool callback to SDK if provided
  if (input.canUseTool) {
    (config.options as Record<string, unknown>).canUseTool = input.canUseTool;
  }

  // If resuming, add resume option
  if (input.resume) {
    (config.options as Record<string, unknown>).resume = input.resume;
    if (input.resumeAnswer) {
      config.prompt = input.resumeAnswer;
    }
  }

  try {
    for await (const message of query(config)) {
      // Capture session ID from init message
      if (message.type === "system" && (message as any).subtype === "init") {
        sessionId = (message as any).session_id ?? (message as any).data?.session_id ?? "";
      }

      // Capture result
      if ("result" in message) {
        output = (message as any).result ?? "";
        stopReason = ((message as any).stop_reason ?? "end_turn") as TaskResult["stopReason"];
      }

      // Progress callback
      if (input.onProgress) {
        input.onProgress({
          type: message.type === "result" ? "text" : "tool_use",
          content: JSON.stringify(message),
          timestamp: new Date().toISOString(),
        });
      }
    }
  } catch (err) {
    if (err instanceof ParkSession) throw err;
    output = err instanceof Error ? err.message : String(err);
    stopReason = "error";
  }

  // Compute git diff if requested
  let gitDiff: string | undefined;
  if (input.includeDiff) {
    try {
      const { execSync } = await import("node:child_process");
      gitDiff = execSync("git diff", { cwd: input.cwd, encoding: "utf-8" });
    } catch {
      // no git or no changes, leave undefined
    }
  }

  return {
    success: stopReason === "end_turn",
    output,
    filesChanged: [],  // TODO: parse from git status
    questions,
    sessionId,
    stopReason,
    costUsd: 0,        // TODO: extract from SDK usage events
    gitDiff,
    usage: {
      inputTokens: 0,  // TODO: extract from SDK usage events
      outputTokens: 0,
      durationMs: Date.now() - startTime,
    },
  };
}

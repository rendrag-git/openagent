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

interface QueryLike extends AsyncIterable<Record<string, unknown>> {
  interrupt(): Promise<void>;
}

interface RunSessionDeps {
  queryFactory?: (config: ReturnType<typeof buildRunConfig>) => Promise<QueryLike> | QueryLike;
}

async function loadQueryFactory(): Promise<RunSessionDeps["queryFactory"]> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  return (config) => query(config) as QueryLike;
}

export async function runSession(
  input: RunSessionInput,
  deps: RunSessionDeps = {},
): Promise<TaskResult> {
  const queryFactory = deps.queryFactory ?? await loadQueryFactory();

  const config = buildRunConfig(input);
  const startTime = Date.now();
  let sessionId = "";
  let output = "";
  let stopReason: TaskResult["stopReason"] = "end_turn";
  const questions: Question[] = [];
  let parkedError: ParkSession | null = null;
  let activeQuery: QueryLike | null = null;

  // Pass canUseTool callback to SDK if provided
  if (input.canUseTool) {
    (config.options as Record<string, unknown>).canUseTool = async (
      toolName: string,
      toolInput: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => {
      try {
        return await input.canUseTool!(toolName, toolInput, options);
      } catch (err) {
        if (err instanceof ParkSession) {
          parkedError = err;
          if (!activeQuery) {
            throw new Error("Cannot park session before query is initialized.");
          }
          await activeQuery.interrupt();
          return {
            behavior: "deny",
            message: "Session parked for external feedback.",
          };
        }
        throw err;
      }
    };
  }

  // If resuming, add resume option
  if (input.resume) {
    (config.options as Record<string, unknown>).resume = input.resume;
    if (input.resumeAnswer) {
      config.prompt = input.resumeAnswer;
    }
  }

  try {
    activeQuery = await queryFactory(config);

    for await (const message of activeQuery) {
      // Capture session ID from init message
      if (message.type === "system" && (message as any).subtype === "init") {
        sessionId = (message as any).session_id ?? (message as any).data?.session_id ?? "";
      }

      // Capture result
      if ("result" in message) {
        output = (message as any).result ?? "";
        const rawStopReason = (message as any).stop_reason ?? "end_turn";
        stopReason = rawStopReason === "end_turn" || rawStopReason === "max_turns" || rawStopReason === "error"
          ? rawStopReason
          : "error";
        sessionId ||= (message as any).session_id ?? "";
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

    if (parkedError) {
      if (!parkedError.sessionId && sessionId) {
        parkedError.sessionId = sessionId;
      }
      throw parkedError;
    }
  } catch (err) {
    if (err instanceof ParkSession) {
      if (!err.sessionId && sessionId) {
        err.sessionId = sessionId;
      }
      throw err;
    }
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

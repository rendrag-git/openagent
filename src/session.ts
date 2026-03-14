import type {
  TaskContext,
  TaskResult,
  Question,
  FileChange,
  WorkerProfile,
} from "./types.ts";

// --- ParkSession error (thrown to interrupt session) ---

export class ParkSession extends Error {
  question: Question;
  constructor(question: Question) {
    super(`Session parked: ${question.text}`);
    this.name = "ParkSession";
    this.question = question;
  }
}

// --- Build SDK options from profile + request ---

interface BuildInput {
  prompt: string;
  cwd: string;
  profile?: WorkerProfile;
  overrides?: Partial<WorkerProfile>;
  context?: string;
}

interface SDKQueryInput {
  prompt: string;
  options: {
    cwd: string;
    allowedTools?: string[];
    permissionMode?: string;
    systemPrompt?: string | { type: string; preset: string; append?: string };
    settingSources?: string[];
    maxTurns?: number;
    [key: string]: unknown;
  };
}

export function buildSessionOptions(input: BuildInput): SDKQueryInput {
  const profile = input.profile;
  const overrides = input.overrides;

  const allowedTools = overrides?.allowedTools ?? profile?.allowedTools;
  const permissionMode = overrides?.permissionMode ?? profile?.permissionMode;
  const maxTurns = overrides?.maxTurns ?? profile?.maxTurns;
  const settingSources = overrides?.settingSources ?? profile?.settingSources;
  const systemPromptAppend =
    overrides?.systemPromptAppend ?? profile?.systemPromptAppend;

  // Prepend context to prompt if provided
  const fullPrompt = input.context
    ? `Context:\n${input.context}\n\nTask:\n${input.prompt}`
    : input.prompt;

  return {
    prompt: fullPrompt,
    options: {
      cwd: input.cwd,
      ...(allowedTools && { allowedTools }),
      ...(permissionMode && { permissionMode }),
      ...(permissionMode === "bypassPermissions" && { allowDangerouslySkipPermissions: true }),
      ...(maxTurns && { maxTurns }),
      ...(settingSources && { settingSources }),
      ...(systemPromptAppend && {
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: systemPromptAppend,
        },
      }),
    },
  };
}

// --- Extract structured result from SDK messages ---

interface ExtractInput {
  messages: Array<{ type: string; result?: string; stop_reason?: string; [key: string]: unknown }>;
  sessionId: string;
  startTime: number;
}

export function extractResult(input: ExtractInput): TaskResult {
  const resultMsg = input.messages.find((m) => m.type === "result");
  const output = resultMsg?.result ?? "";
  const stopReason = (resultMsg?.stop_reason ?? "error") as TaskResult["stopReason"];

  return {
    success: stopReason === "end_turn",
    output,
    filesChanged: [],       // populated by runSession after git diff
    questions: [],           // populated if questions were asked
    sessionId: input.sessionId,
    stopReason,
    costUsd: 0,             // populated by runSession from usage data
    usage: {
      inputTokens: 0,       // populated from SDK usage events
      outputTokens: 0,
      durationMs: Date.now() - input.startTime,
    },
  };
}

// --- Model pricing for cost calculation ---

const MODEL_RATES: Record<string, { input: number; output: number }> = {
  "claude-opus-4-6": { input: 5.0 / 1_000_000, output: 25.0 / 1_000_000 },
  "claude-sonnet-4-6": { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
  "claude-haiku-4-5": { input: 1.0 / 1_000_000, output: 5.0 / 1_000_000 },
};

export function computeCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const rates = MODEL_RATES[model] ?? MODEL_RATES["claude-opus-4-6"];
  return inputTokens * rates.input + outputTokens * rates.output;
}

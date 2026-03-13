// --- Worker Profile ---

export interface WorkerProfile {
  allowedTools: string[];
  permissionMode: "default" | "plan" | "acceptEdits" | "bypassPermissions";
  systemPromptAppend: string;
  settingSources: string[];
  maxTurns: number;
}

// --- Questions & Progress ---

export interface Question {
  id: string;
  text: string;
  timestamp: string;
  answered: boolean;
  answer?: string;
}

export interface ProgressEvent {
  type: "text" | "tool_use" | "tool_result" | "question";
  content: string;
  timestamp: string;
}

// --- File Changes ---

export interface FileChange {
  path: string;
  action: "created" | "modified" | "deleted";
}

// --- Task Inputs ---

export interface TaskContext {
  cwd: string;
  context?: string;
  overrides?: Partial<WorkerProfile>;
  onQuestion?: (question: Question) => Promise<string>;
  onProgress?: (event: ProgressEvent) => void;
  includeDiff?: boolean;
}

export interface PlanRequest extends TaskContext {
  task: string;
}

export interface ExecuteRequest extends TaskContext {
  plan: string;
}

export interface CheckRequest extends TaskContext {
  task: string;
  plan?: string;
}

export interface ActRequest extends TaskContext {
  issues: string;
}

export interface SessionRequest extends TaskContext {
  prompt: string;
  profile?: WorkerProfile;
  tools?: string[];
  systemPrompt?: string | { type: "preset"; preset: string; append?: string };
  hooks?: Record<string, unknown[]>;
}

// --- Task Result ---

export interface TaskResult {
  success: boolean;
  output: string;
  filesChanged: FileChange[];
  questions: Question[];
  sessionId: string;
  stopReason: "end_turn" | "max_turns" | "error" | "parked";
  parkedQuestion?: Question;
  costUsd: number;
  gitDiff?: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
  };
}

// --- Parked Session (persisted to disk) ---

export interface ParkedSession {
  sessionId: string;
  question: Question;
  originalFrom: string;
  threadId: string;
  taskContext: TaskContext;
  createdAt: string;
}
